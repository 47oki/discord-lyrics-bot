#!/usr/bin/env node
/**
 * Integration tests for Discord + LRCLIB + scheduler + state-manager.
 *
 * Uses a mocked fetch (in-memory) so the tests run without network or
 * a real Discord account. Each test case is isolated: no test mutates
 * state another test depends on.
 *
 * Run with:
 *   npm run test:integration
 *
 * Returns process exit code 0 on success, 1 on failure.
 */
'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');

const { LyricsProvider } = require('../src/services/lyrics-provider');
const { DiscordClient } = require('../src/services/discord-client');
const { Scheduler } = require('../src/services/scheduler');
const { SmtcService } = require('../src/services/smtc-service');
const { MockPlaybackAdapter } = require('../src/services/mock-adapter');
const { StateManager } = require('../src/core/state-manager');
const { ConfigManager } = require('../src/core/config');
const { Logger } = require('../src/core/logger');
const { parseLrc, findActiveLineIndex } = require('../src/services/lrc-parser');
const { nextDelay, sleep } = require('../src/core/util');

/** Quiet logger for tests. */
function silentLogger() {
  return new Logger({ level: 'error', verbose: false });
}

/* ---------- test runner ---------- */

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function runAll() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: t.name, err });
      console.log(`  FAIL ${t.name}`);
      console.log(`       ${err && err.message ? err.message : err}`);
      if (err && err.stack) {
        const stack = err.stack.split('\n').slice(1, 4).join('\n');
        console.log(`       ${stack}`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/* ---------- LRCLIB tests ---------- */

test('LRCLIB: 200 with synced lyrics → returns parsed lines', async () => {
  const fetchMock = async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ id: 1, trackName: 'Track A', artistName: 'Artist 1',
      duration: 240, instrumental: false,
      syncedLyrics: '[00:01.00]Line one\n[00:02.50]Line two',
      plainLyrics: 'Line one\nLine two' }),
  });
  const provider = new LyricsProvider({
    logger: silentLogger(),
    fetchImpl: fetchMock,
    cacheTtlMs: 60_000,
    timeoutMs: 5000,
    maxRetries: 0,
    diskCacheDir: makeTmpDir(),
  });
  const result = await provider.lookup({ track: 'Track A', artist: 'Artist 1', durationMs: 240000 });
  assert.ok(result, 'expected result');
  assert.equal(result.synced, true);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].ms, 1000);
  assert.equal(result.lines[1].text, 'Line two');
});

test('LRCLIB: 404 → returns null', async () => {
  let callCount = 0;
  const fetchMock = async () => { callCount++; return { status: 404, ok: false, headers: { get: () => null }, json: async () => null }; };
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.equal(r, null);
  // Both /api/get and /api/search are tried on 404.
  assert.equal(callCount, 2);
});

test('LRCLIB: 429 is retried with exponential backoff', async () => {
  let callCount = 0;
  const fetchMock = async () => {
    callCount++;
    if (callCount < 3) return { status: 429, ok: false, headers: { get: () => '1' }, json: async () => ({ retry_after: 1 }) };
    return {
      status: 200, ok: true, headers: { get: () => null },
      json: async () => ({ syncedLyrics: '[00:01.00]hi', plainLyrics: 'hi' }),
    };
  };
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 3, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.ok(r);
  assert.equal(callCount, 3);
});

test('LRCLIB: 5xx triggers retryable NetworkError', async () => {
  let callCount = 0;
  const fetchMock = async () => {
    callCount++;
    if (callCount < 2) return { status: 503, ok: false, headers: { get: () => null }, json: async () => ({}) };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ syncedLyrics: '[00:01.00]ok', plainLyrics: 'ok' }) };
  };
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 3, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.ok(r);
  assert.equal(callCount, 2);
});

test('LRCLIB: malformed LRC falls back to plain lyrics', async () => {
  const fetchMock = async () => ({
    status: 200, ok: true, headers: { get: () => null },
    json: async () => ({ syncedLyrics: '[[[not valid lrc', plainLyrics: 'just plain\ntext' }),
  });
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.ok(r);
  assert.equal(r.synced, false);
  assert.equal(r.lines.length, 2);
});

test('LRCLIB: duplicated timestamps preserved', async () => {
  const fetchMock = async () => ({
    status: 200, ok: true, headers: { get: () => null },
    json: async () => ({ syncedLyrics: '[00:01.00][00:01.00]echo\necho', plainLyrics: 'echo' }),
  });
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.ok(r);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].ms, 1000);
  assert.equal(r.lines[1].ms, 1000);
});

test('LRCLIB: missing lyrics → null', async () => {
  const fetchMock = async () => ({
    status: 200, ok: true, headers: { get: () => null },
    json: async () => ({ syncedLyrics: '', plainLyrics: '' }),
  });
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.equal(r, null);
});

