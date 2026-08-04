/**
 * esbuild driver for Discord Lyrics Status.
 *
 * Produces a single, self-contained ESM bundle for the runtime,
 * plus a CommonJS bundle for the SEA executable.
 *
 * Why two outputs:
 *   - The ESM bundle is what we actually run in development and
 *     what `npm start` executes. It is the canonical source of truth.
 *   - The CJS bundle is the entry point of the single-executable
 *     build (`node --build-sea`). Node's SEA loader expects a CJS
 *     entry — it does not currently support ESM as the main script.
 *     Smaller binary, faster cold start.
 */
import { build, context } from 'esbuild';
import { mkdirSync, existsSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  platform: 'node',
  target: 'node18.17',
  legalComments: 'none',
  logLevel: 'info',
  treeShaking: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  keepNames: true,
};

/** @type {import('esbuild').BuildOptions} */
const esmOptions = {
  ...baseOptions,
  outfile: join(dist, 'main.mjs'),
  format: 'esm',
  // We import nothing that needs a .cjs shim, but keep "main" stable.
  entryNames: 'main',
};

/** @type {import('esbuild').BuildOptions} */
const cjsOptions = {
  ...baseOptions,
  outfile: join(dist, 'main.cjs'),
  format: 'cjs',
  platform: 'node',
};

async function run() {
  if (watch) {
    const ctxEsm = await context(esmOptions);
    const ctxCjs = await context(cjsOptions);
    await Promise.all([ctxEsm.watch(), ctxCjs.watch()]);
    console.log('[build] watching for changes…');
    return;
  }
  const start = Date.now();
  await Promise.all([build(esmOptions), build(cjsOptions)]);
  const ms = Date.now() - start;
  const esmSize = statSync(join(dist, 'main.mjs')).size;
  const cjsSize = statSync(join(dist, 'main.cjs')).size;
  console.log(`[build] ok in ${ms}ms — esm ${(esmSize / 1024).toFixed(1)} KiB, cjs ${(cjsSize / 1024).toFixed(1)} KiB`);
  // Mirror package.json for SEA / packaging metadata, and mark it as
  // CommonJS so node parses main.cjs correctly.
  copyFileSync(join(root, 'package.json'), join(dist, 'package.json'));
  try {
    const distPkg = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
    distPkg.type = 'commonjs';
    writeFileSync(join(dist, 'package.json'), JSON.stringify(distPkg, null, 2));
  } catch { /* best-effort */ }
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
