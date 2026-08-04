/**
 * Small generic utilities used across modules.
 *
 * `nextDelay` implements AWS-style full-jitter exponential backoff.
 * `sleep` is the obvious awaitable.
 * `withAbort` races a promise against an AbortSignal — used by the
 *   lyrics provider and the Discord client to cancel in-flight
 *   requests on user / track change.
 */
'use strict';

/**
 * @param {number} attempt Zero-based attempt index (0 = first retry).
 * @param {{ minMs?: number, maxMs?: number, factor?: number }} [opts]
 */
function nextDelay(attempt, opts = {}) {
  const minMs = opts.minMs ?? 250;
  const maxMs = opts.maxMs ?? 15_000;
  const factor = opts.factor ?? 2;
  const ceiling = Math.min(maxMs, minMs * factor ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

/**
 * @template T
 * @param {Promise<T>} p
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function withAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(makeAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(makeAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * @param {unknown} reason
 */
function makeAbortError(reason) {
  const e = new Error(String(reason ?? 'aborted'));
  e.name = 'AbortError';
  return e;
}

/**
 * Returns the only element of an array. Asserts the array has exactly
 * one element. Useful for defensive getter patterns.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function only(arr) {
  if (!arr || arr.length !== 1) {
    throw new Error(`expected exactly one element, got ${arr ? arr.length : 0}`);
  }
  return arr[0];
}

module.exports = { nextDelay, sleep, withAbort, makeAbortError, only };