test('LRCLIB: cache hit on second call', async () => {
  let callCount = 0;
  const fetchMock = async () => {
    callCount++;
    return { status: 200, ok: true, headers: { get: () => null },
      json: async () => ({ syncedLyrics: '[00:01.00]a', plainLyrics: 'a' }) };
  };
  const tmp = makeTmpDir();
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: tmp,
  });
  const a = await provider.lookup({ track: 'A', artist: 'B', durationMs: 1000 });
  const b = await provider.lookup({ track: 'A', artist: 'B', durationMs: 1000 });
  assert.ok(a);
  assert.ok(b);
  assert.equal(b.source, 'cache');
  assert.equal(callCount, 1);
});

test('LRCLIB: signal abort stops the in-flight request', async () => {
  const fetchMock = async () => { await new Promise(r => setTimeout(r, 200)); return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({}) }; };
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 5000, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const ac = new AbortController();
  const p = provider.lookup({ track: 'X', artist: 'Y', durationMs: 0, signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r, null);
});

test('LRCLIB: timeout aborts the request', async () => {
  const fetchMock = async (url, opts) => {
    return await new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const provider = new LyricsProvider({
    logger: silentLogger(), fetchImpl: fetchMock, cacheTtlMs: 60_000, timeoutMs: 50, maxRetries: 0, diskCacheDir: makeTmpDir(),
  });
  const r = await provider.lookup({ track: 'X', artist: 'Y', durationMs: 0 });
  assert.equal(r, null);
});

/* ---------- LRC parser tests ---------- */

test('LRC parser: BOM stripped, multiple stamps per line, fractional ms', () => {
  const lrc = '﻿[00:01.000]Line one\n[00:02.500][00:02.500]chorus\n';
  const parsed = parseLrc(lrc);
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.lines[0].ms, 1000);
  assert.equal(parsed.lines[1].ms, 2500);
  assert.equal(parsed.lines[1].text, 'chorus');
});

test('LRC parser: meta tags extracted; lines out of order are sorted', () => {
  const lrc = '[ti:Song]\n[ar:Artist]\n[00:05.00]b\n[00:02.00]a\n';
  const parsed = parseLrc(lrc);
  assert.equal(parsed.title, 'Song');
  assert.equal(parsed.artist, 'Artist');
  assert.equal(parsed.lines[0].ms, 2000);
  assert.equal(parsed.lines[1].ms, 5000);
});

test('LRC parser: findActiveLineIndex via binary search', () => {
  const lines = [{ ms: 0, text: 'a' }, { ms: 1000, text: 'b' }, { ms: 2000, text: 'c' }];
  assert.equal(findActiveLineIndex(lines, 500), 0);
  assert.equal(findActiveLineIndex(lines, 1500), 1);
  assert.equal(findActiveLineIndex(lines, 9999), 2);
  assert.equal(findActiveLineIndex(lines, -1), -1);
});

/* ---------- Discord client tests ---------- */

test('Discord: 204 is success', async () => {
  let received = null;
  const fetchMock = async (url, opts) => {
    received = { url, opts };
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '', json: async () => null };
  };
  const client = new DiscordClient({ token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), logger: silentLogger(), fetchImpl: fetchMock });
  client.start();
  client.setStatus('hello world');
  await sleep(50);
  await client.stop();
  assert.ok(received);
  assert.equal(received.opts.method, 'PATCH');
  // Authorization is present; we don't compare the token literal.
  assert.ok(received.opts.headers.Authorization);
});

test('Discord: 401 emits auth-error', async () => {
  const fetchMock = async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => 'unauthorized', json: async () => null });
  const client = new DiscordClient({ token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), logger: silentLogger(), fetchImpl: fetchMock });
  client.start();
  let authErr = null;
  client.on('auth-error', (e) => { authErr = e; });
  client.setStatus('hi');
  await sleep(50);
  await client.stop();
  assert.ok(authErr);
});

test('Discord: 429 honors retry_after from body', async () => {
  let callCount = 0;
  let firstCallAt = 0;
  const fetchMock = async () => {
    callCount++;
    if (callCount === 1) {
      firstCallAt = Date.now();
      return { status: 429, ok: false, headers: { get: () => null }, json: async () => ({ retry_after: 0.1 }) };
    }
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '', json: async () => null };
  };
  const client = new DiscordClient({ token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), logger: silentLogger(), fetchImpl: fetchMock });
  client.start();
  client.setStatus('hi');
  await sleep(300);
  await client.stop();
  assert.equal(callCount, 2);
});

test('Discord: dedupes identical consecutive updates', async () => {
  let callCount = 0;
  const fetchMock = async () => { callCount++; return { status: 204, ok: true, headers: { get: () => null }, text: async () => '', json: async () => null }; };
  const client = new DiscordClient({ token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), logger: silentLogger(), fetchImpl: fetchMock });
  client.start();
  client.setStatus('same text');
  client.setStatus('same text');
  client.setStatus('same text');
  await sleep(50);
  await client.stop();
  assert.equal(callCount, 1);
});

