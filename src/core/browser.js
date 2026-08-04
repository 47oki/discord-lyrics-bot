/**
 * Cross-platform "open URL in default browser".
 *
 * We do NOT use `spawn('cmd', ['/c', 'start', ...])`. That depends on
 * PATH containing cmd and produces a visible console flash on some
 * Windows builds. Instead we:
 *   - On Windows, prefer `start "" "<url>"` via PowerShell (works on
 *     PowerShell 5 and 7). PowerShell is always present.
 *   - Fall back to `cmd /c start "" "<url>"` if PowerShell is missing,
 *     using `ComSpec` and resolving cmd from System32.
 *   - On macOS, use `open`. On Linux, use `xdg-open`.
 *
 * Returns true on success, false otherwise. Never throws.
 */
'use strict';

const { spawn } = require('node:child_process');
const { findCmd, findPowerShell } = require('../core/paths');

/**
 * @param {string} url
 * @returns {boolean}
 */
function openExternal(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    if (process.platform === 'win32') return openWindows(url);
    if (process.platform === 'darwin') return openMac(url);
    return openLinux(url);
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 */
function openWindows(url) {
  // Prefer PowerShell — it is present on every Windows 10/11 install.
  const ps = findPowerShell();
  if (ps) {
    const ok = runDetached(ps.path, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${escapeForPwsh(url)}'`,
    ]);
    if (ok) return true;
  }
  // Fallback: use cmd from ComSpec or System32, never PATH.
  const cmd = findCmd();
  if (cmd) {
    return runDetached(cmd, ['/c', 'start', '""', url]);
  }
  return false;
}

/**
 * @param {string} url
 */
function openMac(url) {
  return runDetached('open', [url]);
}

/**
 * @param {string} url
 */
function openLinux(url) {
  return runDetached('xdg-open', [url]);
}

/**
 * Spawn detached; capture & ignore output. Returns false on any
 * synchronous error.
 * @param {string} cmd
 * @param {string[]} args
 */
function runDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.on('error', () => { /* swallow */ });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * PowerShell single-quote escape: replace each ' with ''.
 * @param {string} s
 */
function escapeForPwsh(s) {
  return String(s).replace(/'/g, "''");
}

module.exports = { openExternal };
