/**
 * Filesystem paths for the runtime.
 *
 * Everything user-mutable lives under %APPDATA%\DiscordLyricsStatus
 * so reinstalling Windows or moving the binary never loses config.
 *
 * No `path.join` with hard-coded "C:\\" prefixes — we resolve
 * AppData and LocalAppData at runtime. Missing env vars are
 * detected and a fallback under %USERPROFILE% is used so the
 * app keeps working in stripped-down environments.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const APP_DIR_NAME = 'DiscordLyricsStatus';

/**
 * Returns a writable per-user data directory, creating it if needed.
 * Falls back to %USERPROFILE% if both APPDATA and USERPROFILE are missing
 * (which would only happen in a broken CI environment, but we still
 * prefer a working app over a crash).
 *
 * @param {string} subdir
 * @returns {string}
 */
function userDataDir(subdir) {
  const base = process.env.APPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null)
    || path.join(os.homedir() || '.', '.config');
  const full = path.join(base, APP_DIR_NAME, subdir);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

/**
 * Returns %LOCALAPPDATA% with a fallback chain.
 * @returns {string}
 */
function localDataDir() {
  return process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null)
    || path.join(os.homedir() || '.', '.local', 'share');
}

/**
 * Resolves the path to cmd.exe or cmd.com on Windows.
 * Never assume PATH contains it; we look in System32 explicitly.
 * @returns {string|null}
 */
function findCmd() {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    process.env.ComSpec,
    path.join(windir, 'System32', 'cmd.exe'),
    path.join(windir, 'Sysnative', 'cmd.exe'),
    path.join(windir, 'System32', 'cmd.com'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const s = fs.statSync(c);
      if (s.isFile()) return c;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolves the path to PowerShell. We try PowerShell 7 (pwsh.exe) first
 * because it is the supported modern runtime, then fall back to
 * Windows PowerShell 5 (powershell.exe).
 * @returns {{ path: string, version: 5 | 7 } | null}
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    { p: path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), v: 7 },
    { p: path.join(programFiles86, 'PowerShell', '7', 'pwsh.exe'), v: 7 },
    { p: path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), v: 5 },
    { p: path.join(windir, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), v: 5 },
  ];
  for (const c of candidates) {
    try {
      const s = fs.statSync(c.p);
      if (s.isFile()) return { path: c.p, version: c.v };
    } catch {
      // try next
    }
  }
  return null;
}

module.exports = {
  APP_DIR_NAME,
  userDataDir,
  localDataDir,
  findCmd,
  findPowerShell,
};
