/** Converts CLI flag strings into typed SDK parameter values. */
import { createReadStream, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import YAML from 'yaml';
import { parseBool } from './argv';
import { UsageError } from './errors';
import type { TypeSpec } from './manifest-types';

let stdinCache: string | undefined;
export async function prefetchStdin(): Promise<string> {
  if (stdinCache !== undefined) return stdinCache;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  stdinCache = Buffer.concat(chunks).toString('utf8');
  return stdinCache;
}
export function stdinText(): string {
  if (stdinCache === undefined) throw new UsageError('stdin was requested with "@-" but was not read; this is a bug.');
  return stdinCache;
}
/** True when any argv token refers to stdin via "@-". */
export function argvWantsStdin(argv: string[]): boolean {
  return argv.some((a) => a === '@-' || a.endsWith('=@-'));
}

export function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')) || (t.startsWith('"') && t.endsWith('"'));
}

/** Resolves "@file" / "@-" references to their text content; plain values are returned unchanged. */
export function resolveAt(raw: string, flag: string): string {
  if (raw === '@-') return stdinText();
  if (raw.startsWith('@') && raw.length > 1 && !raw.startsWith('@@')) {
    const file = raw.slice(1);
    try {
      return readFileSync(file, 'utf8');
    } catch (err: any) {
      throw new UsageError(`--${flag}: could not read file "${file}": ${err.message}`);
    }
  }
  if (raw.startsWith('@@')) return raw.slice(1); // escape for literal leading '@'
  return raw;
}

/** Parses JSON, falling back to YAML (which is a JSON superset and friendlier for files). */
export function parseStructured(text: string, flag: string): any {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch (jsonErr: any) {
    try {
      return YAML.parse(t);
    } catch {
      throw new UsageError(`--${flag}: invalid JSON: ${jsonErr.message}`, 'Pass a JSON object/array, or @file.json / @file.yaml / @- for stdin.');
    }
  }
}

export function parseDataArg(raw: string, flag = 'data'): any {
  const text = resolveAt(raw, flag);
  const v = parseStructured(text, flag);
  return v;
}

function fileValue(raw: string, flag: string): any {
  if (raw === '@-') {
    return new File([stdinText()], 'stdin');
  }
  const path = raw.startsWith('@') ? raw.slice(1) : raw;
  try {
    if (typeof Bun !== 'undefined') {
      const f = Bun.file(path);
      if (!f.size && !require('node:fs').existsSync(path)) throw new Error('no such file');
      return f;
    }
    return createReadStream(path);
  } catch (err: any) {
    throw new UsageError(`--${flag}: cannot open file "${path}": ${err.message}`, `Upload fields take a file path, e.g. --${flag} ./file.bin`);
  }
}

function coerceScalarLoose(s: string): any {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length < 16) return Number(s);
  return s;
}

function coerceEnum(s: string, spec: TypeSpec, flag: string): any {
  const values = spec.enum ?? [];
  if (values.some((v) => String(v) === s)) {
    const hit = values.find((v) => String(v) === s)!;
    return hit;
  }
  const ci = values.find((v) => String(v).toLowerCase() === s.toLowerCase());
  if (ci !== undefined) return ci;
  throw new UsageError(`--${flag}: invalid value "${s}".`, `Allowed values: ${values.map(String).join(', ')}`);
}

function coerceArray(raw: string | true, items: TypeSpec | undefined, flag: string): any[] {
  if (raw === true) throw new UsageError(`--${flag} requires a value`);
  const text = resolveAt(raw, flag);
  const t = text.trim();
  if (t.startsWith('[')) {
    const v = parseStructured(t, flag);
    if (!Array.isArray(v)) throw new UsageError(`--${flag}: expected a JSON array`);
    return v;
  }
  const itemKind = items?.kind ?? 'json';
  if (['string', 'number', 'boolean', 'enum'].includes(itemKind) || (itemKind === 'union' && items?.members?.every((m) => ['string', 'number', 'boolean', 'enum'].includes(m.kind)))) {
    return t
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => coerceValue(x, items, flag));
  }
  if (t.startsWith('{')) return [parseStructured(t, flag)];
  throw new UsageError(`--${flag}: expected a JSON array of ${items?.text ?? 'objects'}`, `Example: --${flag} '[{"key":"value"}]' or --${flag} @items.json`);
}

