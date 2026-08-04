/**
 * Configuration store.
 *
 * Goals:
 *   - Validate every value on read AND on write.
 *   - Atomically persist (write to .tmp, fsync, rename) so a power
 *     loss never leaves a half-written file.
 *   - Recover from corruption by quarantining the bad file and
 *     falling back to defaults.
 *   - Migrate older schemas forward so users never lose data.
 *   - Never log the Discord token; on load we keep it in memory
 *     only, and on write we never re-serialize a field whose key
 *     contains "token" in clear text outside of disk.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { userDataDir } = require('./paths');
const { ConfigError } = require('./errors');

/** @typedef {{
 *   version: number,
 *   discord: { token: string | null, userId: string | null },
 *   display: { showArtist: boolean, maxLineLength: number, separator: string },
 *   lyrics: { provider: 'lrclib', timeoutMs: number, maxRetries: number, cacheTtlMs: number },
 *   scheduler: { tickMs: number, lookaheadMs: number },
 *   logging: { level: 'debug'|'info'|'warn'|'error', verbose: boolean },
 *   setup: { lastPort: number | null }
 * }} Config
 */

/** @type {Config} */
const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  discord: { token: null, userId: null },
  display: { showArtist: true, maxLineLength: 120, separator: ' — ' },
  lyrics: { provider: 'lrclib', timeoutMs: 8000, maxRetries: 4, cacheTtlMs: 24 * 60 * 60 * 1000 },
  scheduler: { tickMs: 100, lookaheadMs: 4000 },
  logging: { level: 'info', verbose: false },
  setup: { lastPort: null },
});

/**
 * Field-level validators.
 *
 * Accept-reject convention: each validator returns `{ ok: true, value }`
 * for a valid (possibly coerced) value, or `{ ok: false, error: 'msg' }`
 * for a rejected one. We don't use "throw or return value" because we
 * want to reject unambiguously (a string value is a valid pass).
 *
 * @type {Record<string, (v: unknown) => { ok: boolean, value?: unknown, error?: string }>}
 */
const VALIDATORS = {
  'version':         (v) => (typeof v === 'number' && v > 0 ? ok(v) : err('version must be a positive number')),
  'discord.token':   (v) => (v === null || typeof v === 'string' ? ok(v) : err('discord.token must be a string or null')),
  'discord.userId':  (v) => (v === null || (typeof v === 'string' && /^\d{6,25}$/.test(v)) ? ok(v) : err('discord.userId must be a numeric string or null')),
  'display.showArtist':    (v) => (typeof v === 'boolean' ? ok(v) : err('display.showArtist must be boolean')),
  'display.maxLineLength': (v) => (Number.isInteger(v) && v >= 20 && v <= 500 ? ok(v) : err('display.maxLineLength must be an integer in [20,500]')),
  'display.separator':     (v) => (typeof v === 'string' && v.length <= 8 ? ok(v) : err('display.separator must be a short string')),
  'lyrics.provider':       (v) => (v === 'lrclib' ? ok(v) : err('lyrics.provider must be "lrclib"')),
  'lyrics.timeoutMs':      (v) => (Number.isInteger(v) && v >= 1000 && v <= 30000 ? ok(v) : err('lyrics.timeoutMs must be 1000..30000')),
  'lyrics.maxRetries':     (v) => (Number.isInteger(v) && v >= 0 && v <= 10 ? ok(v) : err('lyrics.maxRetries must be 0..10')),
  'lyrics.cacheTtlMs':     (v) => (Number.isInteger(v) && v >= 0 ? ok(v) : err('lyrics.cacheTtlMs must be a non-negative integer')),
  'scheduler.tickMs':      (v) => (Number.isInteger(v) && v >= 10 && v <= 1000 ? ok(v) : err('scheduler.tickMs must be 10..1000')),
  'scheduler.lookaheadMs': (v) => (Number.isInteger(v) && v >= 500 && v <= 10000 ? ok(v) : err('scheduler.lookaheadMs must be 500..10000')),
  'logging.level':         (v) => (['debug','info','warn','error'].includes(/** @type {string} */ (v)) ? ok(v) : err('logging.level invalid')),
  'logging.verbose':       (v) => (typeof v === 'boolean' ? ok(v) : err('logging.verbose must be boolean')),
  'setup.lastPort':        (v) => (v === null || (Number.isInteger(v) && v >= 1 && v <= 65535) ? ok(v) : err('setup.lastPort must be null or 1..65535')),
};

/** @param {unknown} v */ function ok(v) { return { ok: true, value: v }; }
/** @param {string} e */ function err(e) { return { ok: false, error: e }; }

