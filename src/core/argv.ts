/** Small, dependency-free argv parser with a spec for known flags; unknown flags are kept for the command layer. */

export type FlagType = 'boolean' | 'string' | 'number' | 'count';

export interface FlagSpec {
  /** Canonical name (kebab-case, without dashes). */
  name: string;
  /** Key used to store the value in `flags` (defaults to name). Lets params and globals share a namespace safely. */
  id?: string;
  aliases?: string[];
  type: FlagType;
  /** Repeatable → array of values. */
  multiple?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  /** Known flags by canonical name. */
  flags: Record<string, any>;
  /** Unknown `--flags` (name as typed) → string | true | (string|true)[] */
  unknown: Record<string, string | true | Array<string | true>>;
  /** Order of unknown flags as typed, for error messages. */
  unknownOrder: string[];
}

export class ArgvError extends Error {}

export function parseArgv(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  for (const s of specs) {
    byName.set(s.name, s);
    for (const a of s.aliases ?? []) byName.set(a, s);
  }
  const out: ParsedArgs = { positionals: [], flags: {}, unknown: {}, unknownOrder: [] };

  const setKnown = (spec: FlagSpec, raw: string | boolean) => {
    let val: any = raw;
    if (spec.type === 'number') {
      val = Number(raw);
      if (Number.isNaN(val)) throw new ArgvError(`Flag --${spec.name} expects a number, got "${raw}"`);
    } else if (spec.type === 'boolean') {
      val = typeof raw === 'boolean' ? raw : parseBool(raw, spec.name);
    } else if (spec.type === 'count') {
      const key = spec.id ?? spec.name;
      out.flags[key] = (out.flags[key] ?? 0) + 1;
      return;
    }
    const key = spec.id ?? spec.name;
    if (spec.multiple) (out.flags[key] ??= []).push(val);
    else out.flags[key] = val;
  };

  const setUnknown = (name: string, val: string | true) => {
    if (!(name in out.unknown)) out.unknownOrder.push(name);
    const prev = out.unknown[name];
    if (prev === undefined) out.unknown[name] = val;
    else if (Array.isArray(prev)) prev.push(val);
    else out.unknown[name] = [prev, val];
  };

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--') && tok.length > 2) {
      let name = tok.slice(2);
      let inlineVal: string | undefined;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        inlineVal = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      let negated = false;
      let spec = byName.get(name);
      if (!spec && name.startsWith('no-') && byName.get(name.slice(3))?.type === 'boolean') {
        spec = byName.get(name.slice(3));
        negated = true;
      }
      if (spec) {
        if (spec.type === 'boolean') {
          if (inlineVal !== undefined) setKnown(spec, negated ? !parseBool(inlineVal, name) : inlineVal);
          else if (!negated && isBoolWord(argv[i + 1])) {
            setKnown(spec, argv[i + 1]!);
            i++;
          } else setKnown(spec, !negated);
        } else if (spec.type === 'count') {
          setKnown(spec, true);
        } else if (inlineVal !== undefined) {
          setKnown(spec, inlineVal);
        } else if (i + 1 < argv.length && !looksLikeFlag(argv[i + 1]!)) {
          setKnown(spec, argv[i + 1]!);
          i++;
        } else {
          throw new ArgvError(`Flag --${name} requires a value`);
        }
      } else if (inlineVal !== undefined) {
        setUnknown(name, inlineVal);
      } else if (i + 1 < argv.length && !looksLikeFlag(argv[i + 1]!)) {
        setUnknown(name, argv[i + 1]!);
        i++;
      } else {
        setUnknown(name, true);
      }
      i++;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      // short flags: -v, -vy, -o json, -ojson, -o=json
      const body = tok.slice(1);
      let j = 0;
      while (j < body.length) {
        const ch = body[j]!;
        const spec = byName.get(ch);
        if (!spec) {
          // Unknown short option: keep it for the command layer (value = rest of token or next token).
          const restTok = body.slice(j + 1).replace(/^=/, '');
          if (restTok.length > 0) setUnknown(ch, restTok);
          else if (i + 1 < argv.length && !looksLikeFlag(argv[i + 1]!)) {
            setUnknown(ch, argv[i + 1]!);
            i++;
          } else setUnknown(ch, true);
          break;
        }
        if (spec.type === 'boolean' || spec.type === 'count') {
          setKnown(spec, true);
          j++;
          continue;
        }
        let rest = body.slice(j + 1);
        if (rest.startsWith('=')) rest = rest.slice(1);
        if (rest.length > 0) {
          setKnown(spec, rest);
        } else if (i + 1 < argv.length && !looksLikeFlag(argv[i + 1]!)) {
          setKnown(spec, argv[i + 1]!);
          i++;
        } else {
          throw new ArgvError(`Option -${ch} requires a value`);
        }
        break;
      }
      i++;
      continue;
    }
    out.positionals.push(tok);
    i++;
  }
  return out;
}

function looksLikeFlag(tok: string): boolean {
  if (tok === '-') return false;
  if (/^-\d/.test(tok)) return false; // negative numbers are values
  return tok.startsWith('-') && tok.length > 1;
}

function isBoolWord(tok: string | undefined): boolean {
  return tok === 'true' || tok === 'false';
}

export function parseBool(raw: string, name: string): boolean {
  const v = raw.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  throw new ArgvError(`Flag --${name} expects true/false, got "${raw}"`);
}
