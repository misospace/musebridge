import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MautrixMetaClient, MautrixMetaHttpError, resolveMetaTransportBaseUrl } from '../src/mautrix-meta.js';

const baseUrl = 'http://127.0.0.1:9000';
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

const threadRow = { thread_id: 'synth-meta-thread-001', preview: 'Synthetic list preview.' };
const messageRow = { sender: 'other', text: 'Synthetic tail message.', sent_at: '2025-03-01T10:00:00.000Z' };
const listBody = { threads: [threadRow], truncated: false };
const tailBody = { messages: [messageRow], coverage: { window: 'tail', scanned_rows: 1, truncated: false } };
const backfillBody = { messages: [messageRow], coverage: { window: 'backfill', scanned_rows: 1, has_more_before: false } };
const bodyFor = (url: string): unknown => url.includes('before=') ? backfillBody : url.includes('/messages') ? tailBody : listBody;

describe('resolveMetaTransportBaseUrl', () => {
  it('accepts loopback http and operator-private https hosts', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(resolveMetaTransportBaseUrl('http://localhost:9000')).toBe('http://localhost:9000');
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example')).toBe('https://meta.internal.example');
  });

  it('strips one trailing slash', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000/')).toBe('http://127.0.0.1:9000');
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example/')).toBe('https://meta.internal.example');
  });

  it('refuses Meta-owned hosts by exact host and dotted subdomain', () => {
    for (const rejected of ['https://facebook.com', 'https://messenger.com', 'https://meta.com', 'https://m.facebook.com']) {
      expect(() => resolveMetaTransportBaseUrl(rejected)).toThrow(TypeError);
    }
  });

  it('refuses the trailing-dot FQDN spelling of Meta hosts: DNS resolves them to Meta', () => {
    for (const rejected of ['https://facebook.com.', 'https://messenger.com.', 'https://m.facebook.com.']) {
      expect(() => resolveMetaTransportBaseUrl(rejected)).toThrow(TypeError);
    }
  });

  it('accepts the bracketed IPv6 loopback over http (the documented sidecar shape)', () => {
    expect(resolveMetaTransportBaseUrl('http://[::1]:9000')).toBe('http://[::1]:9000');
  });

  it('accepts a trailing-dot operator-private host', () => {
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example.')).toBe('https://meta.internal.example.');
  });

  it('accepts a Meta-lookalike suffix: only real Meta hosts are refused', () => {
    // The dotted-suffix rule is exactly what separates `checkpoint.facebook.com` (refused)
    // from `checkpoint.facebook.com.evil.example` — an unrelated host whose name merely ends
    // the way a Meta subdomain path segment does.
    expect(resolveMetaTransportBaseUrl('https://checkpoint.facebook.com.evil.example')).toBe('https://checkpoint.facebook.com.evil.example');
  });

  it('refuses userinfo, query, fragment, non-http(s), non-loopback http, empty host, and garbage', () => {
    for (const rejected of [
      'https://u:p@meta.internal.example',
      'https://meta.internal.example/?x=1',
      'https://meta.internal.example#frag',
      'ftp://meta.internal.example',
      'http://meta.internal.example',
      'http://',
      'meta.internal.example',
      'not a url'
    ]) {
      expect(() => resolveMetaTransportBaseUrl(rejected)).toThrow(TypeError);
    }
  });
});

