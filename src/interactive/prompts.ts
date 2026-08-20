/** Prompt helpers shared by interactive mode and the "missing required value" fallback. */
import { checkbox, confirm, editor, input, search, select } from '@inquirer/prompts';
import { sdkModules } from '../generated/modules';
import { coerceValue } from '../core/coerce';
import type { Context } from '../core/config';
import { CliError, EXIT } from '../core/errors';
import { typeLabel } from '../core/help';
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

async function pickFromApi(kind: 'zone' | 'account', helpers: PromptHelpers): Promise<string | undefined> {
  if (!helpers.getClient || !helpers.ctx || helpers.ctx.credentials.kind === 'none') return undefined;
  try {
    const client = await helpers.getClient();
    const items: any[] = await withSpinner(`Loading ${kind}s…`, async () => {
      if (kind === 'zone') {
        const mod = await sdkModules['resources/zones/zones']!();
        const page = await new mod.Zones(client).list({ per_page: 50 });
        return page.getPaginatedItems();
      }
      const mod = await sdkModules['resources/accounts/accounts']!();
      const page = await new mod.Accounts(client).list({ per_page: 50 });
      return page.getPaginatedItems();
    });
    if (!items.length) return undefined;
    const choices = items.map((it) => ({ name: `${it.name} ${c.dim(it.id)}`, value: String(it.id) }));
    const manual = { name: c.dim('(type an id manually)'), value: '' };
    const picked = await search(
      {
        message: `Select ${kind}`,
        source: (term) => {
          const t = (term ?? '').toLowerCase();
          return [...choices.filter((ch) => ch.name.toLowerCase().includes(t)), manual];
        },
        pageSize: 12,
      },
      promptIO(),
    );
    return picked || undefined;
  } catch (err: any) {
    if (err?.name === 'ExitPromptError') onCancel(err);
    log.debug(`Could not list ${kind}s: ${err?.message}`);
    return undefined;
  }
}

export async function promptProp(p: ParamProp, helpers: PromptHelpers = {}): Promise<any> {
  const label = `--${flagName(p.name)}`;
  const desc = shortDesc(p.description);
  const message = `${label}${p.required ? '' : c.dim(' (optional)')}${desc ? c.dim(' — ' + desc) : ''}`;
  try {
    if (p.name === 'zone_id' || p.name === 'account_id') {
      const picked = await pickFromApi(p.name === 'zone_id' ? 'zone' : 'account', helpers);
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

/** Prompts for required positionals/params that are still missing (mutates `positionals` and `params`). */
export async function promptMissing(method: MethodNode, positionals: any[], params: Record<string, any>, helpers: PromptHelpers): Promise<void> {
  for (let i = 0; i < method.positionals.length; i++) {
    const p = method.positionals[i]!;
    if (p.required && (positionals[i] === undefined || positionals[i] === '')) positionals[i] = await promptPositional(p);
  }
  for (const p of method.params?.type.props ?? []) {
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
