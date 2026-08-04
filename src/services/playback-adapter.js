/**
 * Playback adapter contract.
 *
 * The SMTC service is a pure state machine that knows how to coalesce
 * events. It does NOT know how to talk to Windows. The actual transport
 * (SMTC, the PowerShell bridge, a mock for tests) is plugged in as an
 * "adapter" implementing the contract below.
 *
 * Why a contract:
 *   - Lets us unit-test the scheduler + state manager without a real
 *     Spotify/SMTC stack.
 *   - Lets us swap transports without touching downstream code.
 *   - Lets us ship a working runtime on non-Windows dev machines.
 *
 * The adapter's job:
 *   - Emit `event` strings with `payload` objects of the right shape.
 *   - Implement `start()` and `stop()` that are idempotent.
 *   - Never throw from event emitters; convert errors to 'error' events.
 *
 * Event types emitted on the adapter:
 *   - 'attached'       — a session was attached
 *   - 'detached'       — no session (Spotify not running, etc.)
 *   - 'playbackStatus' { playing: boolean }
 *   - 'timeline'       { positionMs: number }
 *   - 'mediaProperties' { title, artist, album, durationMs }
 *   - 'error'          { error: Error }
 */
'use strict';

const { EventEmitter } = require('node:events');

class PlaybackAdapter extends EventEmitter {
  /** @returns {void} */
  start() { throw new Error('not implemented'); }
  /**
   * Default no-op. Subclasses may override to return a promise that
   * resolves when the underlying transport has fully torn down.
   * @returns {Promise<void>}
   */
  stop() { return Promise.resolve(); }
}

module.exports = { PlaybackAdapter };