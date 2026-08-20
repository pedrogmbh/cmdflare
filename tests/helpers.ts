import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');
export const CLI = join(ROOT, 'src/cli.ts');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const tmpHome = mkdtempSync(join(tmpdir(), 'cmdflare-test-'));

export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('CLOUDFLARE_') || k.startsWith('CF_') || k.startsWith('CMDFLARE_')) continue;
    env[k] = v;
  }
  env.NO_COLOR = '1';
  env.CMDFLARE_NO_INPUT = '1';
  env.CMDFLARE_CONFIG_DIR = join(tmpHome, 'config');
  env.CMDFLARE_CACHE_DIR = join(tmpHome, 'cache');
  env.CLOUDFLARE_API_TOKEN = 'test-token-1234567890';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export async function runCli(args: string[], opts: { env?: Record<string, string | undefined>; input?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: cleanEnv(opts.env),
    stdin: opts.input !== undefined ? Buffer.from(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: tmpHome, // not ROOT: Bun would auto-load the project's .env into the child
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export type Handler = (req: Request, url: URL) => Response | Promise<Response> | undefined;

/** Starts a fake Cloudflare API; returns base URL (…/client/v4) and a stop function. */
export function startFakeApi(handler: Handler): { baseURL: string; stop: () => void; requests: Array<{ method: string; path: string; body: string; headers: Headers }> } {
  const requests: Array<{ method: string; path: string; body: string; headers: Headers }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      requests.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
      const res = await handler(new Request(req.url, { method: req.method, headers: req.headers, body: body || undefined }), url);
      return res ?? Response.json({ success: false, errors: [{ code: 7000, message: 'No route' }], messages: [], result: null }, { status: 404 });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/client/v4`,
    stop: () => server.stop(true),
    requests,
  };
}

export const ok = (result: unknown, extra: Record<string, unknown> = {}) => Response.json({ success: true, errors: [], messages: [], result, ...extra });