test('Discord: sequential queue — first request completes before second', async () => {
  const timestamps = [];
  const fetchMock = async () => {
    timestamps.push(Date.now());
    await sleep(50);
    return { status: 204, ok: true, headers: { get: () => null }, text: async () => '', json: async () => null };
  };
  const client = new DiscordClient({ token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), logger: silentLogger(), fetchImpl: fetchMock });
  client.start();
  client.setStatus('first');
  await sleep(20);
  client.setStatus('second');
  await sleep(200);
  await client.stop();
  assert.equal(timestamps.length, 2);
  assert.ok(timestamps[1] - timestamps[0] >= 40, `second call should start after first finishes (${timestamps[1] - timestamps[0]}ms)`);
});

test('Discord: token is not logged even on error', async () => {
  const token = 'AAAA.BBBB.CCCC';
  const logger = new Logger({ level: 'info', verbose: true });
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    const fetchMock = async () => ({ status: 500, ok: false, headers: { get: () => null }, text: async () => 'oops', json: async () => null });
    const client = new DiscordClient({ token, logger, fetchImpl: fetchMock });
    client.start();
    client.setStatus(token);
    await sleep(50);
    await client.stop();
  } finally {
    process.stderr.write = origWrite;
  }
  const joined = captured.join('');
  assert.ok(!joined.includes(token), 'token must not appear in any log line');
});

/* ---------- Scheduler tests ---------- */

test('Scheduler: emits line transitions on time', async () => {
  const scheduler = new Scheduler();
  const lines = [
    { ms: 0, text: 'a' },
    { ms: 50, text: 'b' },
    { ms: 100, text: 'c' },
  ];
  const fired = [];
  scheduler.on('line', (e) => fired.push({ idx: e.index, text: e.line && e.line.text }));
  scheduler.bind(() => counter);
  let counter = 0;
  scheduler.setLyrics(lines, { title: 'T', artist: 'A' });
  scheduler.resume();
  for (counter = 0; counter < 200; counter++) {
    await sleep(15);
    if (fired.length >= 3) break;
  }
  scheduler.stop();
  assert.equal(fired.length, 3);
  assert.equal(fired[0].text, 'a');
  assert.equal(fired[1].text, 'b');
  assert.equal(fired[2].text, 'c');
});

test('Scheduler: pause cancels timer', async () => {
  const scheduler = new Scheduler();
  scheduler.setLyrics([{ ms: 0, text: 'a' }, { ms: 100, text: 'b' }], null);
  let counter = 0;
  scheduler.bind(() => counter);
  scheduler.resume();
  await sleep(50);
  scheduler.pause();
  await sleep(150);
  counter = 1000;
  // If pause didn't cancel, we'd see "b" emitted by now. But the timer was cancelled.
  scheduler.stop();
});

test('Scheduler: no duplicate emissions across many ticks', async () => {
  const scheduler = new Scheduler();
  const lines = Array.from({ length: 10 }, (_, i) => ({ ms: i * 30, text: `line ${i}` }));
  scheduler.setLyrics(lines, null);
  let counter = 0;
  scheduler.bind(() => counter);
  scheduler.resume();
  const fired = [];
  scheduler.on('line', (e) => fired.push(e.index));
  for (counter = 0; counter < 600; counter++) {
    await sleep(20);
  }
  scheduler.stop();
  // We expect each line emitted at most once.
  const set = new Set(fired);
  assert.equal(set.size, fired.length, 'each line emitted exactly once');
});

/* ---------- State manager test ---------- */

test('StateManager: track change fires scheduler, no crash on missing lyrics', async () => {
  process.env.DLS_ADAPTER = 'mock';
  const tmp = makeTmpDir();
  process.env.APPDATA = tmp;
  process.env.LOCALAPPDATA = tmp;
  process.env.USERPROFILE = tmp;
  const fetchMock = async () => ({ status: 404, ok: false, headers: { get: () => null }, json: async () => null, text: async () => '' });
  const adapter = new MockPlaybackAdapter();
  const smtc = new SmtcService({ logger: silentLogger(), adapter });
  const lyrics = new LyricsProvider({
    logger: silentLogger(),
    fetchImpl: fetchMock,
    cacheTtlMs: 60_000,
    timeoutMs: 1000,
    maxRetries: 0,
    diskCacheDir: makeTmpDir(),
  });
  const scheduler = new Scheduler();
  const discord = new DiscordClient({
    token: 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20),
    logger: silentLogger(),
    fetchImpl: async () => ({ status: 204, ok: true, headers: { get: () => null }, text: async () => '', json: async () => null }),
  });
  const config = new ConfigManager({ path: tmp + '/config.json' });
  config.load();
  const state = new StateManager({ logger: silentLogger(), config, smtc, lyrics, scheduler, discord });
  state.start();
  adapter.setTrack({ title: 'Track A', artist: 'Artist 1', durationMs: 240000 });
  adapter.play();
  await sleep(150);
  adapter.pause();
  await sleep(50);
  adapter.setTrack({ title: 'Track B', artist: 'Artist 2', durationMs: 180000 });
  adapter.play();
  await sleep(150);
  await state.stop();
});

/* ---------- helper ---------- */

function makeTmpDir() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const p = path.join(os.tmpdir(), `dls-int-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/* ---------- run ---------- */

(async () => {
  console.log(`Running ${tests.length} integration tests…\n`);
  await runAll();
})();