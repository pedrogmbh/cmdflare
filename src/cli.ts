/** cmdflare — Cloudflare API command line. Entry point. */
import { ArgvError, parseArgv, type FlagSpec } from './core/argv';
import { GLOBAL_SPECS } from './core/globals';
import { createClient, type CapturedRequest } from './core/client';
import { VERSION, applyGlobalUi, contextFromFlags, decideFormat, printDryRun, type GlobalFlags } from './core/runtime';
import { argvWantsStdin, prefetchStdin } from './core/coerce';
import { ID_RE } from './core/config';
import { CliError, EXIT, formatError, UsageError } from './core/errors';
import { renderMethodHelp, renderResourceHelp, renderRootHelp } from './core/help';
import { invokeMethod } from './core/invoke';
import { commandPath, getMethodDetail, resolveCommand, type Resolved } from './core/manifest';
import type { MethodNode, ResourceNode } from './core/manifest-types';
import { applyQuery, formatOutput, selectFields } from './core/output';
import { buildMethodFlagSpecs, buildParams, coercePositional, findMissing } from './core/params';
import { resolveAccountId, resolveZoneId } from './core/resolve';
import { c, canPrompt, log, stderrIsTTY, withSpinner } from './core/ui';
import { runBuiltin, BUILTIN_NAMES } from './commands';


export { GLOBAL_SPECS };


async function run(argv: string[]): Promise<number> {
  if (argvWantsStdin(argv)) await prefetchStdin();
  let g;
  try {
    g = parseArgv(argv, GLOBAL_SPECS);
  } catch (err) {
    if (err instanceof ArgvError) throw new UsageError(err.message, 'Run `cmdflare --help` for usage.');
    throw err;
  }
  applyGlobalUi(g.flags);
  if (g.flags.version) {
    process.stdout.write(`cmdflare ${VERSION}\n`);
    return EXIT.OK;
  }
  const tokens = g.positionals;
  const first = tokens[0];

  if (first && BUILTIN_NAMES.has(first)) {
    return runBuiltin(first, tokens.slice(1), g.flags, argv, VERSION);
  }

  if (!first) {
    if (g.flags.help) {
      process.stdout.write(renderRootHelp(VERSION) + '\n');
      return EXIT.OK;
    }
    if (g.flags.interactive || canPrompt()) {
      const { runInteractive } = await import('./interactive');
      return runInteractive({ globals: g.flags, version: VERSION });
    }
    process.stdout.write(renderRootHelp(VERSION) + '\n');
    return EXIT.OK;
  }

  const res = resolveCommand(tokens);
  if (!res.ok) {
    const where = res.path.length ? `under "${commandPath(res.path)}"` : 'at the top level';
    const hint =
      (res.suggestions.length ? `Did you mean: ${res.suggestions.map((s) => c.cyan(s)).join(', ')}?  ` : '') +
      `Try \`cmdflare ${res.path.length ? commandPath(res.path) + ' ' : ''}--help\` or \`cmdflare search ${res.token}\`.`;
    throw new UsageError(`Unknown command "${res.token}" ${where}.`, hint);
  }
  if (!res.method) {
    if (g.flags.help) {
      process.stdout.write(renderResourceHelp(res.path, res.node) + '\n');
      return EXIT.OK;
    }
    if (g.flags.interactive || canPrompt()) {
      const { runInteractive } = await import('./interactive');
      return runInteractive({ globals: g.flags, version: VERSION, startPath: res.path });
    }
    process.stderr.write(renderResourceHelp(res.path, res.node) + '\n');
    return EXIT.USAGE;
  }
  const method = getMethodDetail(res.path, res.method);
  if (g.flags.help) {
    process.stdout.write(renderMethodHelp(res.path, method) + '\n');
    return EXIT.OK;
  }
  return runMethod(res, method, argv, g.flags);
}

