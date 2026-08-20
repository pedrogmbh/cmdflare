/** Interactive (menu-driven) mode. */
import { checkbox, confirm, search, select } from '@inquirer/prompts';
import { writeFileSync } from 'node:fs';
import { createClient } from '../core/client';
import { resolveContext, type Context } from '../core/config';
import { CliError, EXIT, formatError } from '../core/errors';
import { exampleFor } from '../core/help';
import { invokeMethod } from '../core/invoke';
import { commandPath, countMethods, flattenCommands, getMethodDetail, loadIndex, searchScore, type FlatCommand } from '../core/manifest';
import type { MethodNode, ResourceNode } from '../core/manifest-types';
import { flagName } from '../core/names';
import { formatOutput } from '../core/output';
import { commandLineFor } from '../core/params';
import { resolveAccountId, resolveZoneId } from '../core/resolve';
import { c, log, withSpinner } from '../core/ui';
import { promptIO, promptMissing, promptPositional, promptProp } from './prompts';

export interface InteractiveOptions {
  globals: Record<string, any>;
  version: string;
  startPath?: ResourceNode[];
}

type Pick = { kind: 'method'; path: ResourceNode[]; node: ResourceNode; method: MethodNode } | { kind: 'quit' };

const BACK = Symbol('back');

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const out = (s: string) => process.stderr.write(s + '\n');
  const idx = loadIndex();
  out(`${c.bold('cmdflare')} ${c.dim(`interactive · SDK ${idx.sdkVersion} · ${countMethods(idx.root)} commands · Ctrl+C to quit`)}`);

  let ctx: Context;
  try {
    ctx = resolveContext({ profile: opts.globals.profile, token: opts.globals.token, account: opts.globals.account, zone: opts.globals.zone, baseUrl: opts.globals['base-url'] });
  } catch (err) {
    return reportAndExit(err);
  }
  try {
    if (ctx.credentials.kind === 'none') {
      const doLogin = await confirm({ message: 'No Cloudflare credentials found. Log in now?', default: true }, promptIO());
      if (doLogin) {
        const { runAuth } = await import('../commands/auth');
        const code = await runAuth(['login'], opts.globals, [], opts.version);
        if (code !== EXIT.OK) return code;
        ctx = resolveContext({ profile: opts.globals.profile });
      } else {
        out(c.dim('Continuing without credentials: you can browse commands, but running them will fail.'));
      }
    } else {
      out(c.dim(`Credentials: ${ctx.credentials.kind} via ${ctx.credentials.source}${ctx.accountId || ctx.accountRef ? ` · account ${ctx.accountId ?? ctx.accountRef}` : ''}${ctx.zoneId || ctx.zoneRef ? ` · zone ${ctx.zoneId ?? ctx.zoneRef}` : ''}`));
    }

    let client: any;
    const getClient = async () => (client ??= await createClient(ctx, { version: opts.version }));
    let startPath = opts.startPath;
    for (;;) {
      const pick = startPath ? await browse(startPath) : await pickCommand();
      startPath = undefined;
      if (pick.kind === 'quit') return EXIT.OK;
      try {
        await runPicked(pick, ctx, getClient, opts);
      } catch (err) {
        const f = formatError(err);
        if (f.exitCode === EXIT.CANCELLED) {
          out(c.dim('Cancelled.'));
        } else {
          log.error(f.message);
          if (f.hint) log.hint(f.hint);
        }
      }
      const next = await select(
        { message: 'Next', choices: [{ name: 'Run another command', value: 'again' }, { name: 'Quit', value: 'quit' }] },
        promptIO(),
      );
      if (next === 'quit') return EXIT.OK;
    }
  } catch (err) {
    return reportAndExit(err);
  }
}

function reportAndExit(err: unknown): number {
  const f = formatError(err);
  if (f.exitCode === EXIT.CANCELLED) {
    process.stderr.write(c.dim('\nBye.\n'));
    return EXIT.CANCELLED;
  }
  log.error(f.message);
  if (f.hint) log.hint(f.hint);
  return f.exitCode;
}

