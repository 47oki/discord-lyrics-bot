/**
 * Structured logger.
 *
 * - One-line JSON records (easy to grep, easy to ingest).
 * - Levels: debug, info, warn, error.
 * - Writes to %APPDATA%\DiscordLyricsStatus\logs\app-YYYY-MM-DD.log
 * - Rotates: when the active file exceeds `maxBytes` it is renamed
 *   to .1, .2, … up to `keep`.
 * - Always mirrors to stderr (in level-filtered form) so users can
 *   `discord-lyrics-status 2>log.txt` even from a broken install.
 * - Never logs the Discord token. We hash any value with the
 *   "token" key, both as field name and as a substring in the message,
 *   before it reaches the sink.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { userDataDir } = require('./paths');

const LEVEL_NUM = { debug: 10, info: 20, warn: 30, error: 40 };

/** @typedef {(...args: unknown[]) => void} LogFn */

/**
 * @typedef {Object} LoggerOptions
 * @property {keyof typeof LEVEL_NUM} [level]
 * @property {number} [maxBytes]
 * @property {number} [keep]
 * @property {boolean} [verbose]
 */

class Logger {
  /** @param {LoggerOptions} [opts] */
  constructor(opts = {}) {
    /** @type {keyof typeof LEVEL_NUM} */
    this.level = opts.level || (opts.verbose ? 'debug' : 'info');
    this.maxBytes = opts.maxBytes ?? 1_048_576; // 1 MiB per file
    this.keep = opts.keep ?? 5;
    /** @type {string|null} */
    this.file = null;
    /** @type {number} */
    this.bytes = 0;
    /** @type {import('stream').Writable|null} */
    this._stream = null;
    try {
      this.file = path.join(userDataDir('logs'), `app-${this._dateStamp()}.log`);
      this._stream = fs.createWriteStream(this.file, { flags: 'a' });
      this._stream.on('error', () => {
        // If the disk fills up or the file is locked we silently drop;
        // never let logging crash the app.
        this._stream = null;
      });
    } catch {
      this._stream = null;
    }
  }

  /** @returns {string} */
  _dateStamp() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * @param {keyof typeof LEVEL_NUM} level
   * @param {string} msg
   * @param {Record<string, unknown>} [fields]
   */
  log(level, msg, fields) {
    if (LEVEL_NUM[level] < LEVEL_NUM[this.level]) return;
    const safeFields = this._scrub(fields || {});
    const safeMsg = this._scrubString(msg);
    const record = {
      t: new Date().toISOString(),
      level,
      msg: safeMsg,
      ...safeFields,
    };
    const line = JSON.stringify(record) + '\n';
    this._writeLine(level, line);
  }

  /**
   * Redacts known sensitive fields and any string content that looks
   * like a Discord token.
   * @param {Record<string, unknown>} fields
   * @returns {Record<string, unknown>}
   */
  _scrub(fields) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      const lower = k.toLowerCase();
      if (lower.includes('token') || lower.includes('authorization') || lower === 'authorizationheader') {
        out[k] = '[redacted]';
        continue;
      }
      if (typeof v === 'string') {
        out[k] = this._scrubString(v);
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = this._scrub(/** @type {Record<string, unknown>} */ (v));
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /**
   * @param {string} s
   * @returns {string}
   */
  _scrubString(s) {
    // Discord tokens come in three flavors but all are long base64-ish blobs
    // bounded by dots. Be permissive: any sequence of 24+ alnum/dash/underscore/dot
    // we replace with [redacted].
    return s.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]');
  }

  /**
   * @param {keyof typeof LEVEL_NUM} level
   * @param {string} line
   */
  _writeLine(level, line) {
    // Mirror to stderr at info+; debug goes to stderr only when verbose.
    if (LEVEL_NUM[level] >= LEVEL_NUM.info) {
      try { process.stderr.write(line); } catch { /* ignore */ }
    } else if (this.level === 'debug') {
      try { process.stderr.write(line); } catch { /* ignore */ }
    }
    if (this._stream) {
      const buf = Buffer.from(line, 'utf8');
      this._stream.write(buf);
      this.bytes += buf.length;
      if (this.bytes >= this.maxBytes) {
        this._rotate();
      }
    }
  }

  _rotate() {
    if (!this._stream || !this.file) return;
    try { this._stream.end(); } catch { /* ignore */ }
    const dir = path.dirname(this.file);
    const base = path.basename(this.file, '.log');
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = path.join(dir, `${base}.${i}.log`);
      const to = path.join(dir, `${base}.${i + 1}.log`);
      try { fs.renameSync(from, to); } catch { /* ignore */ }
    }
    try { fs.renameSync(this.file, path.join(dir, `${base}.1.log`)); } catch { /* ignore */ }
    this.bytes = 0;
    try {
      this._stream = fs.createWriteStream(this.file, { flags: 'a' });
      this._stream.on('error', () => { this._stream = null; });
    } catch {
      this._stream = null;
    }
  }

  /** @type {LogFn} */
  debug(msg, fields) { this.log('debug', msg, fields); }
  /** @type {LogFn} */
  info(msg, fields) { this.log('info', msg, fields); }
  /** @type {LogFn} */
  warn(msg, fields) { this.log('warn', msg, fields); }
  /** @type {LogFn} */
  error(msg, fields) { this.log('error', msg, fields); }

  /** Best-effort flush; used at shutdown. */
  close() {
    if (!this._stream) return Promise.resolve();
    return new Promise((resolveClose) => {
      this._stream.end(() => resolveClose());
    });
  }
}

module.exports = { Logger };
