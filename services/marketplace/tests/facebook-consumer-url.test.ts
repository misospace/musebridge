import { describe, expect, it } from 'vitest';
import {
  buildConsumerMenuUrl,
  parseConsumerThreadRoute,
  CONSUMER_MENU_PATHNAME,
  CONSUMER_E2EE_PREFIX,
  CONSUMER_THREAD_ID_PATTERN,
  CONSUMER_THREAD_ROUTE_PATTERN
} from '../src/facebook-consumer-url.js';

describe('buildConsumerMenuUrl', () => {
  it('builds the root-pathname menu URL for the configured origin', () => {
    expect(buildConsumerMenuUrl({ baseUrl: 'https://www.facebook.com' })).toBe(`https://www.facebook.com${CONSUMER_MENU_PATHNAME}`);
    expect(buildConsumerMenuUrl({ baseUrl: 'http://127.0.0.1:9010' })).toBe('http://127.0.0.1:9010/');
    expect(buildConsumerMenuUrl({ baseUrl: 'http://localhost:8788' })).toBe('http://localhost:8788/');
  });

  it('never targets /messages/ and strips path, query, and fragment from the base', () => {
    const menuUrl = buildConsumerMenuUrl({ baseUrl: 'https://www.facebook.com/messages/t/1684432532/?ref=nav#frag' });
    expect(menuUrl).toBe('https://www.facebook.com/');
    expect(new URL(menuUrl).pathname).not.toContain('/messages');
  });

  it.each([
    'https://evil.example',
    'https://facebook.com.evil.example',
    'https://notfacebook.com',
    'https://facebook.com',
    'ftp://facebook.com',
    'https://user:pass@www.facebook.com',
    'not a url',
    ''
  ])('rejects non-Facebook, non-loopback, or malformed origins: %s', (baseUrl) => {
    expect(() => buildConsumerMenuUrl({ baseUrl })).toThrow(TypeError);
  });

  it.each([[undefined], [null], ['https://www.facebook.com'], [['a']]])('rejects non-object inputs: %s', (input) => {
    expect(() => buildConsumerMenuUrl(input as never)).toThrow(TypeError);
  });
});

describe('parseConsumerThreadRoute', () => {
  it('parses plain conversation routes with and without a trailing slash', () => {
    expect(parseConsumerThreadRoute('/messages/t/1684432532/')).toEqual({ threadId: '1684432532', route: 'plain' });
    expect(parseConsumerThreadRoute('/messages/t/abc-123._')).toEqual({ threadId: 'abc-123._', route: 'plain' });
  });

  it('parses E2EE conversation routes and keeps the route provenance', () => {
    expect(parseConsumerThreadRoute(`${CONSUMER_E2EE_PREFIX}t/abc123/`)).toEqual({ threadId: 'abc123', route: 'e2ee' });
  });

  it('percent-decodes the thread key and validates the decoded value against the shared grammar', () => {
    expect(parseConsumerThreadRoute('/messages/t/%41bc/')).toEqual({ threadId: 'Abc', route: 'plain' });
    expect(parseConsumerThreadRoute('/messages/t/a%2Fb/')).toBeUndefined();
    expect(parseConsumerThreadRoute('/messages/t/bad%zz/')).toBeUndefined();
  });

  it.each([
    '/messages/t/',
    '/messages/t//',
    '/messages/e2ee/t/',
    '/messages/inbox/someone/',
    '/marketplace/item/123456789/',
    '/messages/t/.leading-dot/',
    '/messages/t/-leading-dash/',
    `/messages/t/${'x'.repeat(129)}/`
  ])('rejects non-conversation routes and invalid keys: %s', (pathname) => {
    expect(parseConsumerThreadRoute(pathname)).toBeUndefined();
  });

  it('accepts a thread key at the shared maximum length', () => {
    const threadId = 'x'.repeat(128);
    expect(parseConsumerThreadRoute(`/messages/t/${threadId}/`)).toEqual({ threadId, route: 'plain' });
  });

  it('returns undefined for non-string inputs', () => {
    expect(parseConsumerThreadRoute(undefined as never)).toBeUndefined();
    expect(parseConsumerThreadRoute(42 as never)).toBeUndefined();
  });

  it('keeps route and id patterns aligned with the shared thread-id grammar', () => {
    expect(CONSUMER_THREAD_ROUTE_PATTERN.test(`${CONSUMER_E2EE_PREFIX}t/x1/`)).toBe(true);
    expect(CONSUMER_THREAD_ROUTE_PATTERN.test('/messages/recent/')).toBe(false);
    expect(CONSUMER_THREAD_ROUTE_PATTERN.test('/messages/t/a/b/')).toBe(false);
    expect(CONSUMER_THREAD_ID_PATTERN.test('abc-123._')).toBe(true);
    expect(CONSUMER_THREAD_ID_PATTERN.test('.leading-dot')).toBe(false);
    expect(CONSUMER_THREAD_ID_PATTERN.test('')).toBe(false);
  });
});
