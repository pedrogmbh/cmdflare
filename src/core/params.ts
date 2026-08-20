/** Builds the SDK params object for a method from parsed flags, --data, --set and context defaults. */
import type { FlagSpec } from './argv';
import { coerceValue, getPath, parseDataArg, resolveAt, setPath, looksLikeJson, parseStructured } from './coerce';
import { UsageError } from './errors';
import { suggest } from './manifest';
import type { MethodNode, ParamProp, Positional } from './manifest-types';
import { flagName, normKey } from './names';

export const PARAM_PREFIX = 'param:';

export interface MethodFlagSpecs {
  specs: FlagSpec[];
  /** prop name → prop */
  props: Map<string, ParamProp>;
  /** Global flag long-names shadowed by a param of the same name. */
  collisions: string[];
}

export function paramFlagType(p: ParamProp): FlagSpec['type'] {
  switch (p.type.kind) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    default:
      return 'string';
  }
}

/** Flag specs for a method's params; names are kebab-case with the snake_case original as alias. */
export function buildMethodFlagSpecs(method: MethodNode, globalNames: Set<string>): MethodFlagSpecs {
  const specs: FlagSpec[] = [];
  const props = new Map<string, ParamProp>();
  const collisions: string[] = [];
  for (const p of method.params?.type.props ?? []) {
    props.set(p.name, p);
    const name = flagName(p.name);
    const aliases = new Set<string>();
    if (name !== p.name) aliases.add(p.name);
    // also accept camelCase spelling
    const camel = p.name.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
    if (camel !== p.name && camel !== name) aliases.add(camel);
    if (globalNames.has(name)) collisions.push(name);
    specs.push({
      name,
      id: PARAM_PREFIX + p.name,
      aliases: [...aliases],
      type: paramFlagType(p),
      multiple: p.type.kind === 'array' || (p.type.kind === 'union' && !!p.type.members?.some((m) => m.kind === 'array')),
    });
  }
  return { specs, props, collisions };
}

export function deepMerge(target: any, source: any): any {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return source;
  const out: any = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(source)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export interface BuildParamsInput {
  method: MethodNode;
  /** Parsed flags (values keyed by `param:<name>`). */
  flags: Record<string, any>;
  /** Unknown flags as typed (may include dotted paths). */
  unknown: Record<string, string | true | Array<string | true>>;
  data?: string[];
  sets?: string[];
  /** Context defaults applied when the method accepts them and they were not given. */
  accountId?: string;
  zoneId?: string;
}

export function buildParams(input: BuildParamsInput): Record<string, any> {
  const { method } = input;
  const props = method.params?.type.props ?? [];
  const propByName = new Map(props.map((p) => [p.name, p]));
  let params: Record<string, any> = {};

  // 1) --data (JSON/YAML, files, stdin) — merged in order
  for (const d of input.data ?? []) {
    const v = parseDataArg(d, 'data');
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new UsageError('--data must be a JSON/YAML object of parameters.', 'Example: --data \'{"name":"example.com","type":"A"}\' or --data @params.json');
    }
    params = deepMerge(params, v);
  }

  // 2) typed flags
  for (const [key, raw] of Object.entries(input.flags)) {
    if (!key.startsWith(PARAM_PREFIX)) continue;
    const name = key.slice(PARAM_PREFIX.length);
    const prop = propByName.get(name);
    if (raw === undefined) continue;
    params[name] = coerceFlag(raw, prop, flagName(name));
  }

  // 3) unknown flags: dotted paths into known object params, or anything when the params shape is opaque
  const opaque = !!method.params && props.length === 0;
  for (const [name, raw] of Object.entries(input.unknown)) {
    const root = name.split('.')[0]!.split('[')[0]!;
    const rootSnake = root.replace(/-/g, '_');
    const prop = propByName.get(rootSnake) ?? propByName.get(root);
    if (name.includes('.') || name.includes('[')) {
      if (!prop && !opaque) {
        throw new UsageError(`Unknown flag --${name}`, suggestFlags(root, props));
      }
      const path = (prop ? prop.name : rootSnake) + name.slice(root.length).replace(/-([a-z0-9])/g, '_$1');
      const leafSpec = prop ? leafTypeSpec(prop, name.slice(root.length)) : undefined;
      const val = coerceFlag(raw, leafSpec ? ({ name, required: false, type: leafSpec } as ParamProp) : undefined, name);
      setPath(params, path, val);
      continue;
    }
    if (opaque) {
      params[rootSnake] = coerceFlag(raw, undefined, name);
      continue;
    }
    if (!method.params) {
      throw new UsageError(`Unknown flag --${name}: this command takes no parameters.`);
    }
    throw new UsageError(`Unknown flag --${name}`, suggestFlags(root, props));
  }

  // 4) --set k.path=value
  for (const s of input.sets ?? []) {
    const eq = s.indexOf('=');
    if (eq <= 0) throw new UsageError(`--set expects key.path=value, got "${s}"`);
    const path = s.slice(0, eq).replace(/-([a-z0-9])/g, '_$1');
    const rawVal = resolveAt(s.slice(eq + 1), 'set');
    let val: any = rawVal;
    if (looksLikeJson(rawVal)) val = parseStructured(rawVal, 'set');
    else if (rawVal === 'true') val = true;
    else if (rawVal === 'false') val = false;
    else if (rawVal === 'null') val = null;
    else if (/^-?\d+(\.\d+)?$/.test(rawVal)) val = Number(rawVal);
    setPath(params, path, val);
  }

  // 5) context defaults
  if (propByName.has('account_id') && params.account_id === undefined && input.accountId) params.account_id = input.accountId;
  if (propByName.has('zone_id') && params.zone_id === undefined && input.zoneId) params.zone_id = input.zoneId;

  return params;
}

