/** Prompt helpers shared by interactive mode and the "missing required value" fallback. */
import { checkbox, confirm, editor, input, search, select } from '@inquirer/prompts';
import {
  CATALOG_PAGE_SIZE,
  PICKER_PREFETCH_MAX,
  itemMatches,
  listAccounts,
  listDnsRecords,
  listZones,
  mergeById,
  zoneNameQuery,
  type CatalogQuery,
} from '../core/catalog';
import { coerceValue } from '../core/coerce';
import { ID_RE, type Context } from '../core/config';
import { CliError, EXIT } from '../core/errors';
import { typeLabel } from '../core/help';
import type { CollectPagesResult } from '../core/invoke';
import type { MethodNode, ParamProp, Positional, TypeSpec } from '../core/manifest-types';
import { flagName } from '../core/names';
import { c, log, withSpinner } from '../core/ui';

export const promptIO = () => ({ output: process.stderr, input: process.stdin });

export interface PromptHelpers {
  ctx?: Context;
  getClient?: () => Promise<any>;
}

function shortDesc(d?: string): string {
  if (!d) return '';
  const first = d.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ');
  return first.length > 160 ? first.slice(0, 157) + '…' : first;
}

function onCancel(err: unknown): never {
  if (err && typeof err === 'object' && (err as any).name === 'ExitPromptError') throw new CliError('Cancelled.', { exitCode: EXIT.CANCELLED });
  throw err;
}

export async function promptPositional(p: Positional): Promise<any> {
  try {
    if (p.type === 'enum' && p.enum?.length) {
      return await select({ message: `${p.cli}`, choices: p.enum.map((e) => ({ name: e, value: e })) }, promptIO());
    }
    const v = await input(
      {
        message: `${p.cli}${p.description ? c.dim(' — ' + shortDesc(p.description)) : ''}`,
        validate: (s) => (p.required && !s.trim() ? 'Required' : p.type === 'number' && Number.isNaN(Number(s)) ? 'Expected a number' : true),
      },
      promptIO(),
    );
    return p.type === 'number' ? Number(v) : v.trim();
  } catch (err) {
    onCancel(err);
  }
}

type CatalogKind = 'zone' | 'account' | 'dns-record';

function catalogNoun(kind: CatalogKind): string {
  return kind === 'dns-record' ? 'DNS record' : kind;
}

function catalogLabel(kind: CatalogKind, it: any): string {
  if (kind === 'dns-record') {
    const typ = String(it.type ?? '').padEnd(6);
    const name = String(it.name ?? '');
    const content = it.content != null ? String(it.content) : '';
    const extra = content.length > 40 ? content.slice(0, 37) + '…' : content;
    return `${typ} ${name}${extra ? '  ' + extra : ''} ${c.dim(it.id)}`;
  }
  return `${it.name} ${c.dim(it.id)}`;
}

async function fetchCatalog(
  kind: CatalogKind,
  client: any,
  opts: { term?: string; accountId?: string; zoneId?: string; maxItems: number; signal?: AbortSignal },
): Promise<CollectPagesResult> {
  const q: CatalogQuery = { maxItems: opts.maxItems, signal: opts.signal };
  if (kind === 'zone') return listZones(client, { ...q, name: opts.term ? zoneNameQuery(opts.term) : undefined, accountId: opts.accountId });
  if (kind === 'account') return listAccounts(client, { ...q, name: opts.term || undefined });
  return listDnsRecords(client, { ...q, zoneId: opts.zoneId!, search: opts.term || undefined });
}

