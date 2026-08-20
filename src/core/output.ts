/** Output formatting: json, table, yaml, csv/tsv, ndjson, raw, id — plus --query and --fields selection. */
import YAML from 'yaml';
import { getPath } from './coerce';
import { UsageError } from './errors';
import { c, stripAnsi, termWidth, useColor } from './ui';

export type OutputFormat = 'json' | 'table' | 'yaml' | 'csv' | 'tsv' | 'ndjson' | 'raw' | 'id' | 'auto';
export const OUTPUT_FORMATS: OutputFormat[] = ['json', 'table', 'yaml', 'csv', 'tsv', 'ndjson', 'raw', 'id'];

export interface OutputOptions {
  format: OutputFormat;
  query?: string;
  fields?: string[];
  compact?: boolean;
  /** Column order / selection for tables (defaults to --fields). */
  columns?: string[];
}

export function parseFormat(v: string | undefined, fallback: OutputFormat): OutputFormat {
  if (!v) return fallback;
  const f = v.toLowerCase() as OutputFormat;
  if (f === 'auto') return fallback;
  if (!OUTPUT_FORMATS.includes(f)) throw new UsageError(`Unknown output format "${v}".`, `Use one of: ${OUTPUT_FORMATS.join(', ')}`);
  return f;
}

// ---------------------------------------------------------------------------
// Query (JMESPath-lite): a.b, a[0], a[*].b, a[].b, [?key==value], [?key!=value]
// ---------------------------------------------------------------------------

type QTok = { t: 'key'; k: string } | { t: 'idx'; i: number } | { t: 'wild' } | { t: 'filter'; k: string; op: '==' | '!='; v: string };

function tokenizeQuery(q: string): QTok[] {
  const toks: QTok[] = [];
  let i = 0;
  const s = q.trim();
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '.') {
      i++;
      continue;
    }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) throw new UsageError(`--query: missing "]" in "${q}"`);
      const inner = s.slice(i + 1, end).trim();
      if (inner === '' || inner === '*') toks.push({ t: 'wild' });
      else if (/^-?\d+$/.test(inner)) toks.push({ t: 'idx', i: Number(inner) });
      else if (inner.startsWith('?')) {
        const m = inner.slice(1).match(/^\s*([\w.\-]+)\s*(==|!=)\s*(.+)$/);
        if (!m) throw new UsageError(`--query: unsupported filter "[${inner}]". Use [?key==value] or [?key!=value].`);
        toks.push({ t: 'filter', k: m[1]!, op: m[2] as '==' | '!=', v: m[3]!.trim().replace(/^['"]|['"]$/g, '') });
      } else throw new UsageError(`--query: unsupported bracket expression "[${inner}]"`);
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      if (end === -1) throw new UsageError(`--query: unterminated quote in "${q}"`);
      toks.push({ t: 'key', k: s.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    toks.push({ t: 'key', k: s.slice(i, j) });
    i = j;
  }
  return toks;
}

function applyToks(value: any, toks: QTok[]): any {
  let cur = value;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (cur === undefined || cur === null) return cur;
    if (tok.t === 'key') {
      cur = typeof cur === 'object' ? cur[tok.k] : undefined;
    } else if (tok.t === 'idx') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tok.i < 0 ? cur.length + tok.i : tok.i];
    } else if (tok.t === 'wild') {
      const arr = Array.isArray(cur) ? cur : typeof cur === 'object' ? Object.values(cur) : [];
      const rest = toks.slice(i + 1);
      const mapped = arr.map((el) => applyToks(el, rest)).filter((v) => v !== undefined && v !== null);
      // flatten one level when projecting into arrays
      return mapped.some(Array.isArray) && rest.length > 0 ? mapped.flat() : mapped;
    } else if (tok.t === 'filter') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.filter((el) => {
        const v = getPath(el, tok.k);
        const eq = String(v) === tok.v;
        return tok.op === '==' ? eq : !eq;
      });
    }
  }
  return cur;
}

