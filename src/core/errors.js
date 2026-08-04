/**
 * Discriminated error hierarchy.
 *
 * Every error thrown by the runtime is a subclass of `AppError`, so the
 * top-level handler can decide whether to retry, surface to the user,
 * or shut down. Raw `Error` instances are treated as bugs and crash the
 * process with diagnostics.
 */
'use strict';

class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, code?: string, retryable?: boolean }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = this.constructor.name;
    this.code = opts.code ?? 'E_APP';
    /** @type {boolean} */
    this.retryable = opts.retryable ?? false;
  }
}

class ConfigError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? 'E_CONFIG' });
  }
}

class NetworkError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? 'E_NETWORK', retryable: opts.retryable ?? true });
  }
}

class RateLimitError extends AppError {
  /**
   * @param {string} message
   * @param {{ retryAfterMs: number }} opts
   */
  constructor(message, { retryAfterMs }) {
    super(message, { code: 'E_RATE_LIMIT', retryable: true });
    /** @type {number} */
    this.retryAfterMs = retryAfterMs;
  }
}

class AuthError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'E_AUTH', retryable: false });
  }
}

class LyricsError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code ?? 'E_LYRICS', retryable: opts.retryable ?? true });
  }
}

class PlaybackError extends AppError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'E_PLAYBACK', retryable: true });
  }
}

module.exports = {
  AppError,
  ConfigError,
  NetworkError,
  RateLimitError,
  AuthError,
  LyricsError,
  PlaybackError,
};
