/**
 * Standalone-executable packager.
 *
 * Wraps the CJS bundle in a Windows .exe using Node's own SEA
 * (Single Executable Application) support, which is built into
 * Node 20+.
 *
 * Steps:
 *   1. Build the CJS bundle (handled by `npm run build`).
 *   2. Run `node --build-sea=<cfg.json>` to produce a single
 *      binary that contains both the Node runtime and our bundle.
 *   3. Copy the resulting binary into `release/`.
 *
 * On non-Windows hosts (or when SEA fails), fall back to a portable
 * `node.exe + main.cjs + .bat launcher` distribution in `release/`.
 */
import { existsSync, statSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
const release = join(root, 'release');

if (!existsSync(dist)) {
  console.error('[package] dist/ missing — run `npm run build` first');
  process.exit(1);
}
mkdirSync(release, { recursive: true });

const cjsBundle = join(dist, 'main.cjs');
if (!existsSync(cjsBundle)) {
  console.error('[package] dist/main.cjs missing — run `npm run build` first');
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log(`[package] node ${process.version} on ${process.platform}-${process.arch}`);

if (nodeMajor < 18) {
  console.error('[package] Node 18+ required for SEA');
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.warn('[package] not on Windows; producing portable launcher instead of .exe');
  // Cross-platform fallback: copy node binary alongside and write a launcher.
  emitPortableLauncher(cjsBundle, release);
  console.log('[package] portable launcher written to release/');
  process.exit(0);
}

// SEA path (Windows).
//
// Node 20+ ships its own SEA builder via `--build-sea`. It produces a
// complete binary containing both the Node runtime AND our CJS bundle.
// This is simpler and more reliable than postject — it does not need
// any fuse sentinel pre-installed in the host binary.
try {
  const cfgPath = join(dist, 'sea-config.json');
  writeFileSync(cfgPath, JSON.stringify({
    main: 'main.cjs',
    output: 'discord-lyrics-status.exe',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  }));

  // Build the SEA binary in place inside `dist/`, then copy it to `release/`.
  execFileSync(process.execPath, ['--build-sea', cfgPath], { cwd: dist, stdio: 'inherit' });
  const built = join(dist, 'discord-lyrics-status.exe');
  const exeDest = join(release, 'discord-lyrics-status.exe');
  copyFileSync(built, exeDest);
  try { writeFileSync(built, ''); } catch { /* keep dist clean if possible */ }
  console.log(`[package] wrote ${exeDest} (${(statSync(exeDest).size / 1024).toFixed(1)} KiB)`);
} catch (err) {
  console.warn('[package] SEA build failed, falling back to portable launcher', { err: String(err) });
  emitPortableLauncher(cjsBundle, release);
  console.log('[package] portable launcher written to release/');
}

function emitPortableLauncher(bundle, outDir) {
  copyFileSync(bundle, join(outDir, 'main.cjs'));
  // Friendly .bat launcher. We echo a one-liner on first run so users
  // know what they're looking at, then exec node against the bundle.
  const launcher = `@echo off
setlocal
set "HERE=%~dp0"
"%HERE%node.exe" "%HERE%main.cjs" %*
exit /b %ERRORLEVEL%
`;
  writeFileSync(join(outDir, 'discord-lyrics-status.bat'), launcher);
  // Convenience: a `.cmd` that does the same thing, for users who
  // prefer the modern extension.
  writeFileSync(join(outDir, 'discord-lyrics-status.cmd'), launcher);
  // Copy node binary next to it. We rename `node.exe` so it doesn't
  // collide with any other node on the user's PATH.
  try { copyFileSync(process.execPath, join(outDir, 'node.exe')); }
  catch { /* user must provide node.exe manually */ }
  // A tiny README so users know what each file is.
  const readme = `Discord Lyrics Status (portable)
=====================================

Files:
  discord-lyrics-status.bat    Windows launcher (double-click)
  discord-lyrics-status.cmd    Same as .bat (modern extension)
  main.cjs                     Application bundle
  node.exe                     Node.js runtime (v${process.versions.node})

Usage:
  discord-lyrics-status.bat                 Run the app
  discord-lyrics-status.bat --help          Show CLI flags
  discord-lyrics-status.bat --adapter mock  Run without SMTC

Note: this is a portable distribution. Move the entire folder
anywhere; nothing is installed system-wide.
`;
  writeFileSync(join(outDir, 'README.txt'), readme);
}