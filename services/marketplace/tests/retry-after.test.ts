import { describe, expect, it } from 'vitest';
import { normalizeRetryAfterHeader } from '../src/retry-after.js';

describe('normalizeRetryAfterHeader', () => {
  it('treats a missing header as no hint, not zero', () => {
    expect(normalizeRetryAfterHeader(null)).toBeUndefined();
  });

  it('treats an empty header as no hint, not zero', () => {
    expect(normalizeRetryAfterHeader('')).toBeUndefined();
  });

  it('treats a whitespace-only header as no hint, not zero', () => {
    expect(normalizeRetryAfterHeader('   ')).toBeUndefined();
  });

  it('accepts a plain integer delay', () => {
    expect(normalizeRetryAfterHeader('7')).toBe(7);
  });

  it('accepts a padded integer delay', () => {
    expect(normalizeRetryAfterHeader(' 7 ')).toBe(7);
  });

  it('accepts leading zeros', () => {
    expect(normalizeRetryAfterHeader('007')).toBe(7);
  });

  it('accepts zero as a delay', () => {
    expect(normalizeRetryAfterHeader('0')).toBe(0);
  });

  it('truncates a fractional delay to an integer', () => {
    expect(normalizeRetryAfterHeader('1.5')).toBe(1);
  });

  it('truncates a padded fractional delay to an integer', () => {
    expect(normalizeRetryAfterHeader('  2.5  ')).toBe(2);
  });

  it('preserves a delay at the maximum safe integer', () => {
    expect(normalizeRetryAfterHeader('9007199254740991')).toBe(9007199254740991);
  });

  it('drops a delay beyond the safe integer range', () => {
    expect(normalizeRetryAfterHeader('9007199254740992')).toBeUndefined();
  });

  it('drops a fractional delay that rounds past the safe integer range', () => {
    expect(normalizeRetryAfterHeader('9007199254740991.9')).toBeUndefined();
  });

  it('drops a negative delay', () => {
    expect(normalizeRetryAfterHeader('-5')).toBeUndefined();
  });

  it('drops a negative zero delay', () => {
    expect(normalizeRetryAfterHeader('-0')).toBeUndefined();
  });

  it('drops an explicitly signed delay', () => {
    expect(normalizeRetryAfterHeader('+5')).toBeUndefined();
  });

  it('drops an exponent delay', () => {
    expect(normalizeRetryAfterHeader('1e3')).toBeUndefined();
    expect(normalizeRetryAfterHeader('1e21')).toBeUndefined();
  });

  it('drops a hexadecimal delay', () => {
    expect(normalizeRetryAfterHeader('0x10')).toBeUndefined();
  });

  it('drops Infinity and NaN', () => {
    expect(normalizeRetryAfterHeader('Infinity')).toBeUndefined();
    expect(normalizeRetryAfterHeader('NaN')).toBeUndefined();
  });

  it('drops a nonnumeric delay', () => {
    expect(normalizeRetryAfterHeader('later')).toBeUndefined();
  });

  it('drops an HTTP-date delay', () => {
    expect(normalizeRetryAfterHeader('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined();
  });

  it('drops malformed decimal spellings', () => {
    expect(normalizeRetryAfterHeader('1.')).toBeUndefined();
    expect(normalizeRetryAfterHeader('.5')).toBeUndefined();
    expect(normalizeRetryAfterHeader('1.2.3')).toBeUndefined();
  });
});
