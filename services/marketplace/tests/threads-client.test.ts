import { describe, expect, it } from 'vitest';
import { ThreadsClient, ThreadsHttpError } from '../src/threads.js';

const options = { accessToken: 'synthetic-token', threadsUserId: 'synthetic-user-id', baseUrl: 'http://localhost' };
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe('ThreadsClient', () => {
  it('sends the Bearer header, the documented fields list, and threads_user_id in the path', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    const client = new ThreadsClient({ ...options, fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return ok({ data: [] });
    } });
    await client.listOwnPosts({ limit: 5 });
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/synthetic-user-id/threads');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('fields')).toContain('id');
    expect(url.searchParams.get('fields')).toContain('media_type');
    expect(url.searchParams.get('fields')).toContain('permalink');
    expect(url.searchParams.get('fields')).toContain('text');
    expect(url.searchParams.get('fields')).toContain('timestamp');
    // `threads_user_id` is mapped from `owner.id`, so `owner` must be requested or every
    // live post would map to `threads_user_id: null`.
    expect(url.searchParams.get('fields')).toContain('owner');
    expect(url.searchParams.get('fields')).toContain('reply_count');
    expect(url.searchParams.get('fields')).toContain('like_count');
    expect(url.searchParams.get('since')).toBeNull();
    expect(seenHeaders?.get('authorization')).toBe('Bearer synthetic-token');
    expect(seenHeaders?.get('accept')).toBe('application/json');
  });

  it('forwards the optional since calendar date verbatim', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listOwnPosts({ limit: 5, since: '2025-04-01' });
    const url = new URL(seenUrl);
    expect(url.searchParams.get('since')).toBe('2025-04-01');
  });

  it('forwards the optional after cursor for posts and replies', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listOwnPosts({ limit: 5, after: 'cursor-abc' });
    expect(new URL(seenUrl).searchParams.get('after')).toBe('cursor-abc');
    await client.listReplies({ mediaId: 'synth-thread-001', after: 'cursor-xyz' });
    expect(new URL(seenUrl).searchParams.get('after')).toBe('cursor-xyz');
  });

  it('omits an empty after cursor', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listOwnPosts({ limit: 5, after: '' });
    expect(new URL(seenUrl).searchParams.get('after')).toBeNull();
    await client.listReplies({ mediaId: 'synth-thread-001', after: '' });
    expect(new URL(seenUrl).searchParams.get('after')).toBeNull();
  });

  it('requests mentions on the operator path with the posts field projection', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    const client = new ThreadsClient({ ...options, fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return ok({ data: [] });
    } });
    await client.listMentions({ limit: 7, since: '2025-04-01', after: 'mentions-cursor-1' });
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/synthetic-user-id/mentions');
    expect(url.searchParams.get('limit')).toBe('7');
    // Mentions documents `since` as a Unix timestamp (unlike the user-posts endpoints'
    // date form), so the client converts the calendar date to UTC-midnight seconds.
    expect(url.searchParams.get('since')).toBe('1743465600');
    expect(url.searchParams.get('after')).toBe('mentions-cursor-1');
    // Mentions return Threads media objects, so the projection matches the user-posts
    // endpoints — including `owner`, because a mention's `threads_user_id` maps from the
    // mentioning author's `owner.id`.
    for (const field of ['id', 'media_type', 'permalink', 'text', 'timestamp', 'owner', 'reply_count', 'like_count']) {
      expect(url.searchParams.get('fields')).toContain(field);
    }
    expect(seenHeaders?.get('authorization')).toBe('Bearer synthetic-token');
  });

  it('omits absent and empty optional params on mentions requests', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listMentions({ limit: 5 });
    expect(new URL(seenUrl).searchParams.get('since')).toBeNull();
    expect(new URL(seenUrl).searchParams.get('after')).toBeNull();
    await client.listMentions({ limit: 5, after: '' });
    expect(new URL(seenUrl).searchParams.get('after')).toBeNull();
  });

  it('enforces the mentions since lower bound at the client boundary', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    // First whole UTC date whose midnight satisfies `>= 1688540400`.
    await client.listMentions({ limit: 5, since: '2023-07-06' });
    expect(new URL(seenUrl).searchParams.get('since')).toBe('1688601600');
    // 2023-07-05T00:00Z is below the documented bound: the client refuses before any request.
    seenUrl = '';
    await expect(client.listMentions({ limit: 5, since: '2023-07-05' })).rejects.toBeInstanceOf(TypeError);
    expect(seenUrl).toBe('');
    await expect(client.listMentions({ limit: 5, since: 'not-a-date' })).rejects.toBeInstanceOf(TypeError);
    // Day-invalid strings roll over under Date.UTC; the round-trip guard rejects them too.
    await expect(client.listMentions({ limit: 5, since: '2025-02-30' })).rejects.toBeInstanceOf(TypeError);
    expect(seenUrl).toBe('');
  });

  it('fetches a replies tree by media id with the documented fields list', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listReplies({ mediaId: 'synth-thread-001' });
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/synth-thread-001/replies');
    expect(url.searchParams.get('fields')).toContain('id');
    expect(url.searchParams.get('fields')).toContain('permalink');
    expect(url.searchParams.get('fields')).toContain('text');
    // Same as the posts projection: a reply's `threads_user_id` comes from `owner.id`.
    expect(url.searchParams.get('fields')).toContain('owner');
  });

  it('url-encodes path segments that contain reserved characters', async () => {
    let seenUrl = '';
    const client = new ThreadsClient({ ...options, fetchImpl: async (input) => { seenUrl = String(input); return ok({ data: [] }); } });
    await client.listReplies({ mediaId: 'media/with/slashes' });
    const url = new URL(seenUrl);
    expect(url.pathname).toBe('/media%2Fwith%2Fslashes/replies');
  });

  it('exposes a 401 as a typed HTTP error and never logs the token', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 401 }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ name: 'ThreadsHttpError', status: 401 });
  });

  it('preserves a numeric retry-after on 429', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '9' } }) });
    await expect(client.listReplies({ mediaId: 'synth-thread-001' })).rejects.toMatchObject({ status: 429, retryAfter: 9 });
  });

  it('treats a missing retry-after as no hint, not zero', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429 }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('truncates a malformed fractional retry-after to an integer', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '2.5' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: 2 });
  });

  it('treats a negative retry-after as no hint', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '-5' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('treats a nonnumeric retry-after as no hint', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': 'later' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('drops a retry-after that is not a plain decimal delay', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '1e21' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('drops a retry-after beyond the safe integer range', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '9007199254740992' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('treats a malformed-syntax retry-after as no hint', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '1e3' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('preserves a retry-after at the maximum safe integer', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '9007199254740991' } }) });
    await expect(client.listReplies({ mediaId: 'synth-thread-001' })).rejects.toMatchObject({ status: 429, retryAfter: 9007199254740991 });
  });

  it('treats a blank retry-after as no hint, not zero', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('treats a whitespace-only retry-after as no hint, not zero', async () => {
    const client = new ThreadsClient({ ...options, fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '   ' } }) });
    await expect(client.listOwnPosts({ limit: 1 })).rejects.toMatchObject({ status: 429, retryAfter: undefined });
  });

  it('validates constructor credentials and restricts the credential destination', () => {
    expect(() => new ThreadsClient({ ...options, accessToken: '  ' })).toThrow(TypeError);
    expect(() => new ThreadsClient({ ...options, accessToken: '' })).toThrow(TypeError);
    expect(() => new ThreadsClient({ ...options, threadsUserId: '' })).toThrow(TypeError);
    expect(() => new ThreadsClient({ ...options, threadsUserId: '  ' })).toThrow(TypeError);
    // Credential-destination restriction: the bearer token travels on every call, so
    // only the official Threads Graph host (HTTPS) and the loopback test seam are
    // acceptable targets. There is deliberately no env var that can move this.
    expect(() => new ThreadsClient({ ...options, baseUrl: 'https://graph.threads.net' })).not.toThrow();
    expect(() => new ThreadsClient({ ...options, baseUrl: 'http://127.0.0.1:4123' })).not.toThrow();
    expect(() => new ThreadsClient({ ...options, baseUrl: 'http://localhost:4123' })).not.toThrow();
    expect(() => new ThreadsClient({ ...options, baseUrl: 'https://evil.example.com' })).toThrow(TypeError);
    expect(() => new ThreadsClient({ ...options, baseUrl: 'http://graph.threads.net' })).toThrow(TypeError);
    expect(() => new ThreadsClient({ ...options, baseUrl: 'https://user:pass@graph.threads.net' })).toThrow(TypeError);
    expect(ThreadsHttpError).toBeDefined();
  });
});