export function applyQuery(data: any, query: string | undefined): any {
  if (!query || !query.trim()) return data;
  return applyToks(data, tokenizeQuery(query));
}

export function selectFields(data: any, fields: string[] | undefined): any {
  if (!fields || !fields.length) return data;
  const pick = (obj: any) => {
    if (obj === null || typeof obj !== 'object') return obj;
    const out: Record<string, any> = {};
    for (const f of fields) out[f] = getPath(obj, f);
    return out;
  };
  return Array.isArray(data) ? data.map(pick) : pick(data);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatOutput(data: any, opts: OutputOptions): string {
  switch (opts.format) {
    case 'json':
      return formatJson(data, opts.compact);
    case 'yaml':
      return YAML.stringify(data ?? null, { lineWidth: 0 }).trimEnd();
    case 'table':
      return formatTable(data, opts.columns ?? opts.fields);
    case 'csv':
      return formatDelimited(data, ',', opts.columns ?? opts.fields);
    case 'tsv':
      return formatDelimited(data, '\t', opts.columns ?? opts.fields);
    case 'ndjson':
      return (Array.isArray(data) ? data : [data]).map((x) => JSON.stringify(x)).join('\n');
    case 'id':
      return formatIds(data);
    case 'raw':
      return formatRaw(data);
    default:
      return formatJson(data, opts.compact);
  }
}

export function formatJson(data: any, compact?: boolean): string {
  const text = JSON.stringify(data === undefined ? null : data, null, compact ? 0 : 2);
  return useColor() && !compact ? colorizeJson(text) : text;
}

function colorizeJson(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (m, str, colon, bool) => {
      if (str !== undefined) return colon ? c.cyan(str) + colon : c.green(str);
      if (bool !== undefined) return c.magenta(m);
      if (m === 'null') return c.gray(m);
      return c.yellow(m);
    },
  );
}

function formatRaw(data: any): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (typeof data !== 'object') return String(data);
  return JSON.stringify(data, null, 2);
}

function formatIds(data: any): string {
  const one = (x: any): string => {
    if (x === null || x === undefined) return '';
    if (typeof x !== 'object') return String(x);
    if ('id' in x && x.id !== undefined) return String(x.id);
    if ('name' in x && x.name !== undefined) return String(x.name);
    return JSON.stringify(x);
  };
  if (Array.isArray(data)) return data.map(one).join('\n');
  return one(data);
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const PRIORITY = ['id', 'name', 'title', 'hostname', 'type', 'status', 'content', 'value', 'enabled', 'paused', 'proxied', 'ttl', 'description', 'created_on', 'created_at', 'modified_on', 'modified_at', 'updated_at'];
const LOW_PRIORITY = ['meta', 'metadata', 'settings', 'tags', 'permissions', 'account', 'owner', 'plan', 'betas'];

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cellText(v: any, max = 60): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.replace(/\s*\n\s*/g, ' ⏎ ');
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => cellText(x)).join(', ');
    return truncate(JSON.stringify(v), max);
  }
  if (isPlainObject(v)) {
    if ('name' in v && typeof v.name === 'string' && Object.keys(v).length <= 3) return String(v.name);
    if ('id' in v && Object.keys(v).length <= 3) return String(v.id);
    return truncate(JSON.stringify(v), max);
  }
  return String(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

function pickColumns(rows: Record<string, any>[]): string[] {
  const sample = rows.slice(0, 200);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of sample) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), keys.push(k));
  const complexity = (k: string) => {
    let complex = 0;
    let filled = 0;
    for (const r of sample) {
      const v = r[k];
      if (v === undefined || v === null || v === '') continue;
      filled++;
      if (isPlainObject(v) && !('name' in v || 'id' in v)) complex++;
      else if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) complex++;
    }
    return { complex: filled ? complex / filled : 0, filled };
  };
  const score = (k: string) => {
    const pi = PRIORITY.indexOf(k);
    const { complex, filled } = complexity(k);
    let s = pi >= 0 ? pi : 50 + keys.indexOf(k);
    if (LOW_PRIORITY.includes(k)) s += 100;
    if (complex > 0.5) s += 200;
    if (filled === 0) s += 400;
    return s;
  };
  return [...keys].sort((a, b) => score(a) - score(b));
}

