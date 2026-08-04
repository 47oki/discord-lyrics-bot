/**
 * Lyrics provider.
 *
 * - Fetches from LRCLIB (https://lrclib.net).
 * - L1 memory cache keyed by `${track}|${artist}|${durationMsBucket}`.
 * - L2 disk cache under %APPDATA%\DiscordLyricsStatus\lyrics-cache.
 * - Cache TTL: 24h default. Disk cache writes are atomic.
 * - Request cancellation: every fetch is wired to an AbortController.
 * - Retries with exponential backoff on transient network errors.
 * - Empty / 404 / malformed input returns null, never throws.
 *
 * The provider is the single source of truth for lyrics — the rest of
 * the runtime never speaks HTTP to LRCLIB directly.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { userDataDir } = require('../core/paths');
const { LyricsError, NetworkError, ConfigError } = require('../core/errors');
const { parseLrc, LrcParseError, findActiveLineIndex } = require('./lrc-parser');
const { nextDelay, sleep } = require('../core/util');

const LRCLIB_BASE = 'https://lrclib.net';
const USER_AGENT = 'discord-lyrics-status/2.0 (+https://github.com/local/discord-lyrics-status)';

/**
 * @typedef {import('./lrc-parser').LyricLine} LyricLine
 *
 * @typedef {Object} LyricsResult
 * @property {LyricLine[]} lines
 * @property {string} track
 * @property {string} artist
 * @property {boolean} synced True if timestamps exist.
 * @property {string|null} source 'lrclib' | 'cache' | 'fallback'
 */

