/** Global flag specs shared by the CLI entry, help and builtin commands. */
import type { FlagSpec } from './argv';

export const GLOBAL_SPECS: FlagSpec[] = [
  { name: 'output', aliases: ['o'], type: 'string' },
  { name: 'json', type: 'boolean' },
  { name: 'compact', type: 'boolean' },
  { name: 'query', aliases: ['q'], type: 'string' },
  { name: 'fields', type: 'string' },
  { name: 'all', type: 'boolean' },
  { name: 'limit', type: 'number' },
  { name: 'account', aliases: ['A'], type: 'string' },
  { name: 'zone', aliases: ['Z'], type: 'string' },
  { name: 'profile', aliases: ['p'], type: 'string' },
  { name: 'token', type: 'string' },
  { name: 'api-key', type: 'string' },
  { name: 'email', type: 'string' },
  { name: 'data', aliases: ['d'], type: 'string', multiple: true },
  { name: 'set', type: 'string', multiple: true },
  { name: 'yes', aliases: ['y'], type: 'boolean' },
  { name: 'no-input', type: 'boolean' },
  { name: 'interactive', aliases: ['i'], type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
  { name: 'curl', type: 'boolean' },
  { name: 'raw-response', type: 'boolean' },
  { name: 'include-meta', type: 'boolean' },
  { name: 'output-file', type: 'string' },
  { name: 'timeout', type: 'number' },
  { name: 'max-retries', type: 'number' },
  { name: 'base-url', type: 'string' },
  { name: 'verbose', aliases: ['v'], type: 'boolean' },
  { name: 'quiet', aliases: ['s'], type: 'boolean' },
  { name: 'color', type: 'boolean' },
  { name: 'help', aliases: ['h'], type: 'boolean' },
  { name: 'version', aliases: ['V'], type: 'boolean' },
  // hidden: `cmdflare help --tree`
  { name: 'tree', type: 'boolean' },
];

export const GLOBAL_NAMES = new Set(GLOBAL_SPECS.map((s) => s.name));

/** Short alias for a global flag, if any (used in help when a param shadows the long name). */
export function globalShort(name: string): string | undefined {
  const s = GLOBAL_SPECS.find((x) => x.name === name);
  return s?.aliases?.find((a) => a.length === 1);
}
