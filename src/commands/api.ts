/** api: raw REST escape hatch for any endpoint. */
import { ArgvError, parseArgv, type FlagSpec } from '../core/argv';
import { createClient, toCurl, type CapturedRequest } from '../core/client';
import { argvWantsStdin, parseDataArg, prefetchStdin } from '../core/coerce';
import { ID_RE } from '../core/config';
import { CliError, EXIT, UsageError } from '../core/errors';
import { applyQuery, formatOutput, selectFields } from '../core/output';
import { resolveAccountId, resolveZoneId } from '../core/resolve';
import { canPrompt, log, withSpinner } from '../core/ui';
import { BUILTIN_HELP } from './index';
import { GLOBAL_SPECS } from '../core/globals';
import { applyGlobalUi, contextFromFlags, decideFormat, printDryRun } from '../core/runtime';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export async function runApi(args: string[], gf: Record<string, any>, argv: string[], version: string): Promise<number> {
  if (gf.help || !args.length) {
    process.stdout.write(BUILTIN_HELP.api + '\n');
    return gf.help ? EXIT.OK : EXIT.USAGE;
  }
  const extra: FlagSpec[] = [
    { name: 'param', aliases: ['P', 'F', 'f'], type: 'string', multiple: true },
    { name: 'header', aliases: ['H'], type: 'string', multiple: true },
    { name: 'method', aliases: ['X'], type: 'string' },
    { name: 'paginate', type: 'boolean' },
    { name: 'input', type: 'string' },
  ];
  if (argvWantsStdin(argv)) await prefetchStdin();
  let parsed;
  try {
    parsed = parseArgv(argv, [...GLOBAL_SPECS, ...extra]);
  } catch (err) {
    if (err instanceof ArgvError) throw new UsageError(err.message, 'See `cmdflare api --help`.');
    throw err;
  }
  const f = parsed.flags;
  applyGlobalUi(f);
  const pos = parsed.positionals.slice(1); // drop "api"
  let method: string | undefined = f.method?.toUpperCase();
  let path: string | undefined;
  if (pos[0] && METHODS.has(pos[0].toUpperCase())) {
    method = method ?? pos[0].toUpperCase();
    path = pos[1];
  } else {
    path = pos[0];
  }
  if (!path) throw new UsageError('Usage: cmdflare api [METHOD] <path> [-P key=value] [-d body]');
  if (pos.length > 2 || (pos.length === 2 && !METHODS.has(pos[0]!.toUpperCase()))) {
    throw new UsageError(`Unexpected arguments: ${pos.slice(1).join(' ')}`, 'Query/body fields go in -P key=value; the body in -d.');
  }
  for (const u of parsed.unknownOrder) throw new UsageError(`Unknown flag --${u}`, 'See `cmdflare api --help`.');

  const ctx = contextFromFlags(f);
  const dryRun = !!(f['dry-run'] || f.curl);
  const captured: CapturedRequest[] = [];
  const client = await createClient(ctx, { dryRun, captured, version, timeout: f.timeout, maxRetries: f['max-retries'], baseURL: f['base-url'] });
  const realClient = async () => (dryRun ? createClient(ctx, { version }) : client);
  const canResolve = ctx.credentials.kind !== 'none';

  // Strip a full URL down to the path
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    path = u.pathname.replace(/^\/client\/v4/, '') + u.search;
  }
  if (!path.startsWith('/')) path = '/' + path;

  // Placeholders
  if (/\{account_id\}|:account_id/.test(path)) {
    let id = ctx.accountId;
    if (!id && ctx.accountRef) id = canResolve ? await resolveAccountId(realClient, ctx.accountRef) : `<account:${ctx.accountRef}>`;
    if (!id) throw new UsageError('Path needs an account id: pass -A <account id|name> or set CLOUDFLARE_ACCOUNT_ID.');
    path = path.replace(/\{account_id\}|:account_id/g, id);
  }
  if (/\{zone_id\}|:zone_id/.test(path)) {
    let id = ctx.zoneId;
    if (!id && ctx.zoneRef) id = canResolve ? await resolveZoneId(realClient, ctx.zoneRef) : `<zone:${ctx.zoneRef}>`;
    if (!id) throw new UsageError('Path needs a zone id: pass -Z <zone id|name> or set CLOUDFLARE_ZONE_ID.');
    path = path.replace(/\{zone_id\}|:zone_id/g, id);
  }
  // Inline query string in path
  let inlineQuery: Record<string, string> = {};
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) {
    inlineQuery = Object.fromEntries(new URLSearchParams(path.slice(qIdx + 1)).entries());
    path = path.slice(0, qIdx);
  }

  let body: any = undefined;
  const dataArgs: string[] = [...(f.data ?? []), ...(f.input ? [f.input] : [])];
  for (const d of dataArgs) {
    const v = parseDataArg(d, 'data');
    body = body && typeof body === 'object' && v && typeof v === 'object' && !Array.isArray(v) ? { ...body, ...v } : v;
  }
  if (!method) method = body !== undefined || (f.param?.length && false) ? 'POST' : 'GET';
  const query: Record<string, any> = { ...inlineQuery };
  for (const kv of f.param ?? []) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new UsageError(`-P expects key=value, got "${kv}"`);
    const k = kv.slice(0, eq);
    let v: any = kv.slice(eq + 1);
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep string */
      }
    }
    if (method === 'GET' || method === 'DELETE' || method === 'HEAD') query[k] = v;
    else body = { ...(body && typeof body === 'object' ? body : {}), [k]: v };
  }
  const headers: Record<string, string> = {};
  for (const h of f.header ?? []) {
    const i = h.indexOf(':');
    if (i <= 0) throw new UsageError(`-H expects "Name: value", got "${h}"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }

  if (method === 'DELETE' && !f.yes && !dryRun) {
    if (canPrompt()) {
      const { confirm } = await import('@inquirer/prompts');
      const ok = await confirm({ message: `Send DELETE ${path}?`, default: false }, { output: process.stderr, input: process.stdin });
      if (!ok) return EXIT.CANCELLED;
    } else {
      throw new UsageError('DELETE requests need --yes when running non-interactively.');
    }
  }

  const doRequest = (q: Record<string, any>) =>
    client.request({ method: method!.toLowerCase(), path, query: Object.keys(q).length ? q : undefined, body, headers: Object.keys(headers).length ? headers : undefined });

  let envelope: any;
  let results: any[] | undefined;
  await withSpinner(`${method} ${path}…`, async () => {
    envelope = await doRequest(query);
    if (f.paginate && envelope && typeof envelope === 'object' && Array.isArray(envelope.result)) {
      results = [...envelope.result];
      let info = envelope.result_info ?? {};
      let guard = 0;
      while (guard++ < 10000) {
        let nextQuery: Record<string, any> | undefined;
        if (info.total_pages && (info.page ?? 1) < info.total_pages) nextQuery = { ...query, page: (info.page ?? 1) + 1 };
        else if (info.cursors?.after) nextQuery = { ...query, cursor: info.cursors.after };
        else if (info.cursor && envelope.result.length) nextQuery = { ...query, cursor: info.cursor };
        if (!nextQuery) break;
        const next = await doRequest(nextQuery);
        if (!next || !Array.isArray(next.result) || next.result.length === 0) break;
        results.push(...next.result);
        envelope = next;
        info = next.result_info ?? {};
        if (!info.total_pages && !info.cursor && !info.cursors?.after) break;
      }
    }
  });

  if (dryRun) {
    printDryRun(captured, !!f.curl);
    return EXIT.OK;
  }
  if (envelope && typeof envelope === 'object' && envelope.success === false) {
    const errs = Array.isArray(envelope.errors) ? envelope.errors : [];
    throw new CliError(errs.map((e: any) => `[${e.code}] ${e.message}`).join('; ') || 'Request failed');
  }
  let data: any = envelope;
  if (!f['raw-response'] && envelope && typeof envelope === 'object' && 'result' in envelope) data = results ?? envelope.result;
  if (f['include-meta'] && envelope && typeof envelope === 'object') data = { result: data, result_info: envelope.result_info ?? null };
  data = applyQuery(data, f.query);
  const fields = f.fields ? String(f.fields).split(',').map((s: string) => s.trim()) : undefined;
  data = selectFields(data, fields);
  const format = decideFormat(f, { rawResponse: !!f['raw-response'] });
  const text = formatOutput(data, { format, compact: f.compact, fields });
  process.stdout.write(text + '\n');
  if (!f.paginate && envelope?.result_info?.total_pages > 1) log.hint(`Page ${envelope.result_info.page ?? 1}/${envelope.result_info.total_pages}. Use --paginate to fetch all pages.`);
  return EXIT.OK;
}

export { toCurl };
