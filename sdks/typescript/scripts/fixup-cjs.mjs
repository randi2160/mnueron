/**
 * After `tsc` emits CommonJS into ./dist-cjs/, we want a single
 * `dist/index.cjs` file (matching the package.json exports map) plus
 * a `dist/index.cjs.d.ts` shim. We copy + rename + clean up.
 *
 * This avoids shipping two near-identical directories.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const cjsSrc = join(root, 'dist-cjs', 'index.js');
const cjsDst = join(root, 'dist', 'index.cjs');

if (!existsSync(cjsSrc)) {
  console.error(`fixup-cjs: ${cjsSrc} not found — did tsc run cleanly?`);
  process.exit(1);
}

mkdirSync(dirname(cjsDst), { recursive: true });
writeFileSync(cjsDst, readFileSync(cjsSrc));
rmSync(join(root, 'dist-cjs'), { recursive: true, force: true });
console.log('fixup-cjs: dist/index.cjs written');
