import { describe, expect, it } from 'vitest';
import { MAX_TIMEOUT_MS, validateTimeout } from '../src/timeout.js';

describe('validateTimeout', () => {
  it.each([1, 15_000, MAX_TIMEOUT_MS])('accepts %s', (value) => {
    expect(() => validateTimeout(value, 'requestTimeoutMs')).not.toThrow();
  });
  it('exposes the exact 2^31-1 setTimeout bound', () => {
    expect(MAX_TIMEOUT_MS).toBe(2_147_483_647);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1, Number.MAX_SAFE_INTEGER])(
    'rejects %s with RangeError naming the option', (value) => {
      expect(() => validateTimeout(value, 'requestTimeoutMs')).toThrow(RangeError);
      expect(() => validateTimeout(value, 'requestTimeoutMs')).toThrow(/requestTimeoutMs/);
    }
  );
});
