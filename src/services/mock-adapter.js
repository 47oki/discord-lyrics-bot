'use strict';

const { EventEmitter } = require('node:events');

/**
 * Mock adapter for tests and development on non-Windows machines.
 *
 * Lets you script playback events with `setTrack()`, `play()`,
 * `pause()`, `seek()`. Emits the same event surface as the real
 * adapters.
 */
class MockPlaybackAdapter extends EventEmitter {
  constructor() {
    super();
    /** @type {{ title: string, artist: string, album: string, durationMs: number }|null} */
    this._track = null;
    /** @type {boolean} */
    this._playing = false;
    /** @type {number} */
    this._positionMs = 0;
    /** @type {NodeJS.Timer|null} */
    this._tick = null;
  }

  start() {
    this.emit('attached');
  }

  stop() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
    this._track = null;
    this._playing = false;
    this._positionMs = 0;
    this.emit('detached');
    return Promise.resolve();
  }

  /**
   * @param {{ title: string, artist: string, album?: string, durationMs: number }} t
   */
  setTrack(t) {
    this._track = {
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      durationMs: t.durationMs,
    };
    this._positionMs = 0;
    this.emit('mediaProperties', this._track);
    this._restartTick();
  }

  play() {
    if (this._playing) return;
    this._playing = true;
    this.emit('playbackStatus', { playing: true });
    this._restartTick();
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    this.emit('playbackStatus', { playing: false });
    this._restartTick();
  }

  /** @param {number} ms */
  seek(ms) {
    this._positionMs = Math.max(0, ms);
    this.emit('timeline', { positionMs: this._positionMs });
  }

  _restartTick() {
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
    if (!this._playing) return;
    this._tick = setInterval(() => {
      this._positionMs += 250;
      this.emit('timeline', { positionMs: this._positionMs });
    }, 250);
  }
}

module.exports = { MockPlaybackAdapter };
