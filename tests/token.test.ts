import { expect, test } from 'bun:test';
import { detectTokenFormat } from '../src/core/token';

test('detectTokenFormat reads scannable prefixes', () => {
  expect(detectTokenFormat('cfat_' + 'x'.repeat(40) + 'abcd')).toBe('account');
  expect(detectTokenFormat('cfut_' + 'y'.repeat(40) + 'abcd')).toBe('user');
  expect(detectTokenFormat('cfk_' + 'z'.repeat(40) + 'abcd')).toBe('global_key');
  expect(detectTokenFormat('Sn3lZJTBX6kkg7OdcBUAxOO963GEIyGQqnFTOFYY')).toBe('legacy');
  expect(detectTokenFormat(undefined)).toBeUndefined();
});
