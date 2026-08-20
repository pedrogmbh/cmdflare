/** Cloudflare SDK client construction (lazy), request capture for --dry-run/--curl, and resource instantiation. */
import { sdkModules } from '../generated/modules';
import type { Context } from './config';
import { requireCredentials } from './config';
import { CliError } from './errors';
import type { ResourceNode } from './manifest-types';
import { log } from './ui';

export const USER_AGENT_PREFIX = 'cmdflare';

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyNote?: string;
}

export interface ClientOptions {
  dryRun?: boolean;
  timeout?: number;
  maxRetries?: number;
  baseURL?: string;
  captured?: CapturedRequest[];
  version?: string;
}

const REDACT = new Set(['authorization', 'x-auth-key', 'x-auth-email', 'x-auth-user-service-key']);

async function describeBody(body: any): Promise<{ body?: string; bodyNote?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') return { body };
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    body.forEach((v, k) => {
      if (typeof v === 'string') parts.push(`${k}=${v.length > 200 ? v.slice(0, 200) + '…' : v}`);
      else parts.push(`${k}=@<file${(v as any).name ? ':' + (v as any).name : ''}>`);
    });
    return { bodyNote: `multipart/form-data: ${parts.join('; ')}` };
  }
  if (body instanceof Uint8Array) return { bodyNote: `<${body.byteLength} bytes>` };
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { bodyNote: `<blob ${body.size} bytes>` };
  if (typeof body === 'object' && typeof (body as any).getReader === 'function') return { bodyNote: '<stream>' };
  try {
    return { body: JSON.stringify(body) };
  } catch {
    return { bodyNote: `<${typeof body}>` };
  }
}

function headersToObject(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    h.forEach((v: string, k: string) => {
      out[k] = REDACT.has(k.toLowerCase()) ? redact(v) : v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = REDACT.has(String(k).toLowerCase()) ? redact(String(v)) : String(v);
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = REDACT.has(k.toLowerCase()) ? redact(String(v)) : String(v);
  return out;
}

function redact(v: string): string {
  if (v.toLowerCase().startsWith('bearer ')) return 'Bearer ' + mask(v.slice(7));
  return mask(v);
}
function mask(s: string): string {
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

export function makeFetch(opts: ClientOptions): typeof fetch {
  const real = globalThis.fetch;
  return (async (input: any, init?: any) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input?.url ?? String(input));
    log.debug(`> ${method} ${url}`);
    if (opts.dryRun) {
      const { body, bodyNote } = await describeBody(init?.body);
      opts.captured?.push({ method, url, headers: headersToObject(init?.headers), body, bodyNote });
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: [], result_info: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const t0 = performance.now();
    const res = await real(input, init);
    log.debug(`< ${res.status} ${res.statusText} (${(performance.now() - t0).toFixed(0)}ms) ${res.headers.get('cf-ray') ? 'cf-ray=' + res.headers.get('cf-ray') : ''}`);
    return res;
  }) as typeof fetch;
}

export async function createClient(ctx: Context, opts: ClientOptions = {}): Promise<any> {
  const { BaseCloudflare } = await import('cloudflare/client');
  let creds = ctx.credentials;
  if (creds.kind === 'none') {
    if (opts.dryRun) creds = { kind: 'token', apiToken: 'DRY-RUN-NO-TOKEN', source: 'dry-run' };
    else creds = requireCredentials(ctx);
  }
  const client = new BaseCloudflare({
    apiToken: creds.apiToken ?? null,
    apiKey: creds.apiKey ?? null,
    apiEmail: creds.email ?? null,
    userServiceKey: creds.userServiceKey ?? null,
    baseURL: opts.baseURL ?? ctx.baseURL ?? undefined,
    timeout: opts.timeout,
    maxRetries: opts.maxRetries,
    fetch: makeFetch(opts),
    defaultHeaders: { 'User-Agent': `${USER_AGENT_PREFIX}/${opts.version ?? '0'}` },
  });
  return client;
}

const resourceCache = new WeakMap<object, Map<string, any>>();

/** Instantiates only the SDK resource class needed for a command (avoids loading the entire SDK). */
export async function instantiateResource(client: any, node: ResourceNode): Promise<any> {
  let perClient = resourceCache.get(client);
  if (!perClient) resourceCache.set(client, (perClient = new Map()));
  const key = `${node.module}#${node.className}`;
  if (perClient.has(key)) return perClient.get(key);
  const loader = sdkModules[node.module];
  if (!loader) throw new CliError(`SDK module not found for ${node.module}. Re-run \`bun run gen\` after upgrading the cloudflare package.`);
  const mod = await loader();
  const Cls = mod[node.className] ?? mod.default?.[node.className];
  if (typeof Cls !== 'function') throw new CliError(`SDK class ${node.className} not exported by ${node.module}.`);
  const inst = new Cls(client);
  perClient.set(key, inst);
  return inst;
}

export function toCurl(req: CapturedRequest): string {
  const parts = [`curl -X ${req.method} '${req.url.replace(/'/g, "'\\''")}'`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'accept-encoding') continue;
    parts.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
  }
  if (req.body !== undefined) parts.push(`  --data '${req.body.replace(/'/g, "'\\''")}'`);
  else if (req.bodyNote) parts.push(`  # body: ${req.bodyNote}`);
  return parts.join(' \\\n');
}