function leafTypeSpec(prop: ParamProp, subPath: string) {
  // Walk nested props to find the type of a dotted sub path (best effort).
  const parts = subPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let t = prop.type;
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      if (t.kind === 'array' && t.items) t = t.items;
      else return undefined;
      continue;
    }
    if (t.kind !== 'object' || !t.props) return undefined;
    const key = part.replace(/-/g, '_');
    const sp = t.props.find((x) => x.name === key);
    if (!sp) return undefined;
    t = sp.type;
  }
  return t;
}

function coerceFlag(raw: any, prop: ParamProp | undefined, flag: string): any {
  // Smart shortcut: an object that has an `id` key accepts a bare id string, e.g. --account <id>.
  if (prop && prop.type.kind === 'object' && typeof raw === 'string' && !looksLikeJson(raw) && !raw.startsWith('@') && prop.type.props?.some((p) => p.name === 'id')) {
    return { id: raw };
  }
  return coerceValue(raw, prop?.type, flag);
}

function suggestFlags(name: string, props: ParamProp[]): string | undefined {
  const names = props.map((p) => flagName(p.name));
  const s = suggest(name, names);
  if (s.length) return `Did you mean --${s.join(', --')}?`;
  if (names.length) return `Available flags: ${names.slice(0, 12).map((n) => '--' + n).join(', ')}${names.length > 12 ? ', …' : ''} (see --help)`;
  return undefined;
}

export interface MissingInfo {
  positionals: Positional[];
  props: ParamProp[];
}

export function findMissing(method: MethodNode, positionals: any[], params: Record<string, any>): MissingInfo {
  const missingPos = method.positionals.filter((p, i) => p.required && (positionals[i] === undefined || positionals[i] === ''));
  const props = method.params?.type.props ?? [];
  const missingProps = props.filter((p) => p.required && (params[p.name] === undefined || params[p.name] === null));
  return { positionals: missingPos, props: missingProps };
}

export function coercePositional(raw: string, p: Positional): any {
  if (p.type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new UsageError(`Argument <${p.cli}> expects a number, got "${raw}"`);
    return n;
  }
  if (p.type === 'enum' && p.enum && !p.enum.includes(raw)) {
    const ci = p.enum.find((e) => e.toLowerCase() === raw.toLowerCase());
    if (ci) return ci;
    throw new UsageError(`Argument <${p.cli}>: invalid value "${raw}".`, `Allowed: ${p.enum.join(', ')}`);
  }
  return raw;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:@=+,]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Renders an equivalent non-interactive command line (used by interactive mode). */
export function commandLineFor(cp: string, method: MethodNode, positionals: any[], params: Record<string, any>, extra: string[] = []): string {
  const parts = ['cmdflare', cp];
  for (const v of positionals) parts.push(shellQuote(String(v)));
  const props = method.params?.type.props ?? [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const prop = props.find((p) => p.name === k);
    const flag = '--' + flagName(k);
    if (typeof v === 'boolean') parts.push(v ? flag : `${flag}=false`);
    else if (typeof v === 'number') parts.push(`${flag} ${v}`);
    else if (typeof v === 'string') parts.push(`${flag} ${shellQuote(v)}`);
    else if (Array.isArray(v) && v.every((x) => typeof x !== 'object') && prop?.type.kind === 'array') parts.push(`${flag} ${shellQuote(v.map(String).join(','))}`);
    else if (v && typeof v === 'object' && 'name' in v && typeof (v as any).size === 'number') parts.push(`${flag} <file>`);
    else parts.push(`${flag} ${shellQuote(JSON.stringify(v))}`);
  }
  parts.push(...extra);
  return parts.join(' ');
}

export function flagKeyFor(name: string): string {
  return normKey(name);
}

export { getPath };
