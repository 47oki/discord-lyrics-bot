/**
 * Spotify playback reader.
 *
 * Wraps a `PlaybackAdapter` (see playback-adapter.js) and turns its
 * events into the higher-level semantic events the rest of the runtime
 * cares about: `trackchange`, `statechange`, `position`.
 *
 * Design goals:
 *   - Event-driven: zero polling inside this service. The adapter
 *     wakes us up.
 *   - Robust: if the adapter disappears or emits errors, we retry
 *     with exponential backoff and never propagate the error to the
 *     rest of the runtime.
 *   - Coalesce duplicates: SMTC can fire multiple change notifications
 *     for one logical update. We dedupe using small "last-emitted"
 *     caches.
 *   - Distinguish pause/resume/seek: each is its own event.
 *   - Survive adapter restarts: when the adapter comes back, we
 *     re-attach and re-seed our state.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { nextDelay } = require('../core/util');

/**
 * @typedef {Object} Track
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} durationMs
 */

class SmtcService extends EventEmitter {
  /**
   * @param {{
   *   logger: import('../core/logger').Logger,
   *   adapter: import('./playback-adapter').PlaybackAdapter,
   *   retryMinMs?: number,
   *   retryMaxMs?: number,
   * }} opts
   */
  constructor(opts) {
    super();
    this.setMaxListeners(20);
    /** @type {import('../core/logger').Logger} */
    this.logger = opts.logger;
    /** @type {import('./playback-adapter').PlaybackAdapter} */
    this.adapter = opts.adapter;
    this.retryMinMs = opts.retryMinMs ?? 1500;
    this.retryMaxMs = opts.retryMaxMs ?? 30_000;
    /** @type {Track|null} */
    this._track = null;
    /** @type {boolean} */
    this._playing = false;
    /** @type {number} */
    this._positionMs = 0;
    /** @type {number} */
    this._lastPositionAt = 0;
    /** @type {string} */
    this._revision = '';
    /** @type {boolean} */
    this._closed = false;
    /** @type {boolean} */
    this._adapterStarted = false;
    /** @type {number} */
    this._retryAttempt = 0;
    /** @type {NodeJS.Timeout|null} */
    this._retryHandle = null;
    this._bound = {
      attached: () => this._onAttached(),
      detached: () => this._onDetached(),
      playbackStatus: (p) => this._onPlaybackStatus(p),
      timeline: (p) => this._onTimeline(p),
      mediaProperties: (p) => this._onMediaProperties(p),
      error: (e) => this._onAdapterError(e),
    };
  }

  start() {
    if (this._closed) return;
    if (this._adapterStarted) return;
    this.adapter.on('attached', this._bound.attached);
    this.adapter.on('detached', this._bound.detached);
    this.adapter.on('playbackStatus', this._bound.playbackStatus);
    this.adapter.on('timeline', this._bound.timeline);
    this.adapter.on('mediaProperties', this._bound.mediaProperties);
    this.adapter.on('error', this._bound.error);
    try {
      this.adapter.start();
      this._adapterStarted = true;
      this._retryAttempt = 0;
    } catch (err) {
      this.logger.error('adapter start failed', { err: String(err) });
      this._scheduleRetry();
    }
  }

  async stop() {
    this._closed = true;
    if (this._retryHandle) {
      clearTimeout(this._retryHandle);
      this._retryHandle = null;
    }
    if (this._adapterStarted) {
      this.adapter.off('attached', this._bound.attached);
      this.adapter.off('detached', this._bound.detached);
      this.adapter.off('playbackStatus', this._bound.playbackStatus);
      this.adapter.off('timeline', this._bound.timeline);
      this.adapter.off('mediaProperties', this._bound.mediaProperties);
      this.adapter.off('error', this._bound.error);
      try { await this.adapter.stop(); } catch { /* ignore */ }
      this._adapterStarted = false;
    }
    this._emitIfChanged({ track: null, playing: false, positionMs: 0 });
  }

  current() {
    return {
      track: this._track,
      playing: this._playing,
      positionMs: this.projectedPositionMs(),
      lastUpdatedAt: Date.now(),
      revision: this._revision,
    };
  }