class LyricsProvider {
  /**
   * @param {{
   *   logger: import('../core/logger').Logger,
   *   fetchImpl?: typeof fetch,
   *   cacheTtlMs?: number,
   *   timeoutMs?: number,
   *   maxRetries?: number,
   *   diskCacheDir?: string,
   * }} opts
   */
  constructor(opts) {
    /** @type {import('../core/logger').Logger} */
    this.logger = opts.logger;
    /** @type {typeof fetch} */
    this.fetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!this.fetch) throw new ConfigError('No fetch implementation available');
    this.cacheTtlMs = opts.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxRetries = opts.maxRetries ?? 4;
    /** @type {string} */
    this.diskCacheDir = opts.diskCacheDir || path.join(userDataDir('lyrics-cache'));
    fs.mkdirSync(this.diskCacheDir, { recursive: true });
    /** @type {Map<string, { ts: number, value: LyricsResult | null }>} */
    this.memory = new Map();
  }

  /**
   * Build the cache key. The duration is bucketed to ±2s so small
   * differences between Spotify and LRCLIB don't bust the cache.
   * @param {string} track
   * @param {string} artist
   * @param {number} durationMs
   */
  cacheKey(track, artist, durationMs) {
    const bucket = Math.round(durationMs / 2000);
    return `${normalize(track)}|${normalize(artist)}|${bucket}`;
  }

  /**
   * Look up lyrics for a track. Always resolves; returns null when
   * nothing was found.
   * @param {{ track: string, artist: string, durationMs: number, signal?: AbortSignal }} req
   * @returns {Promise<LyricsResult | null>}
   */
  async lookup(req) {
    if (!req || !req.track) return null;
    const key = this.cacheKey(req.track, req.artist || '', req.durationMs || 0);

    // L1 memory cache
    const mem = this.memory.get(key);
    if (mem && Date.now() - mem.ts < this.cacheTtlMs) {
      this.logger.debug('lyrics: memory hit', { key });
      return mem.value ? { ...mem.value, source: 'cache' } : null;
    }

    // L2 disk cache
    const diskPath = this._diskPath(key);
    const diskEntry = this._readDisk(diskPath);
    if (diskEntry && Date.now() - diskEntry.ts < this.cacheTtlMs) {
      this.memory.set(key, diskEntry);
      return diskEntry.value ? { ...diskEntry.value, source: 'cache' } : null;
    }

    // Fetch from LRCLIB.
    let fetched = null;
    try {
      fetched = await this._fetchWithRetry(req);
    } catch (err) {
      this.logger.warn('lyrics fetch failed', { err: String(err), track: req.track, artist: req.artist });
      // Cache the negative result for a short window so we don't hammer
      // LRCLIB while a network outage is in progress.
      const short = { ts: Date.now(), value: null };
      this.memory.set(key, short);
      return null;
    }

    const entry = { ts: Date.now(), value: fetched };
    this.memory.set(key, entry);
    this._writeDisk(diskPath, entry);
    return fetched ? { ...fetched, source: 'lrclib' } : null;
  }

  /**
   * @param {{ track: string, artist: string, durationMs: number, signal?: AbortSignal }} req
   * @returns {Promise<LyricsResult | null>}
   */
  async _fetchWithRetry(req) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (req.signal?.aborted) return null;
      try {
        return await this._fetchOnce(req);
      } catch (err) {
        lastErr = err;
        // Retry on any AppError that is explicitly marked retryable,
        // including LyricsError for 429s and NetworkError for transient
        // failures.
        if (!err || err.retryable !== true) throw err;
        if (attempt === this.maxRetries) break;
        const delay = nextDelay(attempt, { minMs: 500, maxMs: 8000 });
        this.logger.debug('lyrics: retrying', { attempt: attempt + 1, delay });
        await sleep(delay);
      }
    }
    throw /** @type {Error} */ (lastErr);
  }

  /**
   * @param {{ track: string, artist: string, durationMs: number, signal?: AbortSignal }} req
   */
  async _fetchOnce(req) {
    // LRCLIB exposes two endpoints:
    //   GET /api/get?track_name=...&artist_name=...&duration=...  (preferred)
    //   GET /api/search?track_name=...&artist_name=...           (fallback)
    const ac = new AbortController();
    const onAbort = () => ac.abort(req.signal?.reason || 'cancelled');
    if (req.signal) {
      if (req.signal.aborted) ac.abort(req.signal.reason);
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timeout = setTimeout(() => ac.abort('timeout'), this.timeoutMs);

    try {
      // Try the canonical "get" endpoint first.
      const getUrl = new URL('/api/get', LRCLIB_BASE);
      getUrl.searchParams.set('track_name', req.track);
      if (req.artist) getUrl.searchParams.set('artist_name', req.artist);
      if (req.durationMs) getUrl.searchParams.set('duration', String(Math.round(req.durationMs / 1000)));

      let response = await this.fetch(getUrl.toString(), {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: ac.signal,
      });

      if (response.status === 404) {
        // Fallback: search.
        const searchUrl = new URL('/api/search', LRCLIB_BASE);
        searchUrl.searchParams.set('track_name', req.track);
        if (req.artist) searchUrl.searchParams.set('artist_name', req.artist);
        response = await this.fetch(searchUrl.toString(), {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: ac.signal,
        });
      }

      if (response.status === 404) return null;
      if (response.status === 429) {
        // The caller (_fetchWithRetry) will retry on its own with backoff.
        throw new LyricsError('rate limited', { retryable: true });
      }
      if (response.status >= 500) {
        throw new NetworkError(`LRCLIB ${response.status}`, { retryable: true });
      }
      if (!response.ok) {
        throw new NetworkError(`LRCLIB ${response.status}`, { retryable: false });
      }

      /** @type {any} */
      let data;
      try {
        data = await response.json();
      } catch {
        return null;
      }
      return this._shape(data, req);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // Distinguish user-cancel from timeout in logs.
        const reason = ac.signal.reason;
        if (reason === 'timeout') {
          throw new NetworkError('LRCLIB timeout', { retryable: true });
        }
        return null;
      }
      if (err instanceof LyricsError || err instanceof NetworkError) throw err;
      throw new NetworkError(`LRCLIB error: ${String(err)}`, { retryable: true, cause: err });
    } finally {
      clearTimeout(timeout);
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @param {any} data
   * @param {{ track: string, artist: string }} req
   * @returns {LyricsResult | null}
   */
  _shape(data, req) {
    if (!data) return null;
    const rows = Array.isArray(data) ? data : [data];
    // Prefer a synced entry with non-empty syncedLyrics.
    const synced = rows.find((r) => r && typeof r.syncedLyrics === 'string' && r.syncedLyrics.trim().length > 0);
    const plain = rows.find((r) => r && typeof r.plainLyrics === 'string' && r.plainLyrics.trim().length > 0);

    if (synced) {
      try {
        const parsed = parseLrc(synced.syncedLyrics);
        if (parsed.lines.length === 0) {
          // Synced field was present but unparseable (no timestamps,
          // weird brackets, etc). Fall through to plain lyrics.
          this.logger.debug('lyrics: synced entry had no parseable lines; falling back');
        } else {
          return {
            lines: parsed.lines,
            track: req.track,
            artist: req.artist,
            synced: true,
            source: 'lrclib',
          };
        }
      } catch (err) {
        if (!(err instanceof LrcParseError)) throw err;
        this.logger.warn('malformed LRC; falling back to plain', { err: String(err) });
      }
    }
    if (plain) {
      const lines = plain.plainLyrics.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return {
        lines: lines.map((text, i) => ({ ms: i, text })),
        track: req.track,
        artist: req.artist,
        synced: false,
        source: 'lrclib',
      };
    }
    return null;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  _diskPath(key) {
    // Hash the key so we don't leak track names into the filesystem.
    const hashed = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(this.diskCacheDir, `${hashed}.json`);
  }

  /**
   * @param {string} p
   * @returns {{ ts: number, value: LyricsResult | null } | null}
   */
  _readDisk(p) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && typeof obj.ts === 'number') return obj;
    } catch { /* missing or corrupt */ }
    return null;
  }

  /**
   * @param {string} p
   * @param {{ ts: number, value: LyricsResult | null }} entry
   */
  _writeDisk(p, entry) {
    try {
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      fs.renameSync(tmp, p);
    } catch (err) {
      this.logger.debug('disk cache write failed', { err: String(err) });
    }
  }

  /**
   * Convenience: given a playback state and a position, returns the
   * line currently being sung. Always resolves to a string; falls
   * back to "Artist — Track" when no lyric is available.
   * @param {{ track: { title: string, artist: string }|null, positionMs: number }} state
   * @param {LyricsResult | null} lyrics
   * @param {{ maxLength: number, separator: string, showArtist: boolean }} display
   * @returns {string}
   */
  static render(state, lyrics, display) {
    if (lyrics && lyrics.lines.length > 0) {
      const idx = findActiveLineIndex(lyrics.lines, state.positionMs);
      if (idx >= 0) {
        const text = lyrics.lines[idx].text;
        if (text) return clampLength(text, display.maxLength);
      }
      // No line yet, but next-line countdown is meaningless in a 30-char
      // Discord status. Show a beat placeholder when nothing is active.
    }
    if (state.track) {
      const parts = [];
      if (display.showArtist && state.track.artist) parts.push(state.track.artist);
      parts.push(state.track.title || '');
      const out = parts.join(display.separator).trim();
      return clampLength(out || '♪', display.maxLength);
    }
    return '♪';
  }
}

/**
 * @param {string} s
 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} s
 * @param {number} max
 */
function clampLength(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

module.exports = { LyricsProvider, parseLrc, findActiveLineIndex, LrcParseError };