async function pickCommand(): Promise<Pick> {
  const all = flattenCommands();
  const root = loadIndex().root;
  const picked = await search<any>(
    {
      message: 'Search commands (e.g. "dns records", "purge cache", "workers list")',
      pageSize: 14,
      source: (term) => {
        const t = (term ?? '').trim();
        const terms = t.split(/\s+/).filter(Boolean);
        const head = [
          { name: `${c.bold('Browse by resource')} ${c.dim('(navigate the tree)')}`, value: { kind: 'browse' } },
        ];
        if (!terms.length) {
          return [
            ...head,
            ...root.children.slice(0, 200).map((ch) => ({ name: `${c.bold(ch.cli)} ${c.dim(`${countMethods(ch)} commands`)}`, value: { kind: 'node', path: [ch] } })),
          ];
        }
        const scored = all
          .map((cmd) => ({ cmd, score: searchScore(cmd, terms) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 40);
        const nodes = root.children.filter((ch) => terms.every((tm) => ch.cli.includes(tm.toLowerCase()))).slice(0, 5);
        return [
          ...nodes.map((ch) => ({ name: `${c.bold(ch.cli)} ${c.dim(`${countMethods(ch)} commands`)}`, value: { kind: 'node', path: [ch] } })),
          ...scored.map(({ cmd }) => ({ name: `${cmd.cli} ${c.dim(cmd.method.summary ?? '')}`.slice(0, 160), value: { kind: 'cmd', cmd }, description: `${cmd.method.http ?? ''} ${cmd.method.path ?? ''}` })),
          ...(scored.length ? [] : [{ name: c.dim('No matches — try other words'), value: { kind: 'none' } }]),
        ];
      },
    },
    promptIO(),
  );
  if (picked.kind === 'cmd') {
    const cmd: FlatCommand = picked.cmd;
    return { kind: 'method', path: cmd.path, node: cmd.node, method: cmd.method };
  }
  if (picked.kind === 'browse') return browse([]);
  if (picked.kind === 'node') return browse(picked.path);
  return pickCommand();
}

async function browse(path: ResourceNode[]): Promise<Pick> {
  const node = path.length ? path[path.length - 1]! : loadIndex().root;
  const choices: any[] = [];
  for (const ch of node.children) choices.push({ name: `${c.bold(ch.cli + '/')} ${c.dim(`${countMethods(ch)} commands`)}`, value: { kind: 'node', node: ch } });
  for (const m of node.methods) choices.push({ name: `${c.green(m.cli)} ${c.dim(m.summary ?? '')}`.slice(0, 160), value: { kind: 'method', method: m }, description: `${m.http ?? ''} ${m.path ?? ''}` });
  choices.push({ name: c.dim(path.length ? '← back' : '← search'), value: { kind: 'back' } });
  choices.push({ name: c.dim('quit'), value: { kind: 'quit' } });
  const picked = await (choices.length > 18 ?
    search<any>(
      {
        message: `${c.bold(commandPath(path) || 'cmdflare')} — choose`,
        pageSize: 14,
        source: (term) => {
          const t = (term ?? '').toLowerCase();
          return choices.filter((ch) => !t || ch.name.toLowerCase().includes(t));
        },
      },
      promptIO(),
    )
  : select<any>({ message: `${c.bold(commandPath(path) || 'cmdflare')} — choose`, choices, pageSize: 18 }, promptIO()));
  if (picked.kind === 'quit') return { kind: 'quit' };
  if (picked.kind === 'back') return path.length ? browse(path.slice(0, -1)) : pickCommand();
  if (picked.kind === 'node') return browse([...path, picked.node]);
  return { kind: 'method', path, node, method: picked.method };
}

async function runPicked(pick: Pick & { kind: 'method' }, ctx: Context, getClient: () => Promise<any>, opts: InteractiveOptions): Promise<void> {
  const method = getMethodDetail(pick.path, pick.method);
  const cp = commandPath(pick.path, method);
  const out = (s: string) => process.stderr.write(s + '\n');
  out('');
  out(`${c.bold(`cmdflare ${cp}`)} ${c.dim(`${method.http ?? ''} ${method.path ?? ''}`)}`);
  if (method.summary) out(c.dim(method.summary));
  if (method.deprecated) out(c.yellow('This command is deprecated.'));

  const positionals: any[] = [];
  for (const p of method.positionals) positionals.push(await promptPositional(p));

  const params: Record<string, any> = {};
  const props = method.params?.type.props ?? [];
  // Context defaults
  if (props.some((p) => p.name === 'account_id')) {
    let id = ctx.accountId;
    if (!id && ctx.accountRef) id = await resolveAccountId(getClient, ctx.accountRef);
    if (id) {
      params.account_id = id;
      out(c.dim(`Using account ${id} (${ctx.accountSource}).`));
    }
  }
  if (props.some((p) => p.name === 'zone_id')) {
    let id = ctx.zoneId;
    if (!id && ctx.zoneRef) id = await resolveZoneId(getClient, ctx.zoneRef);
    if (id) {
      params.zone_id = id;
      out(c.dim(`Using zone ${id} (${ctx.zoneSource}).`));
    }
  }
  await promptMissing(method, positionals, params, { ctx, getClient });

  const optional = props.filter((p) => !p.required && params[p.name] === undefined);
  if (optional.length) {
    const add = await confirm({ message: `Add optional parameters? ${c.dim(`(${optional.length} available)`)}`, default: false }, promptIO());
    if (add) {
      const chosen = await checkbox(
        {
          message: 'Optional parameters',
          pageSize: 15,
          choices: optional.map((p) => ({ name: `${flagName(p.name)} ${c.dim((p.description ?? '').split('\n')[0]!.slice(0, 90))}`, value: p.name })),
        },
        promptIO(),
      );
      for (const name of chosen) {
        const p = optional.find((x) => x.name === name)!;
        const v = await promptProp(p, { ctx, getClient });
        if (v !== undefined) params[p.name] = v;
      }
    }
  }

  const cmdline = commandLineFor(cp, method, positionals, params);
  out('');
  out(`${c.dim('Equivalent command:')}\n  ${c.cyan(cmdline)}`);
  const go = await confirm({ message: method.destructive ? `${c.yellow('Destructive!')} Run it now?` : 'Run it now?', default: !method.destructive }, promptIO());
  if (!go) return;

  if (ctx.credentials.kind === 'none') throw new CliError('No credentials: run `cmdflare auth login` first.', { exitCode: EXIT.AUTH });
  const client = await getClient();
  let result = await withSpinner(`${method.http ?? ''} ${cp}…`, () => invokeMethod(client, pick.node, method, { positionals, params }));
  if (result.binary) {
    const buf = Buffer.from(await result.response!.arrayBuffer());
    const file = `cmdflare-${method.name}-${Date.now()}.bin`;
    writeFileSync(file, buf);
    log.success(`Binary response (${buf.byteLength} bytes) written to ${file}`);
    return;
  }
  if (result.meta?.hasMore) {
    const more = await confirm({ message: `More pages available (${result.meta.result_info?.total_count ?? '?'} total). Fetch all?`, default: false }, promptIO());
    if (more) result = await withSpinner('Fetching all pages…', () => invokeMethod(client, pick.node, method, { positionals, params, all: true }));
  }
  const data = result.data;
  process.stdout.write(formatOutput(data, { format: 'table' }) + '\n');
  const count = Array.isArray(data) ? `${data.length} item(s)` : 'done';
  out(c.dim(count));
  for (;;) {
    const next = await select(
      {
        message: 'Result',
        choices: [
          { name: 'Continue', value: 'continue' },
          { name: 'Show as JSON', value: 'json' },
          { name: 'Save JSON to file', value: 'save' },
          { name: 'Show as YAML', value: 'yaml' },
        ],
      },
      promptIO(),
    );
    if (next === 'continue') break;
    if (next === 'json') process.stdout.write(formatOutput(data, { format: 'json' }) + '\n');
    if (next === 'yaml') process.stdout.write(formatOutput(data, { format: 'yaml' }) + '\n');
    if (next === 'save') {
      const { input } = await import('@inquirer/prompts');
      const file = await input({ message: 'File path', default: `${method.name}.json` }, promptIO());
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      log.success(`Saved to ${file}`);
    }
  }
  out(c.dim(`Tip: non-interactive: ${exampleFor(cp, method)}`));
}