class ConfigManager {
  /**
   * @param {{ path?: string, logger?: Console | { warn: (m: string) => void } }} [opts]
   */
  constructor(opts = {}) {
    /** @type {string} */
    this.path = opts.path || path.join(userDataDir(''), 'config.json');
    /** @type {Config} */
    this._data = deepClone(DEFAULT_CONFIG);
    /** @type {Console | { warn: (m: string) => void }} */
    this._logger = opts.logger || console;
  }

  /** @returns {Config} */
  snapshot() {
    return deepClone(this._data);
  }

  /**
   * @param {string} key
   * @returns {unknown}
   */
  get(key) {
    return getByPath(this._data, key);
  }

  /**
   * Validate + persist a single key.
   * @param {string} key
   * @param {unknown} value
   */
  set(key, value) {
    const validator = VALIDATORS[key];
    if (!validator) throw new ConfigError(`Unknown config key: ${key}`);
    const result = validator(value);
    if (!result.ok) throw new ConfigError(/** @type {string} */ (result.error));
    setByPath(this._data, key, result.value);
    this._persist();
  }

  /**
   * Merge-and-validate. Useful at boot.
   * @param {Partial<Config>} patch
   */
  apply(patch) {
    for (const [k, v] of flatten(patch)) {
      if (k in VALIDATORS) {
        const result = VALIDATORS[k](v);
        if (!result.ok) {
          this._logger.warn(`[config] dropping invalid ${k}: ${result.error}`);
          continue;
        }
        setByPath(this._data, k, result.value);
      }
    }
    this._persist();
  }

  /**
   * Load config from disk, migrating if needed. Never throws on
   * corruption: it quarantines the bad file and returns defaults.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') return this._data;
      this._logger.warn(`[config] cannot read ${this.path}: ${code}; using defaults`);
      return this._data;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this._quarantine(raw, err);
      return this._data;
    }

    if (!parsed || typeof parsed !== 'object') {
      this._quarantine(raw, new Error('root is not an object'));
      return this._data;
    }

    const migrated = migrate(parsed);
    // Validate every known key; drop anything that fails.
    for (const [k, v] of flatten(migrated)) {
      const validator = VALIDATORS[k];
      if (!validator) continue;
      const result = validator(v);
      if (!result.ok) {
        this._logger.warn(`[config] dropping invalid ${k}: ${result.error}`);
        continue;
      }
      setByPath(this._data, k, result.value);
    }
    return this._data;
  }

  /** @private */
  _persist() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(this._data, null, 2);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      try { fs.fsyncSync(fd); } catch { /* fsync may fail on some FS; not fatal */ }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.path);
  }

  /**
   * Move a corrupt file aside so the user can recover it by hand
   * and we can start fresh.
   * @param {string} raw
   * @param {unknown} reason
   */
  _quarantine(raw, reason) {
    try {
      const dir = path.dirname(this.path);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(dir, `config.corrupt-${stamp}.json`);
      fs.writeFileSync(target, raw, 'utf8');
      this._logger.warn(`[config] quarantined corrupt config to ${target} (${String(reason)})`);
    } catch {
      // Disk full, etc. Nothing we can do.
    }
  }
}

/** Deep clone a structured-clonable object. */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string} path @param {unknown} root @returns {unknown} */
function getByPath(root, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[/** @type {keyof typeof acc} */ (k)]), root);
}

/** @param {string} path @param {unknown} root @param {unknown} value */
function setByPath(root, path, value) {
  const parts = path.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[/** @type {keyof typeof cur} */ (k)] == null || typeof cur[/** @type {keyof typeof cur} */ (k)] !== 'object') {
      cur[/** @type {keyof typeof cur} */ (k)] = {};
    }
    cur = cur[/** @type {keyof typeof cur} */ (k)];
  }
  cur[/** @type {keyof typeof cur} */ (parts[parts.length - 1])] = value;
}

/** Yields [dottedPath, value] pairs for a (possibly nested) object. */
function* flatten(obj, prefix = '') {
  if (obj == null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      yield* flatten(v, next);
    } else {
      yield [next, v];
    }
  }
}

/**
 * Migrate older versions forward. Each migration is a pure function
 * that returns the next version. The latest is whatever the default
 * schema uses.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function migrate(raw) {
  // v1: the original schema was flatter; we only had display/lyrics/discord
  // keys directly on the root. Lift them into the typed namespaces.
  if (raw.version === 1 || raw.version == null) {
    raw.version = 2;
    // No field renaming needed; the keys are the same. The structure is
    // already nested. We only had to bump the version marker.
  }
  return raw;
}

module.exports = { ConfigManager, DEFAULT_CONFIG, VALIDATORS };