export async function pickCatalogItem(
  kind: CatalogKind,
  helpers: PromptHelpers,
  opts: { message?: string; allowNone?: boolean; zoneId?: string } = {},
): Promise<string | undefined> {
  if (!helpers.getClient || helpers.ctx?.credentials.kind === 'none') return undefined;
  const noun = catalogNoun(kind);
  const accountId = helpers.ctx?.accountId;
  const zoneId = opts.zoneId;
  if (kind === 'dns-record' && !zoneId) return undefined;
  try {
    const client = await helpers.getClient();
    const prefetch = await withSpinner(`Loading ${noun}s…`, () =>
      fetchCatalog(kind, client, { accountId, zoneId, maxItems: PICKER_PREFETCH_MAX }),
    );
    if (!prefetch.items.length && !prefetch.truncated) return undefined;
    const none = opts.allowNone ? { name: c.dim('(none — skip)'), value: '__none__' } : undefined;
    const manual = { name: c.dim('(type an id manually)'), value: '' };
    const hint =
      prefetch.truncated && prefetch.total != null
        ? { name: c.dim(`… ${prefetch.total - prefetch.items.length} more — type a name to search all ${prefetch.total}`), value: '__hint__', disabled: true }
        : prefetch.truncated
          ? { name: c.dim('… more not loaded — type a name to search remotely'), value: '__hint__', disabled: true }
          : undefined;
    const picked = await search(
      {
        message:
          opts.message ??
          (prefetch.truncated
            ? `Select ${noun} ${c.dim(`(${prefetch.items.length}${prefetch.total != null ? ` of ${prefetch.total}` : ''} shown; type to search all)`)}`
            : `Select ${noun}${prefetch.total != null ? c.dim(` (${prefetch.total})`) : ''}`),
        pageSize: 12,
        source: async (term, { signal }) => {
          const t = (term ?? '').trim();
          let items = t ? prefetch.items.filter((it) => itemMatches(it, t)) : prefetch.items;
          if (t && prefetch.truncated) {
            try {
              const remote = await fetchCatalog(kind, client, { term: t, accountId, zoneId, maxItems: CATALOG_PAGE_SIZE, signal });
              items = mergeById(items, remote.items);
            } catch (err: any) {
              if (signal.aborted || err?.name === 'AbortError') return [];
              log.debug(`Remote ${noun} search failed: ${err?.message}`);
            }
          }
          const choices: Array<{ name: string; value: string; disabled?: boolean }> = items.map((it) => ({
            name: catalogLabel(kind, it),
            value: String(it.id),
          }));
          if (t && ID_RE.test(t) && !choices.some((ch) => ch.value === t)) {
            choices.unshift({ name: `Use id ${t}`, value: t });
          }
          if (!t && hint) choices.push(hint);
          if (!choices.length) choices.push({ name: c.dim('No matches'), value: '__none__', disabled: true });
          choices.push(manual);
          if (none) choices.push(none);
          return choices;
        },
      },
      promptIO(),
    );
    if (!picked || picked === '__none__' || picked === '__hint__') return undefined;
    return picked;
  } catch (err: any) {
    if (err?.name === 'ExitPromptError') onCancel(err);
    log.debug(`Could not list ${noun}s: ${err?.message}`);
    return undefined;
  }
}

export async function promptProp(p: ParamProp, helpers: PromptHelpers = {}): Promise<any> {
  const label = `--${flagName(p.name)}`;
  const desc = shortDesc(p.description);
  const message = `${label}${p.required ? '' : c.dim(' (optional)')}${desc ? c.dim(' — ' + desc) : ''}`;
  try {
    if (p.name === 'zone_id' || p.name === 'account_id') {
      const picked = await pickCatalogItem(p.name === 'zone_id' ? 'zone' : 'account', helpers);
      if (picked) return picked;
    }
    return await promptForType(p.type, message, p.required, label);
  } catch (err) {
    onCancel(err);
  }
}

