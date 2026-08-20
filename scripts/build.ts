/** Bundles the CLI for Node (dist/cli.js) and copies the generated manifest next to it. */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src/cli.ts')],
  outdir: DIST,
  target: 'node',
  format: 'esm',
  packages: 'external',
  minify: false,
  sourcemap: 'none',
  banner: '#!/usr/bin/env node',
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}
mkdirSync(join(DIST, 'generated'), { recursive: true });
cpSync(join(ROOT, 'src/generated/index.json'), join(DIST, 'generated/index.json'));
cpSync(join(ROOT, 'src/generated/resources'), join(DIST, 'generated/resources'), { recursive: true });
console.log('Built dist/cli.js + dist/generated');
