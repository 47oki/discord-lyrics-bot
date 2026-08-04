/**
 * LRC parser.
 *
 * LRC files use a simple timestamped-line grammar:
 *
 *   [mm:ss.xx]text
 *   [mm:ss.xxx]text
 *
 * with optional album metadata lines like [ar:Artist] that we
 * ignore. This parser is deliberately permissive: malformed lines,
 * out-of-order timestamps, duplicate timestamps, multiple timestamps
 * per line, BOMs, CRLF, and BOM-prefixed files are all handled
 * without throwing.
 */
'use strict';

const TAG_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[(ar|ti|al|by|offset|length|re|ve):[^\]]*\]\s*$/i;

/**
 * @typedef {Object} LyricLine
 * @property {number} ms Start time in milliseconds.
 * @property {string} text
 */

/**
 * @typedef {Object} ParsedLrc
 * @property {LyricLine[]} lines Sorted ascending by `ms`.
 * @property {string|null} title
 * @property {string|null} artist
 */

class LrcParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LrcParseError';
  }
}

/**
 * @param {string} input
 * @returns {ParsedLrc}
 */
function parseLrc(input) {
  if (typeof input !== 'string') throw new LrcParseError('input must be a string');
  // Strip BOM if present.
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  /** @type {LyricLine[]} */
  const lines = [];
  /** @type {string|null} */
  let title = null;
  /** @type {string|null} */
  let artist = null;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (META_RE.test(line)) {
      const meta = /^\[(ar|ti|al|by|offset|length|re|ve):([^\]]*)\]\s*$/i.exec(line);
      if (meta) {
        const key = meta[1].toLowerCase();
        const val = meta[2].trim();
        if (key === 'ar') artist = val;
        else if (key === 'ti') title = val;
      }
      continue;
    }

    // Find every timestamp on the line. Lines like `[00:01.00][00:05.00]chorus`
    // produce two LyricLine entries with the same text.
    /** @type {number[]} */
    const stamps = [];
    let textStart = 0;
    let matched = false;
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(line)) !== null) {
      matched = true;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const fracStr = m[3] || '0';
      // Normalize fractional component to milliseconds.
      const frac = Number(fracStr.padEnd(3, '0').slice(0, 3));
      if (Number.isFinite(min) && Number.isFinite(sec) && Number.isFinite(frac)) {
        stamps.push(min * 60_000 + sec * 1000 + frac);
      }
      textStart = TAG_RE.lastIndex;
    }
    if (!matched || stamps.length === 0) continue;

    const text = line.slice(textStart).trim();
    // Skip lines with no printable content.
    if (!/[A-Za-z0-9一-鿿]/.test(text)) continue;
    for (const ms of stamps) {
      lines.push({ ms, text });
    }
  }

  // Sort ascending; stable.
  lines.sort((a, b) => a.ms - b.ms);

  return { lines, title, artist };
}

/**
 * Compute the index of the lyric line active at `positionMs` using
 * binary search. Returns -1 when no line has started yet.
 * @param {LyricLine[]} lines
 * @param {number} positionMs
 */
function findActiveLineIndex(lines, positionMs) {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (line.ms <= positionMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

module.exports = { parseLrc, findActiveLineIndex, LrcParseError };
