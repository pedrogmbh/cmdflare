import { describe, expect, test } from 'bun:test';
import { renderMethodHelp, renderResourceHelp } from '../src/core/help';
import { commandPath, countMethods, flattenCommands, getMethodDetail, loadIndex, loadTopDetail, resolveCommand, searchScore, suggest } from '../src/core/manifest';
import { kebab, normKey } from '../src/core/names';
import { buildMethodFlagSpecs, buildParams, normalizeParamPath } from '../src/core/params';
import { GLOBAL_NAMES } from '../src/core/globals';

describe('names', () => {
  test('kebab handles acronyms', () => {
    expect(kebab('zoneTransfers')).toBe('zone-transfers');
    expect(kebab('originCACertificates')).toBe('origin-ca-certificates');
    expect(kebab('dDoSProtection')).toBe('ddos-protection');
    expect(kebab('deleteByIDs')).toBe('delete-by-ids');
    expect(kebab('dnssecE2E')).toBe('dnssec-e2e');
    expect(kebab('per_page')).toBe('per-page');
    expect(normKey('Zone-Transfers')).toBe('zonetransfers');
  });
});

describe('manifest', () => {
  const idx = loadIndex();
  test('index loads with many commands', () => {
    expect(idx.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(idx.root.children.length).toBeGreaterThan(100);
    expect(countMethods(idx.root)).toBeGreaterThan(2000);
  });
  test('resolves paths, camelCase, aliases', () => {
    const r = resolveCommand(['dns', 'records', 'list', 'extra']);
    expect(r.ok && r.method?.name).toBe('list');
    expect(r.ok && r.rest).toEqual(['extra']);
    expect(resolveCommand(['dns', 'zoneTransfers']).ok).toBe(true);
    expect(resolveCommand(['dns', 'zone_transfers']).ok).toBe(true);
    const ls = resolveCommand(['zones', 'ls']);
    expect(ls.ok && ls.method?.name).toBe('list');
    const rm = resolveCommand(['dns', 'records', 'rm']);
    expect(rm.ok && rm.method?.name).toBe('delete');
    const bad = resolveCommand(['dns', 'recordz']);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.suggestions).toContain('records');
  });
  test('detail files agree with the index', () => {
    for (const top of idx.root.children) {
      const det = loadTopDetail(top.cli);
      expect(det.name).toBe(top.name);
      expect(countMethods(det)).toBe(countMethods(top));
    }
  });
  test('method detail carries params', () => {
    const r = resolveCommand(['dns', 'records', 'create']);
    if (!r.ok || !r.method) throw new Error('unresolved');
    const m = getMethodDetail(r.path, r.method);
    const names = m.params!.type.props!.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['zone_id', 'name', 'type', 'ttl', 'content', 'proxied']));
    expect(m.http).toBe('POST');
    expect(m.path).toBe('/zones/{zone_id}/dns_records');
  });
  test('suggest and search', () => {
    expect(suggest('recrods', ['records', 'settings'])).toEqual(['records']);
    const all = flattenCommands();
    const best = all.map((c) => ({ c, s: searchScore(c, ['purge', 'cache']) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
    expect(best?.c.cli).toBe('cache purge');
  });
  test('help renders for every command without throwing', () => {
    let n = 0;
    for (const cmd of flattenCommands()) {
      const m = getMethodDetail(cmd.path, cmd.method);
      const text = renderMethodHelp(cmd.path, m);
      expect(text).toContain(commandPath(cmd.path, m));
      n++;
    }
    expect(n).toBeGreaterThan(2000);
    expect(renderResourceHelp([idx.root.children[0]!], idx.root.children[0]!)).toContain('Usage');
  });
});

describe('params', () => {
  const r = resolveCommand(['dns', 'records', 'create']);
  if (!r.ok || !r.method) throw new Error('unresolved');
  const method = getMethodDetail(r.path, r.method);
  test('flag specs and collisions', () => {
    const { specs, collisions } = buildMethodFlagSpecs(method, GLOBAL_NAMES);
    expect(specs.find((s) => s.name === 'per-page' || s.name === 'ttl')).toBeTruthy();
    expect(collisions).toContain('data');
  });
  test('buildParams merges data, flags, dotted and set', () => {
    const params = buildParams({
      method,
      flags: { 'param:name': 'www', 'param:ttl': 60, 'param:proxied': true, 'param:tags': ['a', 'b'] },
      unknown: { 'settings.ipv4-only': 'true' },
      data: ['{"comment":"from data","ttl":1}'],
      sets: ['data.flags=1', 'data.tag=issue'],
      zoneId: 'z'.repeat(32),
    });
    expect(params).toEqual({
      comment: 'from data',
      ttl: 60,
      name: 'www',
      proxied: true,
      tags: ['a', 'b'],
      settings: { ipv4_only: true },
      data: { flags: 1, tag: 'issue' },
      zone_id: 'z'.repeat(32),
    });
  });
  test('unknown flags error with suggestions', () => {
    expect(() => buildParams({ method, flags: {}, unknown: { nmae: 'x' } })).toThrow(/Unknown flag --nmae/);
  });
  test('normalizeParamPath', () => {
    const props = method.params!.type.props!;
    expect(normalizeParamPath(props, 'settings.ipv4-only')).toBe('settings.ipv4_only');
    expect(normalizeParamPath(props, 'custom-thing.X-Header')).toBe('custom_thing.X-Header');
  });
});