describe('MautrixMetaClient', () => {
  it('is GET-only with Accept: application/json on every route and forwards the abort signal', async () => {
    const seen: Array<{ method: string | undefined; accept: string | null; signal: AbortSignal | null | undefined }> = [];
    const controller = new AbortController();
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ method: init?.method, accept: new Headers(init?.headers).get('accept'), signal: init?.signal });
      return ok(bodyFor(url));
    } });
    await client.listThreads(5, controller.signal);
    await client.readThreadTail('synth-meta-thread-001', controller.signal);
    await client.backfillThread('synth-meta-thread-001', 1761955200000, 25, controller.signal);
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call.method).toBe('GET');
      expect(call.accept).toBe('application/json');
      expect(call.signal).toBe(controller.signal);
    }
  });

  it('requests manual redirects so a transport reply can never aim Musebridge at another host', async () => {
    const seen: unknown[] = [];
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async (_input, init) => {
      seen.push(init?.redirect);
      return ok(listBody);
    } });
    await client.listThreads(5);
    expect(seen).toEqual(['manual']);
  });

  it('treats a 3xx reply as a typed failure instead of following or parsing it', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://facebook.com/v1/threads' } }) });
    const error = await client.listThreads(5).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MautrixMetaHttpError);
    if (error instanceof MautrixMetaHttpError) expect(error.status).toBe(302);
  });

  it('assembles the pinned request URLs', async () => {
    const seenUrls: string[] = [];
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async (input) => {
      const url = String(input);
      seenUrls.push(url);
      return ok(bodyFor(url));
    } });
    await client.listThreads(5);
    await client.readThreadTail('t.1-2');
    await client.backfillThread('t1', 1762000000000, 25);
    expect(seenUrls[0]).toBe('http://127.0.0.1:9000/v1/threads?limit=5');
    expect(seenUrls[1]).toBe('http://127.0.0.1:9000/v1/threads/t.1-2/messages');
    expect(seenUrls[2]).toBe('http://127.0.0.1:9000/v1/threads/t1/messages?before=1762000000000&limit=25');
  });

  it('percent-encodes thread ids per encodeURIComponent semantics', async () => {
    let seenUrl = '';
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async (input) => { seenUrl = String(input); return ok(tailBody); } });
    await client.readThreadTail('t/1 2');
    expect(seenUrl).toBe('http://127.0.0.1:9000/v1/threads/t%2F1%202/messages');
  });

  it('fails loud on wire drift instead of returning an empty success', async () => {
    const clientFor = (body: unknown) => new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok(body) });
    // Missing required field, wrong field type, and extra unknown fields (strict) each throw
    // a ZodError from parse — before any value is returned to the caller.
    await expect(clientFor({ threads: [threadRow] }).listThreads(5)).rejects.toBeInstanceOf(z.ZodError);
    await expect(clientFor({ threads: [{ thread_id: 42 }], truncated: false }).listThreads(5)).rejects.toBeInstanceOf(z.ZodError);
    await expect(clientFor({ threads: [], truncated: false, unexpected: 1 }).listThreads(5)).rejects.toBeInstanceOf(z.ZodError);
    await expect(clientFor({ messages: [messageRow], coverage: { window: 'tail', scanned_rows: 1 } }).readThreadTail('t1')).rejects.toBeInstanceOf(z.ZodError);
    // The backfill wire carries provider-authored coverage only: a body shipping its own
    // `before` — a caller-facing field the backend composes from the request — is drift.
    await expect(clientFor({
      messages: [messageRow],
      coverage: { window: 'backfill', scanned_rows: 1, has_more_before: false, before: '2025-03-01T10:00:00.000Z' }
    }).backfillThread('t1', 1761955200000, 25)).rejects.toBeInstanceOf(z.ZodError);
  });

  it('surfaces a typed error body as MautrixMetaHttpError with its code', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok({ error: { code: 'challenge_required', message: 'Synthetic challenge notice.' } }, 403) });
    const error = await client.readThreadTail('t1').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MautrixMetaHttpError);
    if (error instanceof MautrixMetaHttpError) {
      expect(error.status).toBe(403);
      expect(error.code).toBe('challenge_required');
    }
  });

  it('classifies a non-JSON failure body as unknown without losing the status', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => new Response('gateway failure text', { status: 502 }) });
    const error = await client.listThreads(5).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MautrixMetaHttpError);
    if (error instanceof MautrixMetaHttpError) {
      expect(error.status).toBe(502);
      expect(error.code).toBe('unknown');
    }
  });

  it('lets a body retry_after win over the header', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok({ error: { code: 'rate_limited', message: 'Synthetic rate limit.', retry_after: 45 } }, 429, { 'retry-after': '30' }) });
    await expect(client.listThreads(5)).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 45 });
  });

  it('normalizes a retry-after header into retryAfter when the body carries none', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok({ error: { code: 'rate_limited', message: 'Synthetic rate limit.' } }, 429, { 'retry-after': '30' }) });
    await expect(client.listThreads(5)).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 30 });
  });

  it('drops a garbage retry-after header instead of fabricating a hint', async () => {
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok({ error: { code: 'rate_limited', message: 'Synthetic rate limit.' } }, 429, { 'retry-after': 'later' }) });
    await expect(client.listThreads(5)).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: undefined });
  });
});
