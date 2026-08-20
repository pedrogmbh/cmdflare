import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coerceValue, getPath, setPath } from '../src/core/coerce';
import type { TypeSpec } from '../src/core/manifest-types';

const enumSpec: TypeSpec = { kind: 'enum', enum: ['A', 'AAAA', 'CNAME'] };

describe('coerceValue', () => {
  test('primitives', () => {
    expect(coerceValue('5', { kind: 'number' }, 'ttl')).toBe(5);
    expect(coerceValue(5, { kind: 'number' }, 'ttl')).toBe(5);
    expect(coerceValue('true', { kind: 'boolean' }, 'p')).toBe(true);
    expect(coerceValue(true, { kind: 'boolean' }, 'p')).toBe(true);
    expect(coerceValue('x', { kind: 'string' }, 's')).toBe('x');
    expect(coerceValue('a', enumSpec, 't')).toBe('A');
    expect(() => coerceValue('Z', enumSpec, 't')).toThrow(/invalid value/);
    expect(() => coerceValue('abc', { kind: 'number' }, 'n')).toThrow(/expected a number/);
  });
  test('arrays: comma, json, repeated', () => {
    const arr: TypeSpec = { kind: 'array', items: { kind: 'string' } };
    expect(coerceValue('a,b, c', arr, 'tags')).toEqual(['a', 'b', 'c']);
    expect(coerceValue('["x","y"]', arr, 'tags')).toEqual(['x', 'y']);
    expect(coerceValue(['a', 'b,c'], arr, 'tags')).toEqual(['a', 'b', 'c']);
    const objArr: TypeSpec = { kind: 'array', items: { kind: 'object', props: [] } };
    expect(coerceValue('[{"a":1}]', objArr, 'items')).toEqual([{ a: 1 }]);
    expect(coerceValue('{"a":1}', objArr, 'items')).toEqual([{ a: 1 }]);
    expect(() => coerceValue('nope', objArr, 'items')).toThrow(/JSON array/);
  });
  test('objects and json', () => {
    expect(coerceValue('{"a":1}', { kind: 'object', props: [] }, 'o')).toEqual({ a: 1 });
    expect(() => coerceValue('plain', { kind: 'object', props: [] }, 'o')).toThrow(/expected a JSON object/);
    expect(coerceValue('{"a":1}', { kind: 'json' }, 'j')).toEqual({ a: 1 });
    expect(coerceValue('12', { kind: 'json' }, 'j')).toBe(12);
    expect(coerceValue('hello', { kind: 'json' }, 'j')).toBe('hello');
    expect(coerceValue('1', { kind: 'union', members: [{ kind: 'number' }, { kind: 'string' }] }, 'u')).toBe(1);
    expect(coerceValue('abc', { kind: 'union', members: [{ kind: 'number' }, { kind: 'string' }] }, 'u')).toBe('abc');
  });
  test('@file references', () => {
    const f = join(tmpdir(), `cmdflare-coerce-${process.pid}.json`);
    writeFileSync(f, '{"from":"file"}\n');
    expect(coerceValue('@' + f, { kind: 'object', props: [] }, 'o')).toEqual({ from: 'file' });
    expect(coerceValue('@' + f, { kind: 'string' }, 's')).toBe('{"from":"file"}');
    expect(coerceValue('@@literal', { kind: 'string' }, 's')).toBe('@literal');
    expect(() => coerceValue('@/nonexistent/file', { kind: 'string' }, 's')).toThrow(/could not read file/);
  });
});

describe('setPath/getPath', () => {
  test('nested paths with arrays', () => {
    const o: any = {};
    setPath(o, 'a.b.c', 1);
    setPath(o, 'list[0].name', 'x');
    setPath(o, 'list.1.name', 'y');
    expect(o).toEqual({ a: { b: { c: 1 } }, list: [{ name: 'x' }, { name: 'y' }] });
    expect(getPath(o, 'list[1].name')).toBe('y');
    expect(getPath(o, 'a.missing.x')).toBeUndefined();
  });
});
