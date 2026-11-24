/**
 * esbuild driver for Discord Lyrics Status.
 *
 * Produces ESM and CommonJS bundles for the Windows application.
 */
import { build, context } from 'esbuild';
import { mkdirSync, existsSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1000;

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
  entryNames: 'main',
};

/** @type {import('esbuild').BuildOptions} */
const cjsOptions = {
  ...baseOptions,
  outfile: join(dist, 'main.cjs'),
  format: 'cjs',
};

async function run() {
  if (watch) {
    const ctxEsm = await context(esmOptions);
    const ctxCjs = await context(cjsOptions);
    await Promise.all([ctxEsm.watch(), ctxCjs.watch()]);
    console.log('[build] watching for changes…');
    return;
  }

  const startedAt = Date.now();
  console.log('[build] Starting build...');

  // Keep the build log alive with a clear heartbeat every 20 minutes.
  // This reports progress only; it does not extend the CI provider's timeout.
  const heartbeat = setInterval(() => {
    const elapsedMinutes = Math.floor((Date.now() - startedAt) / 60000);
    console.log(`[ALERT] Still building... (${elapsedMinutes} minutes elapsed)`);
  }, HEARTBEAT_INTERVAL_MS);

  try {
    await Promise.all([build(esmOptions), build(cjsOptions)]);

    const elapsedMs = Date.now() - startedAt;
    const esmSize = statSync(join(dist, 'main.mjs')).size;
    const cjsSize = statSync(join(dist, 'main.cjs')).size;
    console.log(`[build] Finished in ${elapsedMs}ms — ESM ${(esmSize / 1024).toFixed(1)} KiB, CJS ${(cjsSize / 1024).toFixed(1)} KiB`);

    copyFileSync(join(root, 'package.json'), join(dist, 'package.json'));
    try {
      const distPkg = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
      distPkg.type = 'commonjs';
      writeFileSync(join(dist, 'package.json'), JSON.stringify(distPkg, null, 2));
    } catch {
      // Best-effort metadata adjustment for the packaged CommonJS bundle.
    }
  } finally {
    clearInterval(heartbeat);
  }
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
