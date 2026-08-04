/**
 * Deterministic line scheduler.
 *
 * Given a parsed LRC and a position source (caller-supplied; we read
 * via the `getPositionMs` callback), advance the displayed line on
 * time, without polling every few milliseconds and without drift.
 *
 * Strategy:
 *   - One `setTimeout` per scheduled transition. When the timer
 *     fires, we read `getPositionMs()` to confirm the position (and
 *     handle seeks / pauses that happened in between), then emit
 *     exactly one `line` event.
 *   - After firing, we schedule the next transition based on the
 *     SAME wall-clock anchor. That keeps drift bounded to the OS
 *     timer granularity (~15ms on Windows) instead of growing over
 *     time.
 *   - `pause()` cancels the pending timer; `resume()` recomputes the
 *     next transition from the current position. `seek()` cancels and
 *     recomputes. `setLyrics()` cancels any pending transition and
 *     re-anchors against `positionMs`.
 *
 * No duplicate emissions: we track `lastEmittedIndex` and skip if the
 * timer fires late and the line is already the same.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { findActiveLineIndex } = require('./lrc-parser');

class Scheduler extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
    /** @type {import('./lrc-parser').LyricLine[]} */
    this.lines = [];
    /** @type {() => number|null} */
    this.getPositionMs = () => 0;
    /** @type {boolean} */
    this.playing = false;
    /** @type {number} */
    this._lastEmittedIndex = -1;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    /** @type {number} */
    this._scheduledFireAt = 0;
    /** @type {string} */
    this._anchor = '';
  }

  /**
   * Replace the lyric set. Cancels any pending timer, then re-anchors
   * the currently active line based on the current playback position.
   * @param {import('./lrc-parser').LyricLine[]} lines
   * @param {{ track: string, artist: string }|null} track
   */
  setLyrics(lines, track) {
    this._cancelTimer();
    this.lines = Array.isArray(lines) ? lines.slice().sort((a, b) => a.ms - b.ms) : [];
    this._anchor = `${track?.title || ''}|${track?.artist || ''}`;
    this._lastEmittedIndex = -1;
    this.emit('reset', { count: this.lines.length, track });
    // Re-anchor the current line based on the current position so the
    // caller can show it immediately, even if the first line is at a
    // non-zero timestamp (e.g. after an intro).
    this._emitCurrent();
    if (this.playing) this._scheduleNext(Date.now());
  }

  /**
   * Resume scheduling from the current playback position.
   * @param {() => number|null} getPositionMs
   */
  bind(getPositionMs) {
    this.getPositionMs = getPositionMs || (() => 0);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._cancelTimer();
  }

  resume() {
    if (this.playing) return;
    this.playing = true;
    this._emitCurrent();
    this._scheduleNext(Date.now());
  }

  /**
   * Indicate that the position jumped (seek or track restart). The
   * scheduler recomputes the current line from the new position.
   */
  seek(positionMs) {
    this._cancelTimer();
    const idx = findActiveLineIndex(this.lines, positionMs);
    this._lastEmittedIndex = idx;
    this.emit('line', { index: idx, line: idx >= 0 ? this.lines[idx] : null });
    if (this.playing) this._scheduleNext(Date.now());
  }

  /**
   * Re-evaluate the current line based on the current playback
   * position. Emits a `line` event if the active line changed since
   * the last emit. Safe to call on every position update from the
   * caller — it no-ops when the index hasn't changed.
   */
  reanchor() {
    this._emitCurrent();
    if (this.playing && !this._timer) this._scheduleNext(Date.now());
  }

  /**
   * Internal: schedule the next line transition.
   * @param {number} now High-resolution timestamp from `Date.now()` or `performance.now()`.
   */
  _scheduleNext(now) {
    if (!this.playing || this.lines.length === 0) return;
    const pos = this.getPositionMs();
    // Position not yet known — try again shortly.
    if (pos == null) {
      this._timer = setTimeout(() => this._onTimer(), 250);
      return;
    }
    const idx = findActiveLineIndex(this.lines, pos);
    const next = this.lines[idx + 1];

    const delay = next ? Math.max(0, next.ms - pos) : 500;
    this._scheduledFireAt = now + delay;
    // Guard: never schedule a zero-delay timer because setTimeout(fn, 0)
    // burns CPU in a tight loop. Treat it like the next event-loop tick.
    const safeDelay = delay === 0 ? 16 : delay;
    this._timer = setTimeout(() => this._onTimer(), safeDelay);
  }

  /**
   * Emit the current active line if it differs from the last emitted
   * one. Re-anchor logic — extracted so `setLyrics`, `resume`, and
   * `reanchor` all share the same behavior.
   * @private
   */
  _emitCurrent() {
    if (this.lines.length === 0) return;
    const pos = this.getPositionMs();
    if (pos == null) return;
    const idx = findActiveLineIndex(this.lines, pos);
    if (idx !== this._lastEmittedIndex) {
      this._lastEmittedIndex = idx;
      this.emit('line', { index: idx, line: idx >= 0 ? this.lines[idx] : null });
    }
  }

  /**
   * Timer fired. Verify position, re-anchor, and emit.
   */
  _onTimer() {
    this._timer = null;
    if (!this.playing) return;
    const now = Date.now();
    const pos = this.getPositionMs();
    if (pos == null) {
      // Position not available; try again in 250ms.
      this._timer = setTimeout(() => this._onTimer(), 250);
      return;
    }
    const idx = findActiveLineIndex(this.lines, pos);
    if (idx !== this._lastEmittedIndex) {
      this._lastEmittedIndex = idx;
      this.emit('line', { index: idx, line: idx >= 0 ? this.lines[idx] : null });
    }
    this._scheduleNext(now);
  }

  /** @private */
  _cancelTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Best-effort: stop everything.
   */
  stop() {
    this._cancelTimer();
    this.playing = false;
    this.lines = [];
    this._lastEmittedIndex = -1;
  }

  /**
   * Diagnostic: how far we are from the next scheduled transition.
   */
  diagnostic() {
    return {
      lines: this.lines.length,
      lastEmittedIndex: this._lastEmittedIndex,
      timerScheduledFor: this._scheduledFireAt,
    };
  }
}

module.exports = { Scheduler };