export async function promptForType(t: TypeSpec, message: string, required: boolean, flag: string): Promise<any> {
  switch (t.kind) {
    case 'boolean':
      return confirm({ message, default: false }, promptIO());
    case 'enum': {
      const values = t.enum ?? [];
      if (values.length > 15) {
        return search(
          { message, source: (term) => values.filter((v) => String(v).toLowerCase().includes((term ?? '').toLowerCase())).map((v) => ({ name: String(v), value: v })), pageSize: 12 },
          promptIO(),
        );
      }
      return select({ message, choices: values.map((v) => ({ name: String(v), value: v })), pageSize: 15 }, promptIO());
    }
    case 'number': {
      const v = await input({ message, validate: (s) => (!s.trim() ? (required ? 'Required' : true) : Number.isNaN(Number(s)) ? 'Expected a number' : true) }, promptIO());
      return v.trim() === '' ? undefined : Number(v);
    }
    case 'array': {
      if (t.items?.kind === 'enum' && t.items.enum?.length) {
        const picked = await checkbox({ message, choices: t.items.enum.map((v) => ({ name: String(v), value: v })), pageSize: 15 }, promptIO());
        return picked.length ? picked : undefined;
      }
      const v = await input({ message: `${message} ${c.dim(`[${typeLabel(t)}: comma-separated or JSON array]`)}`, validate: (s) => (required && !s.trim() ? 'Required' : true) }, promptIO());
      return v.trim() === '' ? undefined : coerceValue(v, t, flag);
    }
    case 'object':
    case 'record': {
      const props = t.kind === 'object' ? (t.props ?? []) : [];
      if (props.length) {
        const how = await select(
          {
            message: `${message} ${c.dim('(object)')}`,
            choices: [
              { name: `Fill fields one by one ${c.dim(`(${props.filter((x) => x.required).length} required, ${props.length} total)`)}`, value: 'fields' },
              { name: 'Enter JSON', value: 'json' },
              ...(required ? [] : [{ name: c.dim('Skip'), value: 'skip' }]),
            ],
          },
          promptIO(),
        );
        if (how === 'skip') return undefined;
        if (how === 'fields') {
          const out: Record<string, any> = {};
          for (const sp of props.filter((x) => x.required)) out[sp.name] = await promptForType(sp.type, `${flag}.${sp.name}${c.dim(shortDesc(sp.description) ? ' — ' + shortDesc(sp.description) : '')}`, true, `${flag}.${sp.name}`);
          const optional = props.filter((x) => !x.required);
          if (optional.length) {
            const more = await checkbox(
              { message: `${flag}: optional fields to set`, choices: optional.map((sp) => ({ name: `${sp.name} ${c.dim(shortDesc(sp.description))}`, value: sp.name })), pageSize: 15 },
              promptIO(),
            );
            for (const name of more) {
              const sp = optional.find((x) => x.name === name)!;
              const v = await promptForType(sp.type, `${flag}.${sp.name}`, false, `${flag}.${sp.name}`);
              if (v !== undefined) out[sp.name] = v;
            }
          }
          return out;
        }
      }
      const template = props.length ? JSON.stringify(Object.fromEntries(props.filter((x) => x.required).map((x) => [x.name, placeholderFor(x.type)])), null, 2) : '{\n  \n}';
      const text = process.env.EDITOR || process.env.VISUAL ? await editor({ message: `${message} (JSON; opens $EDITOR)`, default: template, postfix: '.json' }, promptIO()) : await input({ message: `${message} ${c.dim('(JSON)')}`, default: props.length ? undefined : '{}' }, promptIO());
      if (!text.trim()) return undefined;
      return coerceValue(text, t, flag);
    }
    case 'file': {
      const v = await input({ message: `${message} ${c.dim('(file path, or - for stdin)')}`, validate: (s) => (required && !s.trim() ? 'Required' : true) }, promptIO());
      if (!v.trim()) return undefined;
      return coerceValue(v.trim() === '-' ? '@-' : v.trim(), t, flag);
    }
    default: {
      const v = await input({ message: `${message}${t.kind === 'string' ? '' : c.dim(` [${typeLabel(t)}]`)}`, validate: (s) => (required && !s.trim() ? 'Required' : true) }, promptIO());
      if (v === '') return undefined;
      return coerceValue(v, t, flag);
    }
  }
}

function placeholderFor(t: TypeSpec): any {
  switch (t.kind) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return t.enum?.[0] ?? '';
    case 'array':
      return [];
    case 'object':
      return Object.fromEntries((t.props ?? []).filter((p) => p.required).map((p) => [p.name, placeholderFor(p.type)]));
    default:
      return null;
  }
}

function isDnsRecordPositional(p: Positional): boolean {
  return p.name === 'dnsRecordID' || p.cli === 'dns-record-id';
}

/** Prompts for required positionals/params that are still missing (mutates `positionals` and `params`). */
export async function promptMissing(method: MethodNode, positionals: any[], params: Record<string, any>, helpers: PromptHelpers): Promise<void> {
  const props = method.params?.type.props ?? [];
  // Zone/account first so record pickers can search the selected zone.
  for (const p of props) {
    if ((p.name === 'zone_id' || p.name === 'account_id') && p.required && (params[p.name] === undefined || params[p.name] === null)) {
      const v = await promptProp(p, helpers);
      if (v !== undefined) params[p.name] = v;
    }
  }
  for (let i = 0; i < method.positionals.length; i++) {
    const p = method.positionals[i]!;
    if (!p.required || (positionals[i] !== undefined && positionals[i] !== '')) continue;
    if (isDnsRecordPositional(p) && typeof params.zone_id === 'string') {
      const picked = await pickCatalogItem('dns-record', helpers, { zoneId: params.zone_id });
      if (picked) {
        positionals[i] = picked;
        continue;
      }
    }
    positionals[i] = await promptPositional(p);
  }
  for (const p of props) {
    if (p.name === 'zone_id' || p.name === 'account_id') continue;
    if (!p.required || (params[p.name] !== undefined && params[p.name] !== null)) continue;
    const v = await promptProp(p, helpers);
    if (v !== undefined) params[p.name] = v;
  }
}

export async function confirmDestructive(cmd: string, method: MethodNode, params: Record<string, any>): Promise<boolean> {
  const target = [params.zone_id ? `zone ${params.zone_id}` : '', params.account_id ? `account ${params.account_id}` : ''].filter(Boolean).join(', ');
  try {
    return await confirm({ message: `${c.yellow('Destructive:')} ${cmd}${target ? c.dim(` (${target})`) : ''} — continue?`, default: false }, promptIO());
  } catch (err) {
    onCancel(err);
  }
}
