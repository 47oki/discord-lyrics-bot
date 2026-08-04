/**
 * Removes build artifacts and cached state. Used by `npm run clean`.
 */
import { rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const targets = ['dist', 'release', join('logs', 'cache')];
for (const t of targets) {
  const abs = join(root, t);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
    console.log(`[clean] removed ${t}`);
  }
}
