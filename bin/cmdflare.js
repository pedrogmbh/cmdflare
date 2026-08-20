#!/usr/bin/env node
// Thin launcher: runs the bundled CLI (dist/cli.js). Build it with `bun run build`.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'cli.js');
if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  // Development fallback: run the TypeScript source with Bun if available.
  const { spawnSync } = await import('node:child_process');
  const src = join(here, '..', 'src', 'cli.ts');
  const r = spawnSync('bun', [src, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write('cmdflare: dist/cli.js not found and `bun` is not available. Run `bun run build` first.\n');
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
