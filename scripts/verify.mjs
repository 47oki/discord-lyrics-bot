/**
 * Post-build verification. Runs without third-party deps so it
 * can be executed in CI or on a developer machine that hasn't run
 * `npm install` for the runtime packages yet.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');

const expected = [
  'main.mjs',
  'main.cjs',
  'package.json',
];

let ok = true;
for (const f of expected) {
  const p = join(dist, f);
  if (!existsSync(p)) {
    console.error(`[verify] missing ${f}`);
    ok = false;
    continue;
  }
  const size = statSync(p).size;
  console.log(`[verify] ok   ${f}  ${size} B`);
}

// Make sure main.js parses as JS by feeding it to node --check.
import { spawnSync } from 'node:child_process';
const check = spawnSync(process.execPath, ['--check', join(dist, 'main.cjs')], { encoding: 'utf8' });
if (check.status !== 0) {
  console.error('[verify] main.cjs failed --check:\n' + (check.stderr || check.stdout));
  ok = false;
} else {
  console.log('[verify] ok   syntax check on main.cjs');
}

// Spot-check that the build references the bridge adapter.
const mainSrc = readFileSync(join(dist, 'main.cjs'), 'utf8');
if (!mainSrc.includes('powershell-bridge-adapter') && !mainSrc.includes('smtc-bridge')) {
  console.warn('[verify] note: bridge adapter reference not found in main.cjs');
} else {
  console.log('[verify] ok   bridge adapter referenced');
}

if (!ok) {
  process.exit(1);
}
console.log('[verify] all checks passed');
