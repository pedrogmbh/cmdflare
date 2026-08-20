/** Loads the generated command manifest and resolves user tokens to resources/methods. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors';
import type { Manifest, MethodNode, ResourceNode } from './manifest-types';
import { normKey } from './names';

let genDir: string | undefined;
export function generatedDir(): string {
  if (genDir) return genDir;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CMDFLARE_GENERATED_DIR,
    join(here, '../generated'),
    join(here, 'generated'),
    join(here, '../../src/generated'),
    join(here, '../src/generated'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.json'))) return (genDir = c);
  }
  throw new CliError('Command manifest not found (src/generated/index.json). Run `bun run gen` to generate it.');
}

let indexCache: Manifest | undefined;
export function loadIndex(): Manifest {
  if (indexCache) return indexCache;
  indexCache = JSON.parse(readFileSync(join(generatedDir(), 'index.json'), 'utf8')) as Manifest;
  return indexCache;
}

const detailCache = new Map<string, ResourceNode>();
export function loadTopDetail(topCli: string): ResourceNode {
  const hit = detailCache.get(topCli);
  if (hit) return hit;
  const file = join(generatedDir(), 'resources', `${topCli}.json`);
  if (!existsSync(file)) throw new CliError(`Manifest detail file missing for "${topCli}". Run \`bun run gen\`.`);
  const node = JSON.parse(readFileSync(file, 'utf8')) as ResourceNode;
  detailCache.set(topCli, node);
  return node;
}

/** Returns the full MethodNode (with params) for a method found through the light index. */
export function getMethodDetail(path: ResourceNode[], method: MethodNode): MethodNode {
  if (method.params || !method.hasParams) return method;
  const top = path[0];
  if (!top) return method;
  let node: ResourceNode | undefined = loadTopDetail(top.cli);
  for (const seg of path.slice(1)) {
    node = node?.children.find((c) => c.name === seg.name);
    if (!node) break;
  }
  const full = node?.methods.find((m) => m.name === method.name);
  return full ?? method;
}

export const METHOD_ALIASES: Record<string, string[]> = {
  list: ['ls'],
  delete: ['rm', 'del', 'remove'],
  get: ['show', 'describe', 'info', 'view'],
  create: ['add', 'new'],
};

export function findChild(node: ResourceNode, token: string): ResourceNode | undefined {
  const k = normKey(token);
  return node.children.find((c) => normKey(c.cli) === k || normKey(c.name) === k);
}

export function findMethod(node: ResourceNode, token: string): MethodNode | undefined {
  const k = normKey(token);
  const exact = node.methods.find((m) => normKey(m.cli) === k || normKey(m.name) === k);
  if (exact) return exact;
  for (const [target, aliases] of Object.entries(METHOD_ALIASES)) {
    if (aliases.includes(k)) {
      const m = node.methods.find((x) => x.name === target);
      if (m) return m;
    }
  }
  return undefined;
}

export interface Resolved {
  ok: true;
  /** Resource path from the first top-level resource down to the node. */
  path: ResourceNode[];
  node: ResourceNode;
  method?: MethodNode;
  /** Remaining tokens after the method (positionals). */
  rest: string[];
}
export interface Unresolved {
  ok: false;
  path: ResourceNode[];
  node: ResourceNode;
  token: string;
  suggestions: string[];
}

export function resolveCommand(tokens: string[], root: ResourceNode = loadIndex().root): Resolved | Unresolved {
  const path: ResourceNode[] = [];
  let node = root;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const child = findChild(node, tok);
    if (child) {
      path.push(child);
      node = child;
      continue;
    }
    const method = findMethod(node, tok);
    if (method) return { ok: true, path, node, method, rest: tokens.slice(i + 1) };
    const candidates = [...node.children.map((c) => c.cli), ...node.methods.map((m) => m.cli)];
    return { ok: false, path, node, token: tok, suggestions: suggest(tok, candidates) };
  }
  return { ok: true, path, node, rest: [] };
}

export function commandPath(path: ResourceNode[], method?: MethodNode): string {
  const parts = path.map((p) => p.cli);
  if (method) parts.push(method.cli);
  return parts.join(' ');
}

export interface FlatCommand {
  path: ResourceNode[];
  node: ResourceNode;
  method: MethodNode;
  cli: string;
}

let flatCache: FlatCommand[] | undefined;
export function flattenCommands(root: ResourceNode = loadIndex().root): FlatCommand[] {
  if (flatCache && root === loadIndex().root) return flatCache;
  const out: FlatCommand[] = [];
  const walk = (n: ResourceNode, path: ResourceNode[]) => {
    for (const m of n.methods) out.push({ path, node: n, method: m, cli: commandPath(path, m) });
    for (const ch of n.children) walk(ch, [...path, ch]);
  };
  walk(root, []);
  if (root === loadIndex().root) flatCache = out;
  return out;
}

export function countMethods(node: ResourceNode): number {
  return node.methods.length + node.children.reduce((a, c) => a + countMethods(c), 0);
}

// ---------------------------------------------------------------------------
// Fuzzy helpers
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[n]!;
}

export function suggest(token: string, candidates: string[], max = 4): string[] {
  const t = normKey(token);
  const scored = candidates
    .map((cand) => {
      const k = normKey(cand);
      let score: number;
      if (k === t) score = 0;
      else if (k.startsWith(t) || t.startsWith(k)) score = 0.5;
      else if (k.includes(t) || t.includes(k)) score = 1;
      else score = levenshtein(t, k);
      return { cand, score };
    })
    .filter((x) => x.score <= Math.max(2, Math.floor(t.length / 3)))
    .sort((a, b) => a.score - b.score || a.cand.length - b.cand.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scored) {
    if (seen.has(s.cand)) continue;
    seen.add(s.cand);
    out.push(s.cand);
    if (out.length >= max) break;
  }
  return out;
}

/** Scores a command against free-text search terms; higher is better, 0 means no match. */
export function searchScore(cmd: FlatCommand, terms: string[]): number {
  if (!terms.length) return 1;
  const hay = (cmd.cli + ' ' + (cmd.method.summary ?? '') + ' ' + (cmd.method.path ?? '')).toLowerCase();
  const cliNorm = normKey(cmd.cli);
  let score = 0;
  for (const raw of terms) {
    const term = raw.toLowerCase();
    if (!term) continue;
    const tn = normKey(term);
    if (cmd.path.some((p) => normKey(p.cli) === tn) || normKey(cmd.method.cli) === tn) score += 10;
    else if (cliNorm.includes(tn)) score += 5;
    else if (hay.includes(term)) score += 2;
    else return 0;
  }
  // prefer shorter command paths on ties
  return score + 1 / (1 + cmd.cli.length / 10);
}
