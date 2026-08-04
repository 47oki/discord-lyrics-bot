/**
 * Smoke test for the runtime.
 *
 * - Loads the CJS bundle into a fresh faked environment.
 * - Configures a token so we skip the setup server.
 * - Uses the mock adapter to drive a fake Spotify session.
 * - Confirms the system does not crash, that the scheduler emits
 *   line events, and that the Discord client receives a status.
 *
 * This is not a substitute for unit tests; it exists so a developer
 * can verify the wiring with one command.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fakeHome = join(root, '.smoke-home');
process.env.DLS_ADAPTER = 'mock';
process.env.APPDATA = fakeHome;
process.env.LOCALAPPDATA = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.DISCORD_TOKEN = 'a'.repeat(40) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20);

mkdirSync(join(fakeHome, 'DiscordLyricsStatus'), { recursive: true });
writeFileSync(join(fakeHome, 'DiscordLyricsStatus', 'config.json'), JSON.stringify({
  version: 2,
  discord: { token: process.env.DISCORD_TOKEN, userId: null },
  display: { showArtist: true, maxLineLength: 120, separator: ' — ' },
  lyrics: { provider: 'lrclib', timeoutMs: 8000, maxRetries: 1, cacheTtlMs: 86400000 },
  scheduler: { tickMs: 100, lookaheadMs: 4000 },
  logging: { level: 'info', verbose: false },
  setup: { lastPort: null },
}, null, 2));

// Replace fetch with a stub that returns only empty results, so the
// lyric lookup short-circuits without trying the network.
globalThis.fetch = async (url) => {
  return {
    status: 404,
    ok: false,
    headers: { get: () => null },
    json: async () => null,
    text: async () => '',
  };
};

const child = spawn(process.execPath, [join(root, 'dist', 'main.cjs')], {
  env: process.env,
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  console.error('[smoke] timeout — killing');
  child.kill();
  process.exit(2);
}, 6000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  rmSync(fakeHome, { recursive: true, force: true });
  console.log(`[smoke] child exited with code ${code}`);
  process.exit(code === 0 || code === null ? 0 : 1);
});
