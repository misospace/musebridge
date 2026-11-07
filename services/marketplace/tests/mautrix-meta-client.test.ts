import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MautrixMetaClient,
  MautrixMetaContractError,
  MautrixMetaHttpError,
  isLoopbackTransportHost,
  isValidMautrixMetaServiceToken,
  resolveMetaTransportBaseUrl
} from '../src/mautrix-meta.js';

const baseUrl = 'http://127.0.0.1:9000';
const serviceToken = 'synth-service-token';
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

const threadRow = { thread_id: 'synth-meta-thread-001', preview: 'Synthetic list preview.' };
const messageRow = { sender: 'other', text: 'Synthetic tail message.', sent_at: '2025-03-01T10:00:00.000Z' };
const listBody = { threads: [threadRow], truncated: false };
const tailBody = { messages: [messageRow], coverage: { window: 'tail', scanned_rows: 1, truncated: false } };
const backfillBody = { messages: [messageRow], coverage: { window: 'backfill', scanned_rows: 1, has_more_before: false } };
const bodyFor = (url: string): unknown => url.includes('before=') ? backfillBody : url.includes('/messages') ? tailBody : listBody;

describe('resolveMetaTransportBaseUrl', () => {
  it('accepts loopback http without a credential and an operator-private https host with one', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(resolveMetaTransportBaseUrl('http://localhost:9000')).toBe('http://localhost:9000');
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example', serviceToken)).toBe('https://meta.internal.example');
  });

  it('refuses a non-loopback destination without a credential', () => {
    expect(() => resolveMetaTransportBaseUrl('https://meta.internal.example')).toThrow(TypeError);
    expect(() => resolveMetaTransportBaseUrl('https://meta.internal.example')).toThrow(/MAUTRIX_META_SERVICE_TOKEN/);
  });

  it('strips one trailing slash', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000/')).toBe('http://127.0.0.1:9000');
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example/', serviceToken)).toBe('https://meta.internal.example');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveMetaTransportBaseUrl('  http://127.0.0.1:9000  ')).toBe('http://127.0.0.1:9000');
    expect(resolveMetaTransportBaseUrl('\t https://meta.internal.example \n', serviceToken)).toBe('https://meta.internal.example');
  });

  it('strips a trailing question mark', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000?')).toBe('http://127.0.0.1:9000');
  });

  it('strips a trailing hash sign', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000#')).toBe('http://127.0.0.1:9000');
  });

  it('strips whitespace and a trailing question mark and hash sign together', () => {
    expect(resolveMetaTransportBaseUrl('  http://127.0.0.1:9000/?#  ')).toBe('http://127.0.0.1:9000');
  });

  it('keeps a non-root pathname as parsed: the removed trailing slash is only the bare-host one', () => {
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000/base')).toBe('http://127.0.0.1:9000/base');
    expect(resolveMetaTransportBaseUrl('http://127.0.0.1:9000/base/')).toBe('http://127.0.0.1:9000/base/');
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
    expect(resolveMetaTransportBaseUrl('https://meta.internal.example.', serviceToken)).toBe('https://meta.internal.example.');
  });

  it('accepts a Meta-lookalike suffix: only real Meta hosts are refused', () => {
    // The dotted-suffix rule is exactly what separates `checkpoint.facebook.com` (refused)
    // from `checkpoint.facebook.com.evil.example` — an unrelated host whose name merely ends
    // the way a Meta subdomain path segment does.
    expect(resolveMetaTransportBaseUrl('https://checkpoint.facebook.com.evil.example', serviceToken)).toBe('https://checkpoint.facebook.com.evil.example');
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

  it('refuses a query or fragment with content: only an empty trailing ? or # is stripped', () => {
    for (const rejected of ['http://127.0.0.1:9000?x=1', 'http://127.0.0.1:9000#x', 'http://127.0.0.1:9000/?x=1#y']) {
      expect(() => resolveMetaTransportBaseUrl(rejected)).toThrow(TypeError);
    }
  });
});

describe('isLoopbackTransportHost', () => {
  it('names the loopback destinations that need no service credential', () => {
    expect(isLoopbackTransportHost('http://127.0.0.1:9000')).toBe(true);
    expect(isLoopbackTransportHost('http://localhost:9000')).toBe(true);
    expect(isLoopbackTransportHost('http://[::1]:9000')).toBe(true);
  });

  it('treats every other destination as one that leaves the host', () => {
    expect(isLoopbackTransportHost('https://meta.internal.example')).toBe(false);
    expect(isLoopbackTransportHost('https://198.51.100.7:9000')).toBe(false);
  });

  it('refuses a destination that does not parse instead of reading it as non-loopback', () => {
    expect(() => isLoopbackTransportHost('not a url')).toThrow(TypeError);
  });
});

