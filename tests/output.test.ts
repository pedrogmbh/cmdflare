import { beforeEach, describe, expect, test } from 'bun:test';
import { applyQuery, formatOutput, selectFields } from '../src/core/output';
import { setColor, stripAnsi } from '../src/core/ui';

const rows = [
  { id: 'a1', name: 'one', status: 'active', meta: { x: 1 }, tags: ['t1', 't2'] },
  { id: 'b2', name: 'two', status: 'paused', meta: { x: 2 }, tags: [] },
];

describe('applyQuery', () => {
  test('paths, indexes, projections, filters', () => {
    expect(applyQuery(rows, '[0].name')).toBe('one');
    expect(applyQuery(rows, '[-1].id')).toBe('b2');
    expect(applyQuery(rows, '[*].name')).toEqual(['one', 'two']);
    expect(applyQuery(rows, '[].meta.x')).toEqual([1, 2]);
    expect(applyQuery({ result: rows }, 'result[?status==active].id')).toEqual(['a1']);
    expect(applyQuery({ result: rows }, "result[?status!='active'].id")).toEqual(['b2']);
    expect(applyQuery({ a: { 'weird.key': 1 } }, 'a."weird.key"')).toBe(1);
    expect(applyQuery(rows, '')).toBe(rows);
    expect(() => applyQuery(rows, '[?bad]')).toThrow(/unsupported filter/);
  });
});

describe('formatOutput', () => {
  // formatOutput colorizes JSON/table headers when stdout is a TTY (bun test)
  // or FORCE_COLOR is set. Pin color off so string assertions are deterministic.
  beforeEach(() => setColor(false));

  test('json / compact / ndjson / id / raw / yaml', () => {
    expect(formatOutput({ a: 1 }, { format: 'json' })).toBe('{\n  "a": 1\n}');
    expect(formatOutput({ a: 1 }, { format: 'json', compact: true })).toBe('{"a":1}');
    expect(formatOutput(rows, { format: 'ndjson' }).split('\n')).toHaveLength(2);
    expect(formatOutput(rows, { format: 'id' })).toBe('a1\nb2');
    expect(formatOutput('plain text', { format: 'raw' })).toBe('plain text');
    expect(formatOutput({ a: [1, 2] }, { format: 'yaml' })).toContain('a:\n  - 1');
  });
  test('table picks sensible columns and hides complex ones', () => {
    const t = formatOutput(rows, { format: 'table' });
    const header = t.split('\n')[0]!;
    expect(header).toMatch(/^id\s+name\s+status/);
    expect(header).toContain('tags');
    expect(t).toContain('t1, t2');
    expect(formatOutput([], { format: 'table' })).toContain('no results');
    const single = formatOutput({ id: 'x', nested: { a: 1, b: 'two' } }, { format: 'table' });
    expect(single).toContain('nested.a');
  });
  test('json and table headers colorize when color is on', () => {
    setColor(true);
    const json = formatOutput({ a: 1 }, { format: 'json' });
    expect(json).not.toBe('{\n  "a": 1\n}');
    expect(stripAnsi(json)).toBe('{\n  "a": 1\n}');
    const header = formatOutput(rows, { format: 'table' }).split('\n')[0]!;
    expect(header).toMatch(/\x1b\[1m/);
    expect(stripAnsi(header)).toMatch(/^id\s+name\s+status/);
  });
  test('csv/tsv with quoting and fields', () => {
    const csv = formatOutput([{ a: 'x,y', b: 'q"uote', c: { n: 1 } }], { format: 'csv' });
    expect(csv).toBe('a,b,c\n"x,y","q""uote","{""n"":1}"');
    const tsv = formatOutput(rows, { format: 'tsv', fields: ['name', 'meta.x'] });
    expect(tsv).toBe('name\tmeta.x\none\t1\ntwo\t2');
  });
  test('selectFields', () => {
    expect(selectFields(rows, ['id', 'meta.x'])).toEqual([{ id: 'a1', 'meta.x': 1 }, { id: 'b2', 'meta.x': 2 }]);
  });
});