export async function runMethod(res: Resolved, method: MethodNode, argv: string[], gf1: GlobalFlags): Promise<number> {
  const path = res.path;
  const node = res.node;
  const cp = commandPath(path, method);
  const globalNames = new Set(GLOBAL_SPECS.map((s) => s.name));
  const { specs: paramSpecs, props, collisions } = buildMethodFlagSpecs(method, globalNames);
  // Method params win over same-named global flags; globals stay reachable via short form or --cf-<name>.
  const globals2: FlagSpec[] = GLOBAL_SPECS.map((s) =>
    collisions.includes(s.name) ?
      { ...s, name: 'cf-' + s.name, id: s.name, aliases: (s.aliases ?? []).filter((a) => a.length === 1) }
    : { ...s, aliases: [...(s.aliases ?? []), 'cf-' + s.name] },
  );
  let parsed;
  try {
    parsed = parseArgv(argv, [...globals2, ...paramSpecs]);
  } catch (err) {
    if (err instanceof ArgvError) throw new UsageError(err.message, `Run \`cmdflare ${cp} --help\` for usage.`);
    throw err;
  }
  const gf = parsed.flags;
  applyGlobalUi(gf);

  // Positionals
  const restPos = parsed.positionals.slice(path.length + 1);
  if (restPos.length > method.positionals.length) {
    const extra = restPos.slice(method.positionals.length);
    throw new UsageError(
      `Too many arguments: ${extra.map((e) => JSON.stringify(e)).join(', ')}.`,
      method.positionals.length ?
        `This command takes ${method.positionals.length} argument(s): ${method.positionals.map((p) => `<${p.cli}>`).join(' ')}. Parameters are passed as --flags (see \`cmdflare ${cp} --help\`).`
      : `This command takes no positional arguments; parameters are passed as --flags (see \`cmdflare ${cp} --help\`).`,
    );
  }
  const positionals: any[] = restPos.map((r, i) => coercePositional(r, method.positionals[i]!));

  // Context & client
  const ctx = contextFromFlags(gf);
  const dryRun = !!(gf['dry-run'] || gf.curl);
  const captured: CapturedRequest[] = [];
  const clientOpts = { dryRun, timeout: gf.timeout, maxRetries: gf['max-retries'], captured, version: VERSION, baseURL: gf['base-url'] };
  let client: any;
  const getClient = async () => (client ??= await createClient(ctx, clientOpts));
  const getRealClient = async () => (dryRun ? createClient(ctx, { ...clientOpts, dryRun: false }) : getClient());
  const canResolve = ctx.credentials.kind !== 'none';

  let accountId = ctx.accountId;
  let zoneId = ctx.zoneId;
  if (props.has('account_id') && !accountId && ctx.accountRef) {
    accountId = canResolve ? await resolveAccountId(getRealClient, ctx.accountRef) : `<account:${ctx.accountRef}>`;
  }
  if (props.has('zone_id') && !zoneId && ctx.zoneRef) {
    zoneId = canResolve ? await resolveZoneId(getRealClient, ctx.zoneRef) : `<zone:${ctx.zoneRef}>`;
  }

  const params = buildParams({
    method,
    flags: gf,
    unknown: parsed.unknown,
    data: gf.data,
    sets: gf.set,
    accountId,
    zoneId,
  });
  // Names given directly to --zone-id/--account-id are resolved too.
  if (typeof params.zone_id === 'string' && !ID_RE.test(params.zone_id) && !params.zone_id.startsWith('<') && canResolve) {
    params.zone_id = await resolveZoneId(getRealClient, params.zone_id);
  }
  if (typeof params.account_id === 'string' && !ID_RE.test(params.account_id) && !params.account_id.startsWith('<') && canResolve) {
    params.account_id = await resolveAccountId(getRealClient, params.account_id);
  }
  if (params.account && typeof params.account === 'object' && typeof params.account.id === 'string' && !ID_RE.test(params.account.id) && canResolve) {
    params.account.id = await resolveAccountId(getRealClient, params.account.id);
  }

  // Missing required inputs: prompt on a TTY, fail otherwise.
  let missing = findMissing(method, positionals, params);
  if (missing.positionals.length || missing.props.length) {
    if (canPrompt()) {
      const { promptMissing } = await import('./interactive/prompts');
      await promptMissing(method, positionals, params, { ctx, getClient: getRealClient });
      missing = findMissing(method, positionals, params);
    }
    if (missing.positionals.length || missing.props.length) {
      const parts = [
        ...missing.positionals.map((p) => `<${p.cli}>`),
        ...missing.props.map((p) =>
          p.name === 'zone_id' ? '--zone <name|id> (or CLOUDFLARE_ZONE_ID)'
          : p.name === 'account_id' ? '--account <name|id> (or CLOUDFLARE_ACCOUNT_ID)'
          : `--${p.name.replace(/_/g, '-')}`,
        ),
      ];
      throw new UsageError(`Missing required: ${parts.join(', ')}`, `See \`cmdflare ${cp} --help\`. You can also pass everything at once with --data '{...}'.`);
    }
  }

  // Destructive confirmation
  if (method.destructive && !gf.yes && !dryRun) {
    if (canPrompt()) {
      const { confirmDestructive } = await import('./interactive/prompts');
      const ok = await confirmDestructive(`cmdflare ${cp}${positionals.length ? ' ' + positionals.join(' ') : ''}`, method, params);
      if (!ok) {
        log.info('Aborted.');
        return EXIT.CANCELLED;
      }
    } else {
      throw new UsageError(`"${cp}" is destructive; pass --yes to run it non-interactively.`);
    }
  }

  const rawResponse = !!gf['raw-response'];
  const format = decideFormat(gf, { rawResponse });
  const fields: string[] | undefined = gf.fields ? String(gf.fields).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined;
  const limit: number | undefined = gf.limit ?? (typeof params.limit === 'number' ? params.limit : undefined);
  const streaming = format === 'ndjson' && !gf.query && !fields && !!method.paginated && !!gf.all && !gf['include-meta'];

  const outFile: string | undefined = gf['output-file'];
  const write = (text: string) => {
    if (outFile) require('node:fs').writeFileSync(outFile, text);
    else process.stdout.write(text);
  };

  const spinnerText = `${method.http ?? ''} ${cp}…`;
  const doInvoke = async () =>
    invokeMethod(await getClient(), node, method, {
      positionals,
      params,
      all: !!gf.all,
      limit,
      rawResponse,
      onItem: streaming ? (item) => process.stdout.write(JSON.stringify(item) + '\n') : undefined,
    });
  const result = streaming || dryRun ? await doInvoke() : await withSpinner(spinnerText, doInvoke);

  if (dryRun) {
    printDryRun(captured, !!gf.curl);
    return EXIT.OK;
  }
  if (result.binary) {
    const res = result.response!;
    const buf = Buffer.from(await res.arrayBuffer());
    if (outFile) {
      require('node:fs').writeFileSync(outFile, buf);
      log.success(`Wrote ${buf.byteLength} bytes to ${outFile}`);
    } else process.stdout.write(buf);
    return EXIT.OK;
  }
  if (streaming) return EXIT.OK;

  let data = result.data;
  if (gf['include-meta']) data = { result: data, result_info: result.meta?.result_info ?? null, has_more: result.meta?.hasMore ?? false };
  data = applyQuery(data, gf.query);
  data = selectFields(data, fields);
  const text = formatOutput(data, { format, query: gf.query, fields, compact: gf.compact });
  write(text + (text.endsWith('\n') ? '' : '\n'));
  if (outFile) log.success(`Wrote output to ${outFile}`);

  if (result.meta?.hasMore && !gf.all && stderrIsTTY()) {
    const ri = result.meta.result_info ?? {};
    const total = ri.total_count ?? ri.count;
    const pages = ri.total_pages;
    log.hint(
      `Showing ${result.meta.count ?? data?.length ?? '?'}${total ? ` of ${total}` : ''} item(s)${pages ? ` (page ${ri.page ?? 1}/${pages})` : ''}. Use --all to fetch every page${limit ? '' : ', --limit <n> to cap'}.`,
    );
  }
  return EXIT.OK;
}

export function reportError(err: unknown): number {
  const f = formatError(err);
  log.error(f.message);
  if (f.hint) log.hint(f.hint);
  if (err instanceof CliError && err.details) log.hint(typeof err.details === 'string' ? err.details : JSON.stringify(err.details));
  if (process.env.CMDFLARE_DEBUG && err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  return f.exitCode;
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    return reportError(err);
  }
}

const code = await main(process.argv.slice(2));
await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
process.exit(code);
