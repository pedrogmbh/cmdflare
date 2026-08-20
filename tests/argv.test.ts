import { describe, expect, test } from 'bun:test';
import { parseArgv, type FlagSpec } from '../src/core/argv';

const specs: FlagSpec[] = [
  { name: 'output', aliases: ['o'], type: 'string' },
  { name: 'all', type: 'boolean' },
  { name: 'limit', type: 'number' },
  { name: 'data', aliases: ['d'], type: 'string', multiple: true },
  { name: 'verbose', aliases: ['v'], type: 'boolean' },
  { name: 'yes', aliases: ['y'], type: 'boolean' },
  { name: 'proxied', id: 'param:proxied', type: 'boolean' },
];

describe('parseArgv', () => {
  test('positionals and long flags', () => {
    const r = parseArgv(['dns', 'records', 'list', '--output', 'json', '--all', '--limit=5'], specs);
    expect(r.positionals).toEqual(['dns', 'records', 'list']);
    expect(r.flags).toEqual({ output: 'json', all: true, limit: 5 });
  });
  test('short flags, grouped booleans and attached values', () => {
    const r = parseArgv(['-vy', '-ojson', '-o', 'yaml', '-d', 'a', '-d=b'], specs);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.yes).toBe(true);
    expect(r.flags.output).toBe('yaml');
    expect(r.flags.data).toEqual(['a', 'b']);
  });
  test('boolean negation and explicit values', () => {
    expect(parseArgv(['--no-all'], specs).flags.all).toBe(false);
    expect(parseArgv(['--all=false'], specs).flags.all).toBe(false);
    expect(parseArgv(['--all', 'true', 'x'], specs)).toMatchObject({ flags: { all: true }, positionals: ['x'] });
    expect(parseArgv(['--proxied', 'false'], specs).flags['param:proxied']).toBe(false);
  });
  test('unknown flags are collected with values', () => {
    const r = parseArgv(['cmd', '--name', 'www', '--settings.ipv4_only', 'true', '--flag', '--other=1', '-P', 'k=v'], specs);
    expect(r.positionals).toEqual(['cmd']);
    expect(r.unknown).toEqual({ name: 'www', 'settings.ipv4_only': 'true', flag: true, other: '1', P: 'k=v' });
    expect(r.unknownOrder).toEqual(['name', 'settings.ipv4_only', 'flag', 'other', 'P']);
  });
  test('double dash stops parsing', () => {
    const r = parseArgv(['a', '--', '--not-a-flag', '-x'], specs);
    expect(r.positionals).toEqual(['a', '--not-a-flag', '-x']);
  });
  test('negative numbers are values', () => {
    expect(parseArgv(['--limit', '-5'], specs).flags.limit).toBe(-5);
  });
  test('errors', () => {
    expect(() => parseArgv(['--limit', 'abc'], specs)).toThrow(/expects a number/);
    expect(() => parseArgv(['--output'], specs)).toThrow(/requires a value/);
  });
});