describe('isValidMautrixMetaServiceToken', () => {
  it('accepts printable ASCII of 1 to 512 characters', () => {
    expect(isValidMautrixMetaServiceToken('a')).toBe(true);
    expect(isValidMautrixMetaServiceToken('A-b_0.+/=')).toBe(true);
    expect(isValidMautrixMetaServiceToken('x'.repeat(512))).toBe(true);
  });

  it('refuses an empty value, a value with a space, a control character, and an over-long value', () => {
    for (const invalid of ['', 'has space', 'tab\there', 'x'.repeat(513)]) {
      expect(isValidMautrixMetaServiceToken(invalid)).toBe(false);
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

  it('requests the normalized base, not the operator string', async () => {
    // The resolver's value is what the request is built from, so the artifacts the
    // operator wrote — surrounding spaces, a trailing `?` or `#` — must not reach the
    // request path.
    let seenUrl = '';
    const client = new MautrixMetaClient({ baseUrl: '  http://127.0.0.1:9000/?#  ', fetchImpl: async (input) => { seenUrl = String(input); return ok(listBody); } });
    await client.listThreads(5);
    expect(seenUrl).toBe('http://127.0.0.1:9000/v1/threads?limit=5');
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

  it('sends the service credential as a Bearer authorization header on every route', async () => {
    const seen: Headers[] = [];
    const client = new MautrixMetaClient({ baseUrl, serviceToken, fetchImpl: async (input, init) => {
      seen.push(new Headers(init?.headers));
      return ok(bodyFor(String(input)));
    } });
    await client.listThreads(5);
    await client.readThreadTail('synth-meta-thread-001');
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.get('authorization')).toBe(`Bearer ${serviceToken}`);
    }
  });

  it('sends no authorization header at all when no credential is configured', async () => {
    const seen: Headers[] = [];
    const client = new MautrixMetaClient({ baseUrl, fetchImpl: async (input, init) => {
      seen.push(new Headers(init?.headers));
      return ok(listBody);
    } });
    await client.listThreads(5);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.has('authorization')).toBe(false);
  });

  it('refuses a non-loopback destination without a credential', () => {
    expect(() => new MautrixMetaClient({ baseUrl: 'https://meta.internal.example' }))
      .toThrow(/MAUTRIX_META_SERVICE_TOKEN/);
  });

  it('refuses an invalid credential format and never echoes the value', () => {
    const invalid = 'not a valid token';
    let failure: unknown;
    try {
      new MautrixMetaClient({ baseUrl, serviceToken: invalid });
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toBeInstanceOf(TypeError);
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).toMatch(/MAUTRIX_META_SERVICE_TOKEN/);
    expect(message).not.toContain(invalid);
  });

  it('refuses an invalid credential format on a non-loopback destination too', () => {
    expect(() => new MautrixMetaClient({ baseUrl: 'https://meta.internal.example', serviceToken: 'bad token' }))
      .toThrow(/MAUTRIX_META_SERVICE_TOKEN/);
  });

  it('refuses a blank credential on a non-loopback destination', () => {
    // A blank value is not a credential. Treating it as one would let a non-loopback
    // destination start without authentication.
    for (const blank of ['', '   ']) {
      expect(() => new MautrixMetaClient({ baseUrl: 'https://meta.internal.example', serviceToken: blank }))
        .toThrow(/MAUTRIX_META_SERVICE_TOKEN/);
    }
  });

  it('refuses a credential that is not a string', () => {
    // The pattern test alone would coerce null to the text "null" and accept it.
    expect(() => new MautrixMetaClient({ baseUrl: 'https://meta.internal.example', serviceToken: null as unknown as string }))
      .toThrow(/MAUTRIX_META_SERVICE_TOKEN/);
  });

  it('reads the credential once, so a changing options property cannot drop it', async () => {
    // A caller can pass an options object whose property returns a different value on each
    // read. The value that passed the check must be the value the client sends.
    let reads = 0;
    const seen: Headers[] = [];
    const options = {
      baseUrl: 'https://meta.internal.example',
      get serviceToken(): string | undefined {
        reads += 1;
        return reads === 1 ? 'synth-service-token' : undefined;
      },
      fetchImpl: async (_input: unknown, init: { headers?: HeadersInit } | undefined) => {
        seen.push(new Headers(init?.headers));
        return ok(listBody);
      }
    };
    const client = new MautrixMetaClient(options as unknown as ConstructorParameters<typeof MautrixMetaClient>[0]);
    expect(reads).toBe(1);
    await client.listThreads(5);
    expect(seen[0]?.get('authorization')).toBe('Bearer synth-service-token');
  });
});

// The coverage contract (#195): every coverage claim this boundary makes is proven by the
// message rows' own timestamps. A page that cannot carry that proof is a typed failure, not
// a window — never a `truncated: false` claim the transport never proved.
describe('MautrixMetaClient coverage contract', () => {
  const clientFor = (body: unknown) => new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok(body) });
  const tailCoverage = { window: 'tail', scanned_rows: 2, truncated: false };
  const backfillCoverage = { window: 'backfill', scanned_rows: 2, has_more_before: false };
  const boundIso = '2025-11-01T00:00:00.000Z';
  const boundMs = Date.parse(boundIso);

  it('refuses a tail window whose rows carry no timestamps', async () => {
    // The newest end of a tail window is the newest row's own instant. An undated row cannot
    // be placed in the window at all, so the answer is a failure and not an empty window.
    const client = clientFor({
      messages: [{ sender: 'other', text: 'Synthetic undated row.' }],
      coverage: { window: 'tail', scanned_rows: 1, truncated: false }
    });
    await expect(client.readThreadTail('t1')).rejects.toBeInstanceOf(MautrixMetaContractError);
  });

  it('refuses a tail window whose rows are not chronological', async () => {
    // Out-of-order rows cannot say which row is the newest, so the newest end is unproven.
    const client = clientFor({
      messages: [
        { sender: 'other', text: 'Synthetic newer row.', sent_at: '2025-03-01T10:05:00.000Z' },
        { sender: 'other', text: 'Synthetic older row.', sent_at: '2025-03-01T10:00:00.000Z' }
      ],
      coverage: tailCoverage
    });
    await expect(client.readThreadTail('t1')).rejects.toBeInstanceOf(MautrixMetaContractError);
  });

  it('refuses an empty tail window: no rows means no newest end', async () => {
    const client = clientFor({ messages: [], coverage: { window: 'tail', scanned_rows: 0, truncated: false } });
    await expect(client.readThreadTail('t1')).rejects.toBeInstanceOf(MautrixMetaContractError);
  });

  it('refuses a backfill row that is not strictly older than the exclusive bound', async () => {
    // The bound is exclusive: a row at the bound is outside the requested window, and so is a
    // row newer than it. Either would make the returned window a different window than the
    // coverage describes.
    for (const sentAt of [boundIso, '2025-11-01T00:00:00.001Z']) {
      const client = clientFor({
        messages: [{ sender: 'other', text: 'Synthetic out-of-window row.', sent_at: sentAt }],
        coverage: backfillCoverage
      });
      await expect(client.backfillThread('t1', boundMs, 25)).rejects.toBeInstanceOf(MautrixMetaContractError);
    }
  });

  it('refuses a backfill row without a timestamp', async () => {
    const client = clientFor({
      messages: [{ sender: 'other', text: 'Synthetic undated row.' }],
      coverage: backfillCoverage
    });
    await expect(client.backfillThread('t1', boundMs, 25)).rejects.toBeInstanceOf(MautrixMetaContractError);
  });

  it('refuses a backfill page whose rows are not chronological', async () => {
    const client = clientFor({
      messages: [
        { sender: 'other', text: 'Synthetic newer row.', sent_at: '2025-10-31T09:05:00.000Z' },
        { sender: 'other', text: 'Synthetic older row.', sent_at: '2025-10-31T09:00:00.000Z' }
      ],
      coverage: backfillCoverage
    });
    await expect(client.backfillThread('t1', boundMs, 25)).rejects.toBeInstanceOf(MautrixMetaContractError);
  });

  it('accepts a chronological, dated page inside the requested bound', async () => {
    const client = clientFor({
      messages: [
        { sender: 'other', text: 'Synthetic older row.', sent_at: '2025-10-31T09:00:00.000Z' },
        { sender: 'other', text: 'Synthetic newer row.', sent_at: '2025-10-31T09:05:00.000Z' }
      ],
      coverage: backfillCoverage
    });
    await expect(client.backfillThread('t1', boundMs, 25)).resolves.toMatchObject({ coverage: { has_more_before: false } });
  });

  it('accepts an empty backfill page: an exhausted range with no older row is a complete window', async () => {
    // The tail needs at least one row because a window with no rows has no newest end. An
    // empty backfill window is the other case: the range holds no older row at all.
    const client = clientFor({ messages: [], coverage: { window: 'backfill', scanned_rows: 0, has_more_before: false } });
    await expect(client.backfillThread('t1', boundMs, 25)).resolves.toMatchObject({ messages: [], coverage: { has_more_before: false } });
  });
});