/**
 * Coerces a raw flag value (string, `true` for bare flags, or an array for repeated flags)
 * into the value expected by the SDK according to the manifest type spec.
 */
export function coerceValue(raw: string | true | Array<string | true>, spec: TypeSpec | undefined, flag: string): any {
  if (Array.isArray(raw)) {
    if (!spec || spec.kind === 'array' || spec.kind === 'json' || (spec.kind === 'union' && spec.members?.some((m) => m.kind === 'array'))) {
      const items = spec?.kind === 'array' ? spec.items : spec?.members?.find((m) => m.kind === 'array')?.items;
      return raw.flatMap((r) => coerceArray(r, items, flag));
    }
    // Non-array parameter given multiple times: last one wins.
    return coerceValue(raw[raw.length - 1]!, spec, flag);
  }
  const kind = spec?.kind ?? 'json';
  if (raw === true) {
    if (kind === 'boolean') return true;
    if (kind === 'json' || kind === 'union') return true;
    throw new UsageError(`--${flag} requires a value`);
  }
  switch (kind) {
    case 'boolean':
      return parseBool(raw, flag);
    case 'number': {
      const n = Number(raw);
      if (raw.trim() === '' || Number.isNaN(n)) throw new UsageError(`--${flag}: expected a number, got "${raw}"`);
      return n;
    }
    case 'string':
      return resolveAt(raw, flag);
    case 'enum':
      return coerceEnum(raw, spec!, flag);
    case 'array':
      return coerceArray(raw, spec!.items, flag);
    case 'file':
      return fileValue(raw, flag);
    case 'object':
    case 'record': {
      const text = resolveAt(raw, flag);
      if (looksLikeJson(text) || text.trim().startsWith('{')) {
        const v = parseStructured(text, flag);
        if (v && typeof v === 'object') return v;
      }
      throw new UsageError(
        `--${flag}: expected a JSON object, got "${raw.length > 40 ? raw.slice(0, 40) + '…' : raw}".`,
        `Use --${flag} '{"key":"value"}', --${flag} @file.json, or nested flags like --${flag}.key value`,
      );
    }
    case 'union':
    case 'json':
    default: {
      const text = resolveAt(raw, flag);
      if (looksLikeJson(text)) {
        try {
          return JSON.parse(text);
        } catch {
          /* fallthrough to scalar */
        }
      }
      if (spec?.kind === 'union') {
        const kinds = new Set(spec.members?.map((m) => m.kind));
        if (kinds.has('number') && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
        if (kinds.has('boolean') && (text === 'true' || text === 'false')) return text === 'true';
        const enumMember = spec.members?.find((m) => m.kind === 'enum');
        if (enumMember?.enum?.some((v) => String(v) === text)) return enumMember.enum.find((v) => String(v) === text);
        if (kinds.has('string') || kinds.has('enum')) return text;
        return coerceScalarLoose(text);
      }
      return coerceScalarLoose(text);
    }
  }
}

/** Sets a nested value by dotted path: `a.b[0].c` or `a.b.0.c`. Creates intermediate objects/arrays. */
export function setPath(obj: any, path: string, value: any): void {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p.length > 0);
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i]!;
    const last = i === parts.length - 1;
    const idx = /^\d+$/.test(key) ? Number(key) : undefined;
    if (last) {
      if (idx !== undefined && Array.isArray(cur)) cur[idx] = value;
      else cur[key] = value;
      return;
    }
    const nextIsIndex = /^\d+$/.test(parts[i + 1]!);
    const k: any = idx !== undefined && Array.isArray(cur) ? idx : key;
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
}

export function getPath(obj: any, path: string): any {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p.length > 0);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function fileDisplayName(v: any): string {
  if (v && typeof v === 'object' && 'name' in v && typeof v.name === 'string') return basename(v.name);
  if (v && typeof v === 'object' && 'path' in v) return String(v.path);
  return '<file>';
}
