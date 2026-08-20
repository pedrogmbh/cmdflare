import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { itemMatches, listDnsRecords, listZones, mergeById, zoneNameQuery } from '../src/core/catalog';
import { createClient } from '../src/core/client';
import type { Context } from '../src/core/config';
import { collectPaginatedItems } from '../src/core/invoke';
import { ok, startFakeApi } from './helpers';

function mockPage(items: string[], page: number, totalPages: number, totalCount: number, next: (() => Promise<any>) | null) {
  return {
    result_info: { page, per_page: items.length, total_pages: totalPages, total_count: totalCount, count: items.length },
    getPaginatedItems: () => items,
    getNextPage: async () => {
      if (!next) throw new Error(`unexpected getNextPage from page ${page}`);
      return next();
    },
  };
}

describe('catalog helpers', () => {
  test('zoneNameQuery uses contains unless an operator is already present', () => {
    expect(zoneNameQuery('example')).toBe('contains:example');
    expect(zoneNameQuery('  Foo.COM ')).toBe('contains:Foo.COM');
    expect(zoneNameQuery('starts_with:ex')).toBe('starts_with:ex');
    expect(zoneNameQuery('contains:ex')).toBe('contains:ex');
    expect(zoneNameQuery('')).toBe('');
  });

  test('itemMatches looks at name, id, type and content', () => {
    const rec = { id: 'abc123', name: 'www.example.com', type: 'A', content: '203.0.113.10' };
    expect(itemMatches(rec, 'www')).toBe(true);
    expect(itemMatches(rec, '203.0.113')).toBe(true);
    expect(itemMatches(rec, 'abc')).toBe(true);
    expect(itemMatches(rec, 'aaaa')).toBe(false);
  });

  test('mergeById keeps first occurrence', () => {
    const a = { id: '1', name: 'a' };
    const b = { id: '2', name: 'b' };
    const a2 = { id: '1', name: 'a-dup' };
    expect(mergeById([a, b], [a2, { id: '3', name: 'c' }])).toEqual([a, b, { id: '3', name: 'c' }]);
  });

  test('collectPaginatedItems walks every page and caps with truncated', async () => {
    const p3 = mockPage(['e', 'f'], 3, 3, 6, null);
    const p2 = mockPage(['c', 'd'], 2, 3, 6, async () => p3);
    const p1 = mockPage(['a', 'b'], 1, 3, 6, async () => p2);
    const all = await collectPaginatedItems(p1);
    expect(all.items).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(all.truncated).toBe(false);
    expect(all.pages).toBe(3);
    expect(all.total).toBe(6);

    let extra = 0;
    const cap3 = mockPage(['e', 'f'], 3, 3, 6, async () => {
      extra++;
      throw new Error('should not fetch page 3');
    });
    const cap2 = mockPage(['c', 'd'], 2, 3, 6, async () => cap3);
    const cap1 = mockPage(['a', 'b'], 1, 3, 6, async () => cap2);
    const cap = await collectPaginatedItems(cap1, { maxItems: 3 });
    expect(cap.items).toEqual(['a', 'b', 'c']);
    expect(cap.truncated).toBe(true);
    expect(extra).toBe(0);
  });
});

describe('catalog list against a fake API', () => {
  const TOTAL = 120;
  const allZones = Array.from({ length: TOTAL }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return { id: `z${n}${'0'.repeat(29)}`.slice(0, 32), name: `zone-${n}.example.com`, status: 'active' };
  });
  const zoneId = 'e'.repeat(32);
  const records = [
    { id: 'r1', name: 'www.example.com', type: 'A', content: '1.2.3.4' },
    { id: 'r2', name: 'mail.example.com', type: 'MX', content: 'mx.example.com' },
    { id: 'r3', name: 'api.hidden.com', type: 'CNAME', content: 'target.example.com' },
  ];

  let api: ReturnType<typeof startFakeApi>;
  beforeAll(() => {
    api = startFakeApi((_req, url) => {
      if (url.pathname === '/client/v4/zones' && _req.method === 'GET') {
        let items = allZones;
        const name = url.searchParams.get('name') ?? '';
        if (name.startsWith('contains:')) {
          const needle = name.slice('contains:'.length).toLowerCase();
          items = items.filter((z) => z.name.includes(needle));
        } else if (name) {
          items = items.filter((z) => z.name === name);
        }
        const per = Number(url.searchParams.get('per_page') ?? '50');
        const page = Number(url.searchParams.get('page') ?? '1');
        const start = (page - 1) * per;
        const slice = items.slice(start, start + per);
        return ok(slice, { result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(items.length / per)), total_count: items.length, count: slice.length } });
      }
      if (url.pathname === `/client/v4/zones/${zoneId}/dns_records`) {
        let items = records;
        const search = url.searchParams.get('search');
        if (search) {
          const t = search.toLowerCase();
          items = items.filter((r) => `${r.name} ${r.content} ${r.type}`.toLowerCase().includes(t));
        }
        return ok(items, { result_info: { page: 1, per_page: 50, total_pages: 1, total_count: items.length, count: items.length } });
      }
      return undefined;
    });
  });
  afterAll(() => api.stop());

  function testCtx(): Context {
    return {
      profileName: 'default',
      profile: {},
      config: { version: 1, profiles: {} },
      credentials: { kind: 'token', apiToken: 'test-token-1234567890', source: 'test' },
      baseURL: api.baseURL,
    };
  }

  test('listZones paginates past the first 50', async () => {
    const client = await createClient(testCtx(), { version: 'test', baseURL: api.baseURL });
    const listed = await listZones(client, { maxItems: 250 });
    expect(listed.items).toHaveLength(TOTAL);
    expect(listed.truncated).toBe(false);
    expect(listed.total).toBe(TOTAL);
    expect(listed.pages).toBe(3);
  });

  test('listZones truncates at maxItems', async () => {
    const client = await createClient(testCtx(), { version: 'test', baseURL: api.baseURL });
    const listed = await listZones(client, { maxItems: 50 });
    expect(listed.items).toHaveLength(50);
    expect(listed.truncated).toBe(true);
    expect(listed.total).toBe(TOTAL);
  });

  test('listZones remote search uses contains:', async () => {
    const client = await createClient(testCtx(), { version: 'test', baseURL: api.baseURL });
    const before = api.requests.length;
    const listed = await listZones(client, { name: zoneNameQuery('zone-100'), maxItems: 50 });
    expect(listed.items.map((z: any) => z.name)).toEqual(['zone-100.example.com']);
    const req = api.requests.slice(before).find((r) => r.path.includes('name='));
    expect(req?.path).toMatch(/name=contains(:|%3A)zone-100/);
  });

  test('listDnsRecords passes search to the API', async () => {
    const client = await createClient(testCtx(), { version: 'test', baseURL: api.baseURL });
    const before = api.requests.length;
    const listed = await listDnsRecords(client, { zoneId, search: 'mail', maxItems: 50 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].name).toBe('mail.example.com');
    expect(api.requests.slice(before).some((r) => r.path.includes('search=mail'))).toBe(true);
  });
});
