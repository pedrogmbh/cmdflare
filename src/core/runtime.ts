/** Shared runtime helpers for the entry point and builtin commands (kept out of cli.ts to avoid import cycles). */
import pkg from '../../package.json' with { type: 'json' };
import { toCurl, type CapturedRequest } from './client';
import { loadConfig, resolveContext, type Context } from './config';
import { parseFormat, type OutputFormat } from './output';
import { c, log, setColor, setNoInput, setQuiet, setVerbose, stdoutIsTTY } from './ui';

export const VERSION: string = (pkg as any).version ?? '0.0.0';

export type GlobalFlags = Record<string, any>;

export function applyGlobalUi(gf: GlobalFlags) {
  if (gf.color !== undefined) setColor(gf.color);
  if (gf.verbose) setVerbose(true);
  if (gf.quiet) setQuiet(true);
  if (gf['no-input']) setNoInput(true);
}

export function contextFromFlags(gf: GlobalFlags): Context {
  return resolveContext({
    profile: gf.profile,
    token: gf.token,
    apiKey: gf['api-key'],
    email: gf.email,
    account: gf.account,
    zone: gf.zone,
    baseUrl: gf['base-url'],
  });
}

export function decideFormat(gf: GlobalFlags, opts: { rawResponse?: boolean } = {}): OutputFormat {
  if (gf.json) return 'json';
  if (gf.output) return parseFormat(gf.output, 'json');
  if (!stdoutIsTTY()) return 'json';
  if (opts.rawResponse) return 'json';
  const cfgOut = loadConfig().settings?.output;
  if (cfgOut) return parseFormat(cfgOut, 'table');
  return 'table';
}

export function printDryRun(captured: CapturedRequest[], curl: boolean) {
  if (!captured.length) {
    log.warn('No request was captured (the SDK did not issue an HTTP call).');
    return;
  }
  for (const req of captured) {
    if (curl) {
      process.stdout.write(toCurl(req) + '\n');
      continue;
    }
    process.stdout.write(`${c.bold(req.method)} ${req.url}\n`);
    for (const [k, v] of Object.entries(req.headers)) process.stdout.write(c.dim(`  ${k}: ${v}`) + '\n');
    if (req.body !== undefined) {
      let body = req.body;
      try {
        body = JSON.stringify(JSON.parse(req.body), null, 2);
      } catch {
        /* not JSON */
      }
      process.stdout.write('\n' + body + '\n');
    } else if (req.bodyNote) process.stdout.write('\n' + c.dim(req.bodyNote) + '\n');
  }
}
