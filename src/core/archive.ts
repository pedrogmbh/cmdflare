/**
 * Minimal, dependency-free tar + gzip writer (ustar format).
 *
 * Only what an export needs: regular files and directories from a local directory tree, streamed
 * through node:zlib so a multi-gigabyte archive never lands in memory. Works identically on Node
 * and Bun — nothing here touches Bun-only APIs.
 */
import { createWriteStream, readdirSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const BLOCK = 512;
const ZEROS = Buffer.alloc(BLOCK);

interface Entry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  /** Absolute path on disk. */
  source?: string;
  size: number;
  mode: number;
  mtime: Date;
  directory: boolean;
}

function octal(value: number, length: number): string {
  // ustar numeric fields: zero-padded octal, NUL-terminated.
  const max = 8 ** (length - 1) - 1;
  return Math.min(Math.max(0, Math.floor(value)), max).toString(8).padStart(length - 1, '0') + '\0';
}

/** Splits a long path into ustar name (100) + prefix (155). Returns null when it cannot fit. */
function splitName(name: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) return { name: rest, prefix };
  }
  return null;
}

/** GNU tar's long-name marker: the real path follows as the body of a pseudo-entry. */
const LONG_LINK = '././@LongLink';

function header(opts: { name: string; prefix?: string; size: number; mode: number; mtime: Date; typeflag: string }): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(opts.name, 0, 100, 'utf8'); // write() stops on whole characters, so it never splits one
  buf.write(octal(opts.mode & 0o7777, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii'); // uid
  buf.write(octal(0, 8), 116, 8, 'ascii'); // gid
  buf.write(octal(opts.size, 12), 124, 12, 'ascii');
  buf.write(octal(Math.floor(opts.mtime.getTime() / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder: spaces
  buf.write(opts.typeflag, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (opts.prefix) buf.write(opts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

/**
 * Header blocks for one entry. Paths that fit ustar use the name/prefix fields; anything longer gets
 * a GNU @LongLink pseudo-entry first (understood by GNU tar and bsdtar alike).
 */
function* headerBlocks(entry: Entry): Generator<Buffer> {
  const typeflag = entry.directory ? '5' : '0';
  const size = entry.directory ? 0 : entry.size;
  const split = splitName(entry.name);
  if (split) {
    yield header({ name: split.name, prefix: split.prefix, size, mode: entry.mode, mtime: entry.mtime, typeflag });
    return;
  }
  const path = Buffer.from(entry.name + '\0', 'utf8');
  yield header({ name: LONG_LINK, size: path.length, mode: 0o644, mtime: new Date(0), typeflag: 'L' });
  yield path;
  const pad = padding(path.length);
  if (pad) yield Buffer.alloc(pad);
  yield header({ name: entry.name, size, mode: entry.mode, mtime: entry.mtime, typeflag });
}

function padding(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/** Depth-first listing of a directory, directories before their contents, stable (sorted) order. */
function collect(dir: string, prefix: string, out: Entry[]): void {
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const full = join(dir, name);
    const st = statSync(full);
    const archivePath = posix.join(prefix, name);
    if (st.isDirectory()) {
      out.push({ name: archivePath + '/', size: 0, mode: st.mode, mtime: st.mtime, directory: true });
      collect(full, archivePath, out);
    } else if (st.isFile()) {
      out.push({ name: archivePath, source: full, size: st.size, mode: st.mode, mtime: st.mtime, directory: false });
    }
    // symlinks/sockets/devices are skipped: an export directory never contains them
  }
}

async function* tarStream(entries: Entry[]): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    yield* headerBlocks(entry);
    if (entry.directory || entry.size === 0) continue;
    let written = 0;
    for await (const chunk of createReadStream(entry.source!)) {
      const buf = chunk as Buffer;
      written += buf.byteLength;
      yield buf;
    }
    if (written !== entry.size) {
      // The file changed while we were reading it; pad or truncate so the archive stays valid.
      if (written < entry.size) yield Buffer.alloc(entry.size - written);
      else throw new Error(`File grew while archiving: ${entry.name}`);
    }
    const pad = padding(entry.size);
    if (pad) yield Buffer.alloc(pad);
  }
  // End of archive: two zero blocks.
  yield ZEROS;
  yield ZEROS;
}

export interface TarGzResult {
  path: string;
  files: number;
  bytes: number;
}

/**
 * Writes `srcDir` to `outFile` as a gzipped tar. Entries are prefixed with the directory's own name,
 * so extracting creates a folder rather than spilling files into the current directory.
 */
export async function createTarGz(srcDir: string, outFile: string, opts: { level?: number } = {}): Promise<TarGzResult> {
  const root = basename(srcDir.replace(/[\\/]+$/, '')) || 'export';
  const entries: Entry[] = [];
  const st = statSync(srcDir);
  entries.push({ name: root + '/', size: 0, mode: st.mode, mtime: st.mtime, directory: true });
  collect(srcDir, root, entries);
  await pipeline(Readable.from(tarStream(entries)), createGzip({ level: opts.level ?? 6 }), createWriteStream(outFile));
  const files = entries.filter((e) => !e.directory);
  return { path: outFile, files: files.length, bytes: files.reduce((a, e) => a + e.size, 0) };
}
