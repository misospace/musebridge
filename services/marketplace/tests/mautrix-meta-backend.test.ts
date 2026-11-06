import { describe, expect, it } from 'vitest';
import { MautrixMetaApiBackend } from '../src/mautrix-meta-backend.js';
import { MautrixMetaClient } from '../src/mautrix-meta.js';
import { FIXTURE_META_THREADS, FixtureMautrixMetaBackend } from '../src/mautrix-meta-fixtures.js';
import { ProviderError } from '../src/backend.js';

const baseUrl = 'http://127.0.0.1:9000';
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const backendWith = (fetchImpl: typeof fetch) => new MautrixMetaApiBackend({ client: new MautrixMetaClient({ baseUrl, fetchImpl }) });
const signal = new AbortController().signal;

const threadRows = [
  { thread_id: 'synth-meta-thread-001', preview: 'Synthetic list preview one.' },
  { thread_id: 'synth-meta-thread-002', preview: 'Synthetic list preview two.' }
];
const tailMessages = [
  { sender: 'other', text: 'Synthetic tail older.', sent_at: '2025-03-01T10:25:00.000Z' },
  { sender: 'you', text: 'Synthetic tail newest.', sent_at: '2025-03-01T10:30:00.000Z' }
];
// Chronological oldest-to-newest, distinct rows, so "the oldest was dropped" is assertable.
const olderPageRows = [
  { sender: 'you', text: 'Synthetic older row one.', sent_at: '2025-03-01T09:00:00.000Z' },
  { sender: 'other', text: 'Synthetic older row two.', sent_at: '2025-03-01T09:05:00.000Z' },
  { sender: 'you', text: 'Synthetic older row three.', sent_at: '2025-03-01T09:10:00.000Z' }
];