  /**
   * Returns the best estimate of the current playback position in
   * milliseconds. When the underlying transport has not pushed a new
   * position recently, we project forward from the last known value
   * by the elapsed wall-clock time (only while playing). This keeps
   * the scheduler accurate without polling.
   *
   * @returns {number}
   */
  projectedPositionMs() {
    if (this._lastPositionAt === 0) return this._positionMs;
    if (!this._playing) return this._positionMs;
    const elapsed = Date.now() - this._lastPositionAt;
    if (elapsed < 0) return this._positionMs;
    return this._positionMs + elapsed;
  }

  _onAttached() {
    this.logger.info('playback adapter attached');
    this._retryAttempt = 0;
  }

  _onDetached() {
    this.logger.info('playback adapter detached');
    this._emitIfChanged({ track: null, playing: false, positionMs: 0 });
  }

  _onPlaybackStatus(p) {
    const playing = !!(p && p.playing);
    this._emitIfChanged({ track: this._track, playing, positionMs: this._positionMs });
  }

  _onTimeline(p) {
    const pos = Number(p && p.positionMs);
    if (!Number.isFinite(pos)) return;
    this._positionMs = pos;
    this._lastPositionAt = Date.now();
    this.emit('position', { positionMs: pos, track: this._track, playing: this._playing });
  }

  _onMediaProperties(p) {
    const track = normalizeTrack(p);
    this._emitIfChanged({ track, playing: this._playing, positionMs: this._positionMs });
  }

  _onAdapterError(payload) {
    const err = payload && payload.error;
    this.logger.warn('adapter error', { err: String(err) });
    this._scheduleRetry();
  }

  /**
   * @param {{ track: Track|null, playing: boolean, positionMs: number }} next
   */
  _emitIfChanged({ track, playing, positionMs }) {
    const trackChanged = !sameTrack(this._track, track);
    const playingChanged = this._playing !== playing;
    const positionChanged = Math.abs(this._positionMs - positionMs) >= 250;

    this._track = track;
    this._playing = playing;
    if (positionChanged) this._positionMs = positionMs;
    this._revision = `${track?.title || ''}|${track?.artist || ''}|${playing}`;

    if (trackChanged) this.emit('trackchange', track);
    if (playingChanged) this.emit('statechange', { playing });
    if (trackChanged || playingChanged || positionChanged) {
      this.emit('position', { positionMs, track, playing });
    }
  }

  _scheduleRetry() {
    if (this._closed) return;
    if (this._retryHandle) return;
    const delay = nextDelay(this._retryAttempt, { minMs: this.retryMinMs, maxMs: this.retryMaxMs });
    this._retryAttempt++;
    this.logger.warn(`SMTC retrying in ${delay}ms (attempt ${this._retryAttempt})`);
    this._retryHandle = setTimeout(() => {
      this._retryHandle = null;
      if (this._closed) return;
      try {
        if (!this._adapterStarted) {
          this.adapter.on('attached', this._bound.attached);
          this.adapter.on('detached', this._bound.detached);
          this.adapter.on('playbackStatus', this._bound.playbackStatus);
          this.adapter.on('timeline', this._bound.timeline);
          this.adapter.on('mediaProperties', this._bound.mediaProperties);
          this.adapter.on('error', this._bound.error);
          this._adapterStarted = true;
        }
        this.adapter.start();
      } catch (err) {
        this.logger.warn('adapter restart failed', { err: String(err) });
        this._scheduleRetry();
      }
    }, delay);
  }
}

/**
 * @param {any} a
 * @param {any} b
 */
function sameTrack(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.title === b.title && a.artist === b.artist && a.durationMs === b.durationMs;
}

/**
 * @param {any} p
 * @returns {Track|null}
 */
function normalizeTrack(p) {
  if (!p) return null;
  const title = stringOr(p.title, p.Title);
  const artist = stringOr(p.artist, p.Artist);
  const album = stringOr(p.album, p.Album);
  const durationMs = numberOr(p.durationMs, p.Duration, 0);
  if (!title && !artist) return null;
  return { title: title || '', artist: artist || '', album: album || '', durationMs };
}

/** @param  {...any} vals */
function stringOr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return '';
}
/** @param  {...any} vals */
function numberOr(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 0;
}

module.exports = { SmtcService };