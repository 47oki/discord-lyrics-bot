/**
 * State manager.
 *
 * Single source of truth that owns the lifecycle of:
 *   - SMTC playback reader
 *   - Lyrics provider
 *   - Scheduler
 *   - Discord client
 *
 * No global mutable state. Components are constructed in `main.js`
 * and passed to the manager via dependency injection.
 *
 * Responsibilities:
 *   - Wire SMTC events → lyrics lookup → scheduler → Discord.
 *   - Coalesce duplicate track changes (e.g. mid-track metadata edits).
 *   - Cancel any in-flight lyrics lookup when the track changes again.
 *   - Pause / resume the scheduler on SMTC state changes.
 *   - Restart the Discord client if it ever emits `auth-error`.
 */
'use strict';

const { EventEmitter } = require('node:events');
// `AbortController` is a global in Node 18+ (no import needed).

class StateManager extends EventEmitter {
  /**
   * @param {{
   *   logger: import('../core/logger').Logger,
   *   config: import('../core/config').ConfigManager,
   *   smtc: import('../services/smtc-service').SmtcService,
   *   lyrics: LyricsProvider,
   *   scheduler: import('../services/scheduler').Scheduler,
   *   discord: import('../services/discord-client').DiscordClient,
   * }} deps
   */
  constructor(deps) {
    super();
    this.logger = deps.logger;
    this.config = deps.config;
    this.smtc = deps.smtc;
    this.lyrics = deps.lyrics;
    this.scheduler = deps.scheduler;
    /** @type {import('../services/discord-client').DiscordClient} */
    this.discord = deps.discord;
    /** @type {AbortController|null} */
    this._lyricsAbort = null;
    /** @type {{ title: string, artist: string }|null} */
    this._currentTrack = null;
    /** @type {number} */
    this._lastLineEmittedAt = 0;
    /** @type {boolean} */
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._wireListeners();
    this.smtc.start();
    this.discord.start();
    this.scheduler.resume();
  }

  /**
   * @private
   */
  _wireListeners() {
    // Position source for the scheduler. We project forward from the
    // last known SMTC position by the elapsed wall-clock time, so the
    // scheduler stays accurate without polling.
    this.scheduler.bind(() => this.smtc.projectedPositionMs());

    // Re-anchor the scheduler on every SMTC position update so the
    // very first lyric line is emitted as soon as the position is
    // known (e.g. when the user starts a track mid-song).
    this.smtc.on('position', () => this.scheduler.reanchor());

    this.scheduler.on('line', ({ line }) => {
      const text = this._renderLine(line);

      console.log("SCHEDULER LINE:", text);

      this.discord.setStatus(text);
    });

    this.smtc.on('statechange', ({ playing }) => {
      if (playing) this.scheduler.resume();
      else this.scheduler.pause();
      if (!playing) {
        // Show a paused indicator but keep the last lyric line.
        const t = this._currentTrack;
        this.discord.setStatus(renderFallback(t, this._display()));
      }
    });

    this.smtc.on('trackchange', (track) => {
      // _onTrackChange is async; we don't await here so multiple rapid
      // track-change events are serialized inside the function itself.
      void this._onTrackChange(track);
    });

    this.discord.on('auth-error', () => {
      void this._handleAuthError();
    });
  }

  /**
   * @private
   */
  async _handleAuthError() {
    this.logger.error('discord auth failed; re-running setup');
    try {
      const { runSetup } = require('../setup/setup-server');
      await runSetup({ logger: this.logger, config: this.config });
      const token = /** @type {string|null} */ (this.config.get('discord.token'));
      if (token) {
        // Rebuild Discord client with the new token.
        const { DiscordClient } = require('../services/discord-client');
        await this.discord.stop();
        this.discord = new DiscordClient({ token, logger: this.logger });
        this.discord.start();
      }
    } catch (err) {
      this.logger.error('setup re-run failed', { err: String(err) });
    }
  }

  async stop() {
    if (!this._running) return;
    this._running = false;
    this.scheduler.stop();
    this.smtc.removeAllListeners();
    this.discord.removeAllListeners();
    await this.smtc.stop();
    await this.discord.stop();
    if (this._lyricsAbort) this._lyricsAbort.abort('shutdown');
  }

  /**
   * @param {{ title: string, artist: string, album: string, durationMs: number }|null} track
   */
  async _onTrackChange(track) {
    if (!track || !track.title) {
      this._currentTrack = null;
      this.scheduler.setLyrics([], null);
      this.discord.setStatus('♪');
      return;
    }
    const sameArtistTitle =
      this._currentTrack &&
      this._currentTrack.artist === track.artist &&
      this._currentTrack.title === track.title;
    this._currentTrack = { title: track.title, artist: track.artist };

    if (!sameArtistTitle) {
      // Cancel any in-flight lyrics lookup; abort the previous request.
      if (this._lyricsAbort) this._lyricsAbort.abort('track changed');
      this._lyricsAbort = new AbortController();
      const signal = this._lyricsAbort.signal;
      let lyrics = null;
      try {
        lyrics = await this.lyrics.lookup({
          track: track.title,
          artist: track.artist,
          durationMs: track.durationMs || 0,
          signal,
        });
      } catch (err) {
        this.logger.warn('lyrics lookup error', { err: String(err) });
        lyrics = null;
      }
      if (signal.aborted) return;
      console.log("LYRICS:", lyrics);
      this.scheduler.setLyrics(lyrics ? lyrics.lines : [], this._currentTrack);
      // Only show the fallback if the scheduler didn't already emit a
      // lyric line for the current position (e.g. when the first
      // lyric is at a non-zero timestamp and the position is still
      // 0). When the scheduler does emit, the line handler pushes the
      // lyric directly to Discord and we want it to win.
      if (Date.now() - this._lastLineEmittedAt > 50) {
        this.discord.setStatus(renderFallback(this._currentTrack, this._display()));
      }
    }
  }

  /**
   * @param {{ ms: number, text: string }|null} line
   */
  _renderLine(line) {
    const display = this._display();
    if (!line) return renderFallback(this._currentTrack, display);
    if (!line.text) return renderFallback(this._currentTrack, display);
    return clamp(line.text, display.maxLength);
  }

  _display() {
    return {
      maxLength: /** @type {number} */ (this.config.get('display.maxLineLength')) || 120,
      separator: /** @type {string} */ (this.config.get('display.separator')) || ' — ',
      showArtist: /** @type {boolean} */ (this.config.get('display.showArtist')) !== false,
    };
  }
}

/**
 * @param {{ title: string, artist: string }|null} track
 * @param {{ maxLength: number, separator: string, showArtist: boolean }} display
 */
function renderFallback(track, display) {
  if (!track) return '♪';
  const parts = [];
  if (display.showArtist && track.artist) parts.push(track.artist);
  if (track.title) parts.push(track.title);
  const out = parts.join(display.separator).trim();
  return clamp(out || '♪', display.maxLength);
}

/**
 * @param {string} s
 * @param {number} max
 */
function clamp(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

module.exports = { StateManager, renderFallback };