describe('MautrixMetaApiBackend', () => {
  it('passes a valid wire listing through with its coverage', async () => {
    const backend = backendWith(async () => ok({ threads: threadRows, truncated: true }));
    const page = await backend.listThreads({ limit: 10 }, signal);
    expect(page.threads).toEqual(threadRows);
    expect(page.truncated).toBe(true);
  });

  it('returns a tail read with its coverage intact', async () => {
    const backend = backendWith(async () => ok({ messages: tailMessages, coverage: { window: 'tail', scanned_rows: 2, truncated: true } }));
    const read = await backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal);
    expect(read).toEqual({
      thread_id: 'synth-meta-thread-001',
      messages: tailMessages,
      coverage: { window: 'tail', scanned_rows: 2, truncated: true }
    });
  });

  it('maps a 404 thread_not_found to null', async () => {
    const backend = backendWith(async () => ok({ error: { code: 'thread_not_found', message: 'Synthetic absence notice.' } }, 404));
    await expect(backend.readThread({ thread_id: 'synth-meta-missing' }, signal)).resolves.toBeNull();
  });

  it('still throws a different error code served at 404', async () => {
    const backend = backendWith(async () => ok({ error: { code: 'upstream_error', message: 'Synthetic upstream failure.' } }, 404));
    const failure = await backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProviderError);
    if (failure instanceof ProviderError) {
      expect(failure.code).toBe('UPSTREAM_ERROR');
      expect(failure.message).toBe('The mautrix-meta transport reported a failure reading Messenger.');
    }
  });

  it('refuses to read an absence label on a 5xx as a definitive NOT_FOUND', async () => {
    const backend = backendWith(async () => ok({ error: { code: 'thread_not_found', message: 'Synthetic failure wearing an absence label.' } }, 500));
    const failure = await backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProviderError);
    if (failure instanceof ProviderError) expect(failure.code).toBe('UPSTREAM_ERROR');
  });

  it('keeps retry_after when a 429 body is reclassified from status', async () => {
    const backend = backendWith(async () => new Response(JSON.stringify({ error: { code: 'mystery', message: 'not a known code' } }), { status: 429, headers: { 'retry-after': '30' } }));
    const failure = await backend.listThreads({ limit: 5 }, signal).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProviderError);
    if (failure instanceof ProviderError) {
      expect(failure.code).toBe('RATE_LIMITED');
      expect(failure.metadata.retry_after).toBe(30);
    }
  });

  it('sends before as unix milliseconds and echoes the ISO bound in coverage', async () => {
    let seenUrl = '';
    const backend = backendWith(async (input) => { seenUrl = String(input); return ok({ messages: tailMessages, coverage: { window: 'backfill', scanned_rows: 2, has_more_before: false } }); });
    const page = await backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-11-01T00:00:00.000Z', limit: 25 }, signal);
    expect(new URL(seenUrl).pathname).toBe('/v1/threads/synth-meta-thread-001/messages');
    // 2025-11-01T00:00:00.000Z is the LightSpeed paging unit this request crosses the wire as.
    expect(new URL(seenUrl).searchParams.get('before')).toBe('1761955200000');
    expect(new URL(seenUrl).searchParams.get('limit')).toBe('25');
    expect(page?.coverage.before).toBe('2025-11-01T00:00:00.000Z');
    expect(page?.coverage.truncated).toBe(false);
  });

  it('reports truncated when the provider range is not exhausted', async () => {
    const backend = backendWith(async () => ok({ messages: tailMessages, coverage: { window: 'backfill', scanned_rows: 5, has_more_before: true } }));
    const page = await backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-11-01T00:00:00.000Z', limit: 25 }, signal);
    expect(page?.coverage).toEqual({
      window: 'backfill',
      before: '2025-11-01T00:00:00.000Z',
      scanned_rows: 5,
      has_more_before: true,
      truncated: true
    });
  });

  it('drops the oldest rows of an over-long provider page and reports the loss', async () => {
    const backend = backendWith(async () => ok({ messages: olderPageRows, coverage: { window: 'backfill', scanned_rows: 3, has_more_before: false } }));
    const page = await backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-11-01T00:00:00.000Z', limit: 2 }, signal);
    // The oldest row (row one) is the end farthest from the requested bound: it is the one
    // the cap drops, and the provider's own `has_more_before: false` stays untouched.
    expect(page?.messages).toEqual([olderPageRows[1], olderPageRows[2]]);
    expect(page?.coverage.has_more_before).toBe(false);
    expect(page?.coverage.truncated).toBe(true);
  });

  it('does not truncate a page that is exactly the limit', async () => {
    const backend = backendWith(async () => ok({ messages: olderPageRows, coverage: { window: 'backfill', scanned_rows: 3, has_more_before: false } }));
    const page = await backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-11-01T00:00:00.000Z', limit: 3 }, signal);
    expect(page?.messages).toEqual(olderPageRows);
    expect(page?.coverage.has_more_before).toBe(false);
    expect(page?.coverage.truncated).toBe(false);
  });

  it('maps a 404 thread_not_found backfill to null', async () => {
    const backend = backendWith(async () => ok({ error: { code: 'thread_not_found', message: 'Synthetic absence notice.' } }, 404));
    await expect(backend.backfillThread({ thread_id: 'synth-meta-missing', before: '2025-11-01T00:00:00.000Z', limit: 25 }, signal)).resolves.toBeNull();
  });

  // The static per-code failure text: a validated code picks exactly one of the repo's own
  // strings, with its fixed metadata — never the provider body.
  const typedFailures = [
    { code: 'login_required', status: 401, providerError: { code: 'LOGIN_REQUIRED', message: 'The mautrix-meta transport has no authenticated session. Complete the native Messenger login in the transport service.', metadata: { action_required: 'native_login_in_transport_service' } } },
    { code: 'auth_expired', status: 401, providerError: { code: 'AUTH_EXPIRED', message: 'The mautrix-meta transport session expired. Re-run the native Messenger login in the transport service.', metadata: { action_required: 'native_login_in_transport_service' } } },
    { code: 'session_invalid', status: 403, providerError: { code: 'SESSION_INVALID', message: 'The mautrix-meta transport session is invalid. Re-run the native Messenger login in the transport service.', metadata: { action_required: 'native_login_in_transport_service' } } },
    { code: 'challenge_required', status: 403, providerError: { code: 'CAPTCHA_REQUIRED', message: 'Meta presents a challenge to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates challenges.', metadata: { action_required: 'manual_resolution_in_official_app' } } },
    { code: 'checkpoint_required', status: 403, providerError: { code: 'CAPTCHA_REQUIRED', message: 'Meta presents a checkpoint to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates checkpoints.', metadata: { action_required: 'manual_resolution_in_official_app' } } },
    { code: 'captcha_required', status: 403, providerError: { code: 'CAPTCHA_REQUIRED', message: 'Meta presents a captcha to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates captchas.', metadata: { action_required: 'manual_resolution_in_official_app' } } },
    { code: 'upstream_error', status: 502, providerError: { code: 'UPSTREAM_ERROR', message: 'The mautrix-meta transport reported a failure reading Messenger.', metadata: {} } }
  ] as const;

  for (const { code, status, providerError } of typedFailures) {
    it(`maps ${code} to the static ${providerError.code} failure`, async () => {
      // Provider text is deliberately adversarial: it must classify the failure but never
      // reach the thrown message.
      const backend = backendWith(async () => ok({ error: { code, message: 'secret cookie leaked' } }, status));
      const failure = await backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal).catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(ProviderError);
      if (failure instanceof ProviderError) {
        expect(failure.code).toBe(providerError.code);
        expect(failure.message).toBe(providerError.message);
        expect(failure.metadata).toEqual(providerError.metadata);
        expect(failure.message).not.toContain('secret cookie leaked');
      }
    });
  }

  it('maps rate_limited with a body retry_after into metadata', async () => {
    const backend = backendWith(async () => ok({ error: { code: 'rate_limited', message: 'secret cookie leaked', retry_after: 9 } }, 429));
    const failure = await backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProviderError);
    if (failure instanceof ProviderError) {
      expect(failure.code).toBe('RATE_LIMITED');
      expect(failure.message).toBe('The mautrix-meta transport is rate limited. Reduce request volume or wait before the next read.');
      expect(failure.metadata).toEqual({ retry_after: 9 });
      expect(failure.message).not.toContain('secret cookie leaked');
    }
  });

  it('classifies an unclassifiable error body by status fallback', async () => {
    // A body outside the pinned code vocabulary fails the error schema, so the failure is
    // re-derived from the HTTP status instead of the untrusted text.
    for (const [status, expectedCode] of [[401, 'LOGIN_REQUIRED'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_ERROR']] as const) {
      const backend = backendWith(async () => ok({ error: { code: 'mystery_code', message: 'secret cookie leaked' } }, status));
      const failure = await backend.listThreads({ limit: 10 }, signal).catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(ProviderError);
      if (failure instanceof ProviderError) {
        expect(failure.code).toBe(expectedCode);
        expect(failure.message).not.toContain('secret cookie leaked');
      }
    }
  });

  it('propagates an AbortError unchanged, not wrapped', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    const backend = backendWith(async () => { throw abortError; });
    await expect(backend.listThreads({ limit: 10 }, signal)).rejects.toBe(abortError);
    await expect(backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal)).rejects.toBe(abortError);
    await expect(backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-11-01T00:00:00.000Z', limit: 25 }, signal)).rejects.toBe(abortError);
  });

  it('fails closed on a success body this build does not recognize', async () => {
    const backend = backendWith(async () => ok({ nonsense: { definitely: 'not the pinned contract' } }));
    const failure = await backend.listThreads({ limit: 10 }, signal).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(ProviderError);
    if (failure instanceof ProviderError) {
      expect(failure.code).toBe('UPSTREAM_ERROR');
      expect(failure.message).toBe('The mautrix-meta transport returned a response this build does not recognize.');
    }
  });

  // Write tools gate on ConversationBackend methods; the meta boundary must not grow any
  // write-shaped method, on the API backend or the fixture (#195).
  const writeKeys = ['sendThread', 'prepareDraft', 'listConsumerThreads', 'searchConsumerThreads'] as const;
  it('exposes no write-shaped method on the API backend or the fixture', () => {
    const apiBackend = new MautrixMetaApiBackend({ client: new MautrixMetaClient({ baseUrl, fetchImpl: async () => ok({}) }) });
    const fixtureBackend = new FixtureMautrixMetaBackend();
    for (const key of writeKeys) {
      expect((apiBackend as Partial<Record<(typeof writeKeys)[number], unknown>>)[key]).toBeUndefined();
      expect((fixtureBackend as Partial<Record<(typeof writeKeys)[number], unknown>>)[key]).toBeUndefined();
    }
  });
});

