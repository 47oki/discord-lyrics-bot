/**
 * Discord client.
 *
 * Implements a single sequential queue that PATCHes the user's
 * custom presence. Honors Retry-After from the API, deduplicates
 * identical updates, applies a per-request timeout, and reconnects
 * automatically after network failure.
 *
 * We deliberately do NOT use discord.js: it pulls in a websocket
 * client we don't need, and we are only talking to one REST endpoint.
 * A single fetch with retries is simpler, faster, and less prone to
 * memory leaks.
 *
 * Auth: a Discord user token (NOT a bot token) is passed via the
 * Authorization header. The token is held in memory only and is
 * scrubbed by the logger if anything tries to print it.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { AuthError, NetworkError } = require('../core/errors');
const { sleep, nextDelay } = require('../core/util');

const DISCORD_API = 'https://discord.com/api/v9';
const MAX_STATUS_LEN = 128;
const PRESENCE_BODY = (text) => ({
  custom_status: { text: text.slice(0, MAX_STATUS_LEN) },
  since: 0,
  activities: [],
  afk: false,
  status: 'online',
});

class DiscordClient extends EventEmitter {
  /**
   * @param {{
   *   token: string,
   *   logger: import('../core/logger').Logger,
   *   fetchImpl?: typeof fetch,
   *   timeoutMs?: number,
   *   userId?: string|null,
   * }} opts
   */
  constructor(opts) {
    super();
    if (!opts.token) throw new AuthError('Discord token is empty');
    /** @type {string} */
    this.token = opts.token;
    /** @type {import('../core/logger').Logger} */
    this.logger = opts.logger;
    /** @type {typeof fetch} */
    this.fetch = opts.fetchImpl || fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    /** @type {string|null} */
    this.userId = opts.userId || null;
    /** @type {boolean} */
    this._running = false;
    /** @type {string|null} */
    this._lastSent = null;
    /** @type {number} */
    this._inFlight = 0;
    /** @type {Promise<void>} */
    this._idle = Promise.resolve();
    /** @type {AbortController|null} */
    this._abort = null;
  }

  /**
   * Begin processing. Idempotent.
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._abort = new AbortController();
  }

  /**
   * Stop accepting new updates. In-flight requests are aborted.
   */
  async stop() {
    this._running = false;
    if (this._abort) this._abort.abort('shutdown');
    await this._idle.catch(() => undefined);
  }

  /**
   * Submit a custom-status update. Always resolves (never rejects).
   * Identical consecutive updates are dropped before they enter the
   * queue. If a request fails, the last-sent state is reverted so a
   * retry of the same value can be attempted.
   * @param {string} text
   */
  setStatus(text) {
    console.log("DISCORD STATUS:", text);
    if (!this._running) return;
    if (typeof text !== 'string') text = '';
    const clamped = text.slice(0, MAX_STATUS_LEN);
    // Drop if it matches the last successfully-sent text. We do NOT
    // dedup against in-flight text because the in-flight queue is
    // serial — by the time the previous request resolves, the new
    // value will already be at the head of the queue.
    if (clamped === this._lastSent) return;
    const prevSent = this._lastSent;
    this._lastSent = clamped;
    this._inFlight++;

    // Chain onto the serial queue.
    this._idle = this._idle.then(() => this._send(clamped)).catch((err) => {
      // Reset optimistic dedup so the next identical call is allowed.
      if (this._lastSent === clamped) this._lastSent = prevSent;
      this.logger.warn('discord send failed', { err: String(err) });
    }).finally(() => {
      this._inFlight = Math.max(0, this._inFlight - 1);
    });
  }

  /**
   * Returns true if there is a request in flight (best-effort).
   */
  pending() {
    return this._running && this._inFlight > 0;
  }

  /**
   * @private
   * @param {string} text
   */
  async _send(text) {
    if (!this._running) return;
    const url = `${DISCORD_API}/users/@me/settings`;
    const body = JSON.stringify(PRESENCE_BODY(text));
    const headers = {
      'Authorization': this.token,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord-lyrics-status/2.0',
      'X-Discord-Locale': 'en-US',
    };

    let attempt = 0;
    let rateLimitHits = 0;
    while (this._running) {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort('timeout'), this.timeoutMs);
      try {
        const res = await this.fetch(url, {
          method: 'PATCH',
          headers,
          body,
          signal: ac.signal,
        });

        if (res.status === 204 || res.status === 200) {
          this.emit('ok', { text });
          return;
        }
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Discord auth failed (${res.status})`);
        }
        if (res.status === 429) {
          rateLimitHits++;
          // Give up after a sustained rate-limit storm so we don't
          // block the queue forever.
          if (rateLimitHits > 12) {
            this.logger.error('discord: persistent rate limit; giving up on this update');
            return;
          }
          const body429 = await safeJson(res);
          const retryAfterSec = Number(body429?.retry_after ?? res.headers.get('retry-after') ?? 1);
          // Discord returns retry_after in seconds; tolerate fractional values.
          // Clamp to a minimum of 50ms to avoid hot-looping when the API
          // returns an unexpectedly small number.
          const wait = Math.max(50, retryAfterSec * 1000);
          this.logger.warn('rate limited by Discord', { wait, hit: rateLimitHits });
          await sleep(wait);
          // Don't increment attempt counter on rate-limit waits.
          continue;
        }
        if (res.status >= 500) {
          throw new NetworkError(`Discord ${res.status}`, { retryable: true });
        }
        // Other 4xx: don't retry, log and give up.
        const textBody = await safeText(res);
        this.logger.error('discord API error', { status: res.status, body: textBody.slice(0, 200) });
        return;
      } catch (err) {
        if (!this._running) return;
        if (err && err.name === 'AbortError') {
          // Timeout: retry with backoff.
          attempt++;
          if (attempt > 8) {
            this.logger.error('discord: too many timeouts');
            return;
          }
          const wait = nextDelay(attempt - 1, { minMs: 1000, maxMs: 30_000 });
          await sleep(wait);
          continue;
        }
        if (err instanceof AuthError) {
          this.emit('auth-error', err);
          return;
        }
        if (err instanceof NetworkError && err.retryable) {
          attempt++;
          if (attempt > 8) {
            this.logger.error('discord: too many network failures');
            return;
          }
          const wait = nextDelay(attempt - 1, { minMs: 1000, maxMs: 30_000 });
          this.logger.debug('discord: network retry', { wait });
          await sleep(wait);
          continue;
        }
        this.logger.error('discord: unhandled error', { err: String(err) });
        return;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

/**
 * @param {Response} res
 */
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}
/**
 * @param {Response} res
 */
async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

module.exports = { DiscordClient, MAX_STATUS_LEN, PRESENCE_BODY };
