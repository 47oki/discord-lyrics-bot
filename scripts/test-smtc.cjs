#!/usr/bin/env node
/**
 * SMTC validation harness.
 *
 * Usage:
 *   npm run test:smtc                # default: spawn real bridge on Windows
 *   npm run test:smtc -- --mock      # use the mock adapter (no PowerShell)
 *   npm run test:smtc -- --script    # replay a synthetic event stream
 *   npm run test:smtc -- --duration 30 --events attached,timeline,playbackStatus
 *
 * In real mode (Windows + PowerShell available), this script:
 *   - starts the PowerShell bridge
 *   - prints every JSON event the bridge emits, with timestamps
 *   - on Ctrl-C, summarizes events by type and exits
 *
 * In mock mode, it spawns a synthetic scenario that exercises every
 * code path the real SMTC pipeline is expected to handle: attached,
 * track change, pause, resume, seek, timeline tick, detached.
 */
'use strict';

const { EventEmitter } = require('node:events');
const { Logger } = require('../src/core/logger');
const { PowerShellBridgeAdapter } = require('../src/services/powershell-bridge-adapter');
const { MockPlaybackAdapter } = require('../src/services/mock-adapter');
const { SmtcService } = require('../src/services/smtc-service');

function parseArgs(argv) {
  const out = { mode: 'auto', durationSec: 30, allow: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') out.mode = 'mock';
    else if (a === '--script') out.mode = 'script';
    else if (a === '--bridge') out.mode = 'bridge';
    else if (a === '--duration') out.durationSec = Number(argv[++i]) || 30;
    else if (a === '--events') out.allow = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/test-smtc.cjs [--mock|--script|--bridge] [--duration N] [--events t1,t2]`);
      process.exit(0);
    }
  }
  return out;
}

class ScriptedAdapter extends EventEmitter {
  /**
   * Drives a synthetic scenario by emitting a fixed event sequence
   * at controlled intervals. The sequence exercises every state the
   * real SMTC pipeline can produce.
   * @param {string[]|null} allowFilter
   */
  constructor(allowFilter) {
    super();
    this.allow = allowFilter ? new Set(allowFilter) : null;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    /** @type {number} */
    this._t = 0;
  }
  start() {
    const tick = () => {
      this._t += 250;
      const t = this._t;
      if (t === 250) this._emit('attached');
      if (t === 500) this._emit('mediaProperties', { title: 'Track A', artist: 'Artist 1', album: 'Album 1', durationMs: 240000 });
      if (t === 750) this._emit('playbackStatus', { playing: true });
      if (t === 1000) this._emit('timeline', { positionMs: 1000 });
      if (t > 1000 && t < 12000 && t % 750 === 0) this._emit('timeline', { positionMs: t - 250 });
      if (t === 5000) this._emit('mediaProperties', { title: 'Track A (Remastered)', artist: 'Artist 1', album: 'Album 1', durationMs: 240000 });
      if (t === 7000) {
        this._emit('mediaProperties', { title: 'Track B', artist: 'Artist 2', album: 'Album 2', durationMs: 180000 });
        this._emit('timeline', { positionMs: 0 });
      }
      if (t === 9000) this._emit('playbackStatus', { playing: false });
      if (t === 10500) this._emit('playbackStatus', { playing: true });
      if (t === 12000) this._emit('timeline', { positionMs: 60000 });
      if (t === 14000) this._emit('detached');
      if (t === 16000) this._emit('attached');
      if (t === 16500) this._emit('mediaProperties', { title: 'Track C', artist: 'Artist 3', album: 'Album 3', durationMs: 200000 });
      if (t === 17000) this._emit('playbackStatus', { playing: true });
      if (t === 17250) this._emit('timeline', { positionMs: 0 });

      if (t >= 20000) {
        this._finish();
        return;
      }
      this._timer = setTimeout(tick, 250);
    };
    tick();
  }
  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    return Promise.resolve();
  }
  _emit(type, payload) {
    if (this.allow && !this.allow.has(type)) return;
    this.emit(type, payload || {});
  }
  _finish() {
    this._emit('detached');
    process.exit(0);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const logger = new Logger({ level: 'debug', verbose: true });

  let adapter;
  let mode = args.mode;
  if (mode === 'auto') {
    if (process.env.DLS_ADAPTER === 'mock') mode = 'mock';
    else if (process.platform === 'win32') mode = 'bridge';
    else mode = 'mock';
  }

  if (mode === 'mock') {
    console.log('[smtc-test] mode=mock (synthetic)');
    adapter = new ScriptedAdapter(args.allow);
  } else if (mode === 'script') {
    console.log('[smtc-test] mode=script (replay synthetic)');
    adapter = new ScriptedAdapter(args.allow);
  } else if (mode === 'bridge') {
    console.log('[smtc-test] mode=bridge (PowerShell)');
    adapter = new PowerShellBridgeAdapter({ logger });
  } else {
    console.error('[smtc-test] unknown mode:', mode);
    process.exit(1);
  }

  const smtc = new SmtcService({ logger, adapter });
  const start = Date.now();
  /** @type {Record<string, number>} */
  const counts = {};

  function stamp() {
    const dt = (Date.now() - start).toString().padStart(6, ' ');
    return `+${dt}ms`;
  }

  adapter.on('attached', () => {
    counts.attached = (counts.attached || 0) + 1;
    console.log(`${stamp()} [adapter] attached`);
  });
  adapter.on('detached', () => {
    counts.detached = (counts.detached || 0) + 1;
    console.log(`${stamp()} [adapter] detached`);
  });
  adapter.on('playbackStatus', (p) => {
    counts.playbackStatus = (counts.playbackStatus || 0) + 1;
    console.log(`${stamp()} [adapter] playbackStatus playing=${p.playing}`);
  });
  adapter.on('timeline', (p) => {
    counts.timeline = (counts.timeline || 0) + 1;
    if (counts.timeline % 4 === 1) {
      console.log(`${stamp()} [adapter] timeline positionMs=${p.positionMs}`);
    }
  });
  adapter.on('mediaProperties', (p) => {
    counts.mediaProperties = (counts.mediaProperties || 0) + 1;
    console.log(`${stamp()} [adapter] mediaProperties title="${p.title}" artist="${p.artist}" durationMs=${p.durationMs}`);
  });
  adapter.on('error', (e) => {
    counts.error = (counts.error || 0) + 1;
    console.log(`${stamp()} [adapter] error ${e.error && e.error.message}`);
  });

  smtc.on('trackchange', (t) => {
    counts.trackchange = (counts.trackchange || 0) + 1;
    console.log(`${stamp()} [smtc]      trackchange → ${t ? `"${t.artist} — ${t.title}"` : '<null>'}`);
  });
  smtc.on('statechange', (e) => {
    counts.statechange = (counts.statechange || 0) + 1;
    console.log(`${stamp()} [smtc]      statechange playing=${e.playing}`);
  });
  smtc.on('position', (e) => {
    counts.position = (counts.position || 0) + 1;
    if (counts.position % 4 === 1) {
      console.log(`${stamp()} [smtc]      position positionMs=${e.positionMs}`);
    }
  });

  smtc.start();
  adapter.start();

  setTimeout(() => {
    console.log('\n[smtc-test] duration reached, summary:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
    cleanup();
  }, args.durationSec * 1000).unref?.();

  process.on('SIGINT', () => cleanup());
  process.on('SIGTERM', () => cleanup());

  async function cleanup() {
    console.log('\n[smtc-test] stopping…');
    try { await smtc.stop(); } catch { /* ignore */ }
    try { await adapter.stop(); } catch { /* ignore */ }
    console.log('[smtc-test] final summary:');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[smtc-test] fatal', err);
  process.exit(1);
});