describe('FixtureMautrixMetaBackend', () => {
  const backend = new FixtureMautrixMetaBackend();

  it('lists the synthetic threads with truthful truncation', () => {
    const page = backend.listThreads({ limit: 2 }, signal);
    expect(page.threads).toEqual(FIXTURE_META_THREADS.slice(0, 2));
    expect(page.truncated).toBe(true);
    const full = backend.listThreads({ limit: FIXTURE_META_THREADS.length }, signal);
    expect(full.threads).toEqual(FIXTURE_META_THREADS);
    expect(full.truncated).toBe(false);
  });

  it('reports a truncated tail for the long thread and a complete tail for the short one', () => {
    const long = backend.readThread({ thread_id: 'synth-meta-thread-001' }, signal);
    expect(long?.messages).toHaveLength(5);
    expect(long?.messages[0]?.text).toBe('Synthetic long message three.');
    expect(long?.coverage).toEqual({ window: 'tail', scanned_rows: 5, truncated: true });
    const short = backend.readThread({ thread_id: 'synth-meta-thread-002' }, signal);
    expect(short?.messages).toHaveLength(3);
    expect(short?.coverage).toEqual({ window: 'tail', scanned_rows: 3, truncated: false });
    expect(backend.readThread({ thread_id: 'synth-meta-missing' }, signal)).toBeNull();
  });

  it('pages a mid-window window with has_more_before and truncated true', () => {
    const page = backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-03-01T10:31:00.000Z', limit: 3 }, signal);
    expect(page?.messages.map((message) => message.text)).toEqual([
      'Synthetic long message five.',
      'Synthetic long reply six.',
      'Synthetic long message seven.'
    ]);
    expect(page?.coverage).toEqual({
      window: 'backfill',
      before: '2025-03-01T10:31:00.000Z',
      scanned_rows: 7,
      has_more_before: true,
      truncated: true
    });
  });

  it('reports the final page as exhausted, with the before boundary exclusive', () => {
    // The bound equals the second-oldest row's own sent_at: that row is excluded (exclusive
    // bound), so the only older row is the first, and the fixture holds nothing older still.
    const page = backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-03-01T10:05:00.000Z', limit: 25 }, signal);
    expect(page?.messages.map((message) => message.text)).toEqual(['Synthetic long message one.']);
    expect(page?.coverage).toEqual({
      window: 'backfill',
      before: '2025-03-01T10:05:00.000Z',
      scanned_rows: 1,
      has_more_before: false,
      truncated: false
    });
    // A short thread's whole history backfilled the same way is likewise provably complete.
    const whole = backend.backfillThread({ thread_id: 'synth-meta-thread-002', before: '2025-03-02T09:11:00.000Z', limit: 25 }, signal);
    expect(whole?.messages).toHaveLength(3);
    expect(whole?.coverage.has_more_before).toBe(false);
    expect(whole?.coverage.truncated).toBe(false);
  });

  it('drops the oldest window rows when the limit is smaller and reports the loss', () => {
    const page = backend.backfillThread({ thread_id: 'synth-meta-thread-001', before: '2025-03-01T10:21:00.000Z', limit: 2 }, signal);
    expect(page?.messages.map((message) => message.text)).toEqual(['Synthetic long reply four.', 'Synthetic long message five.']);
    expect(page?.coverage).toEqual({
      window: 'backfill',
      before: '2025-03-01T10:21:00.000Z',
      scanned_rows: 5,
      has_more_before: true,
      truncated: true
    });
    expect(backend.backfillThread({ thread_id: 'synth-meta-missing', before: '2025-03-01T10:21:00.000Z', limit: 2 }, signal)).toBeNull();
  });
});
