import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ROOT, ok, runCli, startFakeApi } from './helpers';

describe('cli basics', () => {
  test('--version and --help', async () => {
    expect((await runCli(['--version'])).stdout).toMatch(/^cmdflare \d+\.\d+\.\d+/);
    const h = await runCli(['--help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('API resources');
    expect(h.stdout).toContain('dns');
  });
  test('resource and method help', async () => {
    const r = await runCli(['dns', 'records', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Commands:');
    const m = await runCli(['dns', 'records', 'list', '--help']);
    expect(m.stdout).toContain('GET /zones/{zone_id}/dns_records');
    expect(m.stdout).toContain('--per-page');
  });
  test('no args without a TTY prints help', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });
  test('partial command without TTY prints resource help to stderr with exit 2', async () => {
    const r = await runCli(['dns']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Subresources');
  });
  test('unknown command suggests', async () => {
    const r = await runCli(['dns', 'recrods', 'list']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('records');
  });
  test('missing required → usage error', async () => {
    const r = await runCli(['dns', 'records', 'get']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('<dns-record-id>');
    expect(r.stderr).toContain('--zone');
  });
  test('too many args / unknown flag', async () => {
    expect((await runCli(['zones', 'list', 'extra'])).stderr).toContain('Too many arguments');
    const r = await runCli(['zones', 'list', '--nope', '1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown flag --nope');
  });
  test('no credentials → exit 3', async () => {
    const r = await runCli(['zones', 'list'], { env: { CLOUDFLARE_API_TOKEN: undefined } });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('No Cloudflare credentials');
  });
  test('search', async () => {
    const r = await runCli(['search', 'purge', 'cache', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)[0].command).toBe('cache purge');
  });
  test('completion query', async () => {
    expect((await runCli(['__complete', '--', 'dns', 'rec'])).stdout.trim().split('\n')).toContain('records');
    expect((await runCli(['__complete', '--', 'dns', 'records', 'list', '--per'])).stdout).toContain('--per-page');
    expect((await runCli(['completion', 'zsh'])).stdout).toContain('compdef');
  });
  test('config set/get in isolated config dir', async () => {
    expect((await runCli(['config', 'set', 'zone_id', 'a'.repeat(32)])).code).toBe(0);
    expect((await runCli(['config', 'get', 'zone_id'])).stdout.trim()).toBe('a'.repeat(32));
    const st = await runCli(['auth', 'status', '-o', 'json', '--base-url', 'http://127.0.0.1:1']);
    expect(JSON.parse(st.stdout).zone_id).toBe('a'.repeat(32));
    expect((await runCli(['config', 'unset', 'zone_id'])).code).toBe(0);
  });
});

describe('dry-run request building', () => {
  const zone = '023e105f4ecef8ad9ca31a8372d0c353';
  test('list with query params', async () => {
    const r = await runCli(['dns', 'records', 'list', '--zone', zone, '--per-page', '5', '--type', 'A', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`GET https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?`);
    expect(r.stdout).toContain('per_page=5');
    expect(r.stdout).toContain('type=A');
    expect(r.stdout).toContain('authorization: Bearer test…7890');
  });
  test('create with typed flags, nested flags, arrays, data merge and stdin', async () => {
    const r = await runCli(
      ['dns', 'records', 'create', '-Z', zone, '--type', 'A', '--name', 'www', '--content', '1.2.3.4', '--ttl', '1', '--proxied', '--settings.ipv4-only', 'true', '--tags', 'a,b', '--comment', '@-', '-d', '{"priority":5}', '--dry-run'],
      { input: 'from stdin\n' },
    );
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(body).toEqual({ priority: 5, type: 'A', name: 'www', content: '1.2.3.4', ttl: 1, proxied: true, tags: ['a', 'b'], comment: 'from stdin', settings: { ipv4_only: true } });
  });
  test('account default from env and positional ids', async () => {
    const acc = 'a'.repeat(32);
    const r = await runCli(['workers', 'scripts', 'get', 'my-script', '--dry-run'], { env: { CLOUDFLARE_ACCOUNT_ID: acc } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`/accounts/${acc}/workers/scripts/my-script`);
  });
  test('--curl output', async () => {
    const r = await runCli(['zones', 'list', '--curl']);
    expect(r.stdout.startsWith("curl -X GET 'https://api.cloudflare.com/client/v4/zones'")).toBe(true);
  });
  test('multipart upload (kv put) from a file', async () => {
    const r = await runCli(['kv', 'namespaces', 'values', 'update', 'my-key', '--namespace-id', 'ns1', '--value', join(ROOT, 'package.json'), '--metadata', '{"a":1}', '--dry-run'], {
      env: { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`PUT https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/storage/kv/namespaces/ns1/values/my-key`);
    expect(r.stdout).toContain('multipart/form-data');
  });
  test('destructive without --yes fails non-interactively; --yes proceeds', async () => {
    const r = await runCli(['dns', 'records', 'delete', 'rec1', '-Z', zone]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    const ok2 = await runCli(['dns', 'records', 'delete', 'rec1', '-Z', zone, '--yes', '--dry-run']);
    expect(ok2.code).toBe(0);
    expect(ok2.stdout).toContain(`DELETE https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/rec1`);
  });
  test('param shadows global (--data) and -d still works', async () => {
    const r = await runCli(['dns', 'records', 'create', '-Z', zone, '--type', 'CAA', '--name', 'x', '--ttl', '1', '--data', '{"flags":0,"tag":"issue","value":"ca"}', '-d', '{"comment":"c"}', '--dry-run']);
    const body = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(body.data).toEqual({ flags: 0, tag: 'issue', value: 'ca' });
    expect(body.comment).toBe('c');
  });
  test('api command', async () => {
    const r = await runCli(['api', 'POST', '/zones/{zone_id}/purge_cache', '-Z', zone, '-d', '{"purge_everything":true}', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`POST https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`);
    expect(r.stdout).toContain('"purge_everything": true');
    const g = await runCli(['api', '/zones?status=active', '-P', 'per_page=2', '--curl']);
    expect(g.stdout).toContain("/zones?status=active&per_page=2'");
  });
});

describe('against a fake API', () => {
  const zonesPage = (page: number) => ({
    result: [
      { id: `id${page}a`, name: `zone${page}a.com`, status: 'active', account: { id: 'acc', name: 'Acme' } },
      { id: `id${page}b`, name: `zone${page}b.com`, status: 'pending', account: { id: 'acc', name: 'Acme' } },
    ],
    result_info: { page, per_page: 2, total_pages: 3, total_count: 6, count: 2 },
  });
  let api: ReturnType<typeof startFakeApi>;
  beforeAll(() => {
    api = startFakeApi((req, url) => {
      if (url.pathname === '/client/v4/zones' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        if (url.searchParams.get('name') === 'example.com') return ok([{ id: 'e'.repeat(32), name: 'example.com', account: { id: 'acc' } }], { result_info: { page: 1, total_pages: 1 } });
        if (page > 3) return ok([], { result_info: { page, per_page: 2, total_pages: 3, total_count: 6, count: 0 } });
        const p = zonesPage(page);
        return ok(p.result, { result_info: p.result_info });
      }
      if (url.pathname === `/client/v4/zones/${'e'.repeat(32)}/dns_records` && req.method === 'POST') {
        return ok({ id: 'newrec', name: 'www.example.com', type: 'A', content: '1.2.3.4' });
      }
      if (url.pathname === `/client/v4/zones/${'e'.repeat(32)}/dns_records/rec1` && req.method === 'DELETE') {
        return ok({ id: 'rec1' });
      }
      if (url.pathname === '/client/v4/user/tokens/verify') {
        if (req.headers.get('authorization') === 'Bearer good-token') return ok({ id: 'tok1', status: 'active', expires_on: '2030-01-01T00:00:00Z' });
        return Response.json({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }], messages: [], result: null }, { status: 401 });
      }
      const CFAT = 'cfat_' + 'x'.repeat(40) + 'abcd';
      const ACC = 'a'.repeat(32);
      if (url.pathname === `/client/v4/accounts/${ACC}/tokens/verify`) {
        if (req.headers.get('authorization') === `Bearer ${CFAT}`) return ok({ id: 'acctok1', status: 'active' });
        return Response.json({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }], messages: [], result: null }, { status: 401 });
      }
      if (url.pathname === `/client/v4/accounts/${ACC}` && req.method === 'GET') {
        if (req.headers.get('authorization') === `Bearer ${CFAT}`) return ok({ id: ACC, name: 'UNFLD', type: 'standard' });
      }
      if (url.pathname === '/client/v4/accounts' && req.method === 'GET') {
        if (req.headers.get('authorization') === `Bearer ${CFAT}`) {
          return ok([{ id: ACC, name: 'UNFLD' }], { result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 1, count: 1 } });
        }
      }
      if (url.pathname === '/client/v4/zones/missing') {
        return Response.json({ success: false, errors: [{ code: 7003, message: 'Could not route to /zones/missing' }], messages: [], result: null }, { status: 404 });
      }
      return undefined;
    });
  });
  afterAll(() => api.stop());
  const env = () => ({ CLOUDFLARE_BASE_URL: api.baseURL });

  test('list first page, hint about more; json default when piped', async () => {
    const r = await runCli(['zones', 'list'], { env: env() });
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe('zone1a.com');
  });
  test('--all paginates, --limit caps, --query/--fields/-o formats', async () => {
    const all = await runCli(['zones', 'list', '--all'], { env: env() });
    expect(JSON.parse(all.stdout)).toHaveLength(6);
    const lim = await runCli(['zones', 'list', '--all', '--limit', '3', '-o', 'id'], { env: env() });
    expect(lim.stdout.trim().split('\n')).toEqual(['id1a', 'id1b', 'id2a']);
    const q = await runCli(['zones', 'list', '-q', '[?status==active].name'], { env: env() });
    expect(JSON.parse(q.stdout)).toEqual(['zone1a.com']);
    const csv = await runCli(['zones', 'list', '-o', 'csv', '--fields', 'id,account.name'], { env: env() });
    expect(csv.stdout.trim()).toBe('id,account.name\nid1a,Acme\nid1b,Acme');
    const tbl = await runCli(['zones', 'list', '-o', 'table'], { env: env() });
    expect(tbl.stdout.split('\n')[0]).toMatch(/^id\s+name\s+status/);
    const meta = await runCli(['zones', 'list', '--include-meta'], { env: env() });
    expect(JSON.parse(meta.stdout).result_info.total_pages).toBe(3);
    const nd = await runCli(['zones', 'list', '--all', '-o', 'ndjson'], { env: env() });
    expect(nd.stdout.trim().split('\n')).toHaveLength(6);
    const raw = await runCli(['zones', 'list', '--raw-response'], { env: env() });
    expect(JSON.parse(raw.stdout).success).toBe(true);
  });
  test('zone name resolution, create, delete with --yes', async () => {
    const c = await runCli(['dns', 'records', 'create', '--zone', 'example.com', '--type', 'A', '--name', 'www', '--content', '1.2.3.4', '--ttl', '1'], { env: env() });
    expect(c.code).toBe(0);
    expect(JSON.parse(c.stdout).id).toBe('newrec');
    const d = await runCli(['dns', 'records', 'delete', 'rec1', '--zone', 'example.com', '--yes'], { env: env() });
    expect(d.code).toBe(0);
    expect(JSON.parse(d.stdout).id).toBe('rec1');
    const missing = await runCli(['dns', 'records', 'create', '--zone', 'nope.com', '--type', 'A', '--name', 'www', '--ttl', '1'], { env: env() });
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('No zone named "nope.com"');
  });
  test('api errors map to exit codes', async () => {
    const r = await runCli(['api', 'GET', '/zones/missing'], { env: env() });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('7003');
    const a = await runCli(['auth', 'status', '-o', 'json'], { env: { ...env(), CLOUDFLARE_API_TOKEN: 'bad' } });
    expect(a.code).toBe(3);
    expect(JSON.parse(a.stdout).status).toBe('invalid');
    const good = await runCli(['auth', 'status', '-o', 'json'], { env: { ...env(), CLOUDFLARE_API_TOKEN: 'good-token' } });
    expect(good.code).toBe(0);
    expect(JSON.parse(good.stdout)).toMatchObject({ status: 'active', token_id: 'tok1', token_kind: 'user' });
  });
  test('account-owned cfat_ token verifies via /accounts/.../tokens/verify, not /user/tokens/verify', async () => {
    const CFAT = 'cfat_' + 'x'.repeat(40) + 'abcd';
    const ACC = 'a'.repeat(32);
    const st = await runCli(['auth', 'status', '-o', 'json'], {
      env: { ...env(), CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_TOKEN: CFAT, CLOUDFLARE_ACCOUNT_ID: ACC },
    });
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout)).toMatchObject({ status: 'active', token_kind: 'account', token_format: 'account', token_id: 'acctok1', account_id: ACC });
    const login = await runCli(['auth', 'login', '--token', CFAT, '-p', 'acct'], { env: env() });
    expect(login.code).toBe(0);
    expect(login.stderr).toContain('account-owned token');
  });
  test('auth login non-interactive stores the token in the profile', async () => {
    const r = await runCli(['auth', 'login', '--token', 'good-token', '-p', 'ci'], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Logged in');
    const st = await runCli(['auth', 'status', '-o', 'json', '-p', 'ci'], { env: { ...env(), CLOUDFLARE_API_TOKEN: undefined } });
    expect(JSON.parse(st.stdout)).toMatchObject({ profile: 'ci', credentials: 'token', status: 'active' });
    expect((await runCli(['auth', 'logout', '-p', 'ci'])).code).toBe(0);
    expect(JSON.parse((await runCli(['auth', 'status', '-o', 'json', '-p', 'ci'], { env: { CLOUDFLARE_API_TOKEN: undefined } })).stdout).credentials).toBe('none');
  });
});