export function formatTable(data: any, columns?: string[]): string {
  if (data === undefined || data === null) return c.dim('(no data)');
  if (typeof data !== 'object') return String(data);
  if (Array.isArray(data)) {
    if (data.length === 0) return c.dim('(no results)');
    if (data.every((x) => x === null || typeof x !== 'object')) return data.map((x) => cellText(x, 200)).join('\n');
    const rows = data.map((x) => (isPlainObject(x) ? x : { value: x }));
    return renderRows(rows, columns);
  }
  // Single object → key/value table (flatten one level of nesting)
  const flat = flattenObject(data, 2);
  const keyW = Math.min(40, Math.max(...Object.keys(flat).map((k) => k.length), 3));
  const valW = Math.max(20, termWidth() - keyW - 3);
  return Object.entries(flat)
    .map(([k, v]) => `${c.cyan(k.padEnd(keyW))} ${truncate(cellText(v, 2000), valW)}`)
    .join('\n');
}

export function flattenObject(obj: any, depth: number, prefix = ''): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v) && depth > 0 && Object.keys(v).length > 0 && Object.keys(v).length <= 30) Object.assign(out, flattenObject(v, depth - 1, key));
    else out[key] = v;
  }
  return out;
}

function renderRows(rows: Record<string, any>[], columns?: string[]): string {
  const cols = columns && columns.length ? columns : pickColumns(rows);
  const width = termWidth();
  const maxCell = 60;
  // Desired widths
  const widths = cols.map((col) => {
    let w = col.length;
    for (const r of rows.slice(0, 500)) w = Math.max(w, Math.min(maxCell, cellText(getPath(r, col), maxCell).length));
    return w;
  });
  // Fit columns into the terminal width (explicit columns are never dropped)
  const sep = 2;
  let chosen: number[] = [];
  let used = 0;
  for (let i = 0; i < cols.length; i++) {
    const need = widths[i]! + (chosen.length ? sep : 0);
    if (used + need <= width || chosen.length === 0 || (columns && columns.length)) {
      chosen.push(i);
      used += need;
    }
  }
  // Shrink widest columns if still overflowing
  let total = chosen.reduce((a, i) => a + widths[i]!, 0) + sep * (chosen.length - 1);
  while (total > width) {
    const widest = chosen.reduce((a, i) => (widths[i]! > widths[a]! ? i : a), chosen[0]!);
    if (widths[widest]! <= 8) break;
    widths[widest]!--;
    total--;
  }
  const hidden = cols.length - chosen.length;
  const lines: string[] = [];
  lines.push(chosen.map((i) => c.bold(cols[i]!.padEnd(widths[i]!))).join(' '.repeat(sep)).trimEnd());
  for (const r of rows) {
    lines.push(
      chosen
        .map((i) => {
          const text = truncate(cellText(getPath(r, cols[i]!), maxCell), widths[i]!);
          return text.padEnd(widths[i]!);
        })
        .join(' '.repeat(sep))
        .trimEnd(),
    );
  }
  if (hidden > 0) lines.push(c.dim(`… ${hidden} more column${hidden === 1 ? '' : 's'} hidden; use -o json, --fields, or widen the terminal.`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

function formatDelimited(data: any, delim: string, columns?: string[]): string {
  const rows: Record<string, any>[] = Array.isArray(data) ? data.map((x) => (isPlainObject(x) ? x : { value: x })) : isPlainObject(data) ? [data] : [{ value: data }];
  if (rows.length === 0) return '';
  const cols = columns && columns.length ? columns : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: any) => {
    let s: string;
    if (v === null || v === undefined) s = '';
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    if (delim === ',' && /[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    if (delim === '\t') s = s.replace(/\t/g, ' ').replace(/\n/g, ' ');
    return s;
  };
  return [cols.join(delim), ...rows.map((r) => cols.map((col) => esc(getPath(r, col))).join(delim))].join('\n');
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}
