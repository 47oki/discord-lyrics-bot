/**
 * PowerShell bridge adapter.
 *
 * Spawns a long-running PowerShell script that watches the Windows
 * SystemMediaTransportControls session associated with the current
 * media source (Spotify, etc.) and emits a stream of JSON events
 * on stdout, one per line:
 *
 *   { "type": "attached" }
 *   { "type": "playbackStatus", "playing": true }
 *   { "type": "timeline", "positionMs": 12345 }
 *   { "type": "mediaProperties", "title": "...", "artist": "...",
 *     "album": "...", "durationMs": 210000 }
 *   { "type": "detached" }
 *   { "type": "error", "message": "..." }
 *
 * The script lives in src/scripts/smtc-bridge.ps1 and is the only
 * place we touch PowerShell. We spawn it with `execFile` (no shell),
 * capture stdout, and re-emit each parsed JSON object as an EventEmitter
 * event.
 *
 * Why PowerShell and not a native Node addon?
 *   - No platform-specific compilation. Works on any Windows install
 *     with PowerShell 5 (default) or 7.
 *   - Windows.Media / SystemMediaTransportControls are well-exposed
 *     to PowerShell via WinRT.
 *   - We can upgrade the bridge script independently of the JS code.
 */
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findPowerShell } = require('../core/paths');

class PowerShellBridgeAdapter extends EventEmitter {
  /**
   * @param {{
   *   logger?: import('../core/logger').Logger,
   *   scriptPath?: string,
   *   pollIntervalMs?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.scriptPath = opts.scriptPath || path.join(__dirname, '..', 'scripts', 'smtc-bridge.ps1');
    this.pollIntervalMs = opts.pollIntervalMs || 750;
    this.logger = opts.logger || null;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.proc = null;
    /** @type {string} */
    this._buf = '';
    /** @type {boolean} */
    this._stopped = false;
  }

  start() {
  if (this.proc) return;

  const bridgePath =
  "C:\\Users\\aga-b\\Downloads\\claude\\test\\dsc lyrics\\src\\bridge\\SmtcBridge\\bin\\Release\\net8.0-windows10.0.26100.0\\win-x64\\smtc-bridge.dll";

  if (!fs.existsSync(bridgePath)) {
    this.emit('error', {
      error: new Error(`Bridge not found: ${bridgePath}`)
    });
    return;
  }

  try {
    this.proc = spawn(
      'dotnet',
      [
        bridgePath,
        '--poll-ms',
        String(this.pollIntervalMs),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      },
    );
  } catch (err) {
    this.emit('error', { error: err });
    return;
  }

  this.proc.stdout.setEncoding('utf8');
  this.proc.stderr.setEncoding('utf8');

  this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));

  this.proc.stderr.on('data', (chunk) => {
    if (this.logger) {
      this.logger.debug('bridge stderr', {
        chunk: chunk.toString().trim().slice(0, 200),
      });
    }
  });

  this.proc.on('exit', (code, signal) => this._onExit(code, signal));
  this.proc.on('error', (err) => this.emit('error', { error: err }));
}

  stop() {
    this._stopped = true;
    if (!this.proc) return Promise.resolve();
    try {
      if (process.platform === 'win32') {
        // Best-effort graceful stop; PowerShell doesn't trap SIGTERM
        // reliably, so we kill the process tree.
        spawn('taskkill', ['/pid', String(this.proc.pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true, shell: false });
      } else {
        this.proc.kill('SIGTERM');
      }
    } catch { /* ignore */ }
    this.proc = null;
    return Promise.resolve();
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      this._emitLine(line);
    }
  }

  /**
   * @param {string} line
   */
  _emitLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch {
      if (this.logger) this.logger.debug('bridge: bad json', { line: line.slice(0, 200) });
      return;
    }
    if (!obj || typeof obj !== 'object' || !obj.type) return;
    switch (obj.type) {
      case 'attached':       this.emit('attached'); break;
      case 'detached':       this.emit('detached'); break;
      case 'playbackStatus': this.emit('playbackStatus', { playing: !!obj.playing }); break;
      case 'timeline':       this.emit('timeline', { positionMs: Number(obj.positionMs) || 0 }); break;
      case 'mediaProperties':
        this.emit('mediaProperties', {
          title: obj.title || '',
          artist: obj.artist || '',
          album: obj.album || '',
          durationMs: Number(obj.durationMs) || 0,
        });
        break;
      case 'error':          this.emit('error', { error: new Error(obj.message || 'bridge error') }); break;
      default:
        if (this.logger) this.logger.debug('bridge: unknown event', { type: obj.type });
    }
  }

  _onExit(code, signal) {
    if (this._stopped) return;
    this.proc = null;
    this.emit('error', { error: new Error(`bridge exited (code=${code}, signal=${signal})`) });
  }
}

module.exports = { PowerShellBridgeAdapter };