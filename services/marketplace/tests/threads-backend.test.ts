import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThreadsApiBackend } from '../src/threads-backend.js';
import { ProviderError } from '../src/backend.js';
import { threadsPostSchema, threadsReplySchema, threadsPostsListInputSchema, threadsRepliesListInputSchema } from '../src/domain.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/threads/${name}`, import.meta.url), 'utf8'));
let server: Server;
let origin = '';
let mode = 'normal';
let pagingContainerValue: unknown;
const seenAfters: Array<string | null> = [];

const postsPageOne = {
  data: [
    { id: 'synth-page1-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-page1-001', text: 'Synthetic page-one post A.', timestamp: '2025-04-01T09:30:00.000Z', username: 'synth_user' },
    { id: 'synth-page1-002', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-page1-002', text: 'Synthetic page-one post B.', timestamp: '2025-04-02T09:30:00.000Z', username: 'synth_user' }
  ],
  paging: { cursors: { after: 'cursor-2' } }
};
const postsPageTwo = {
  data: [
    { id: 'synth-page1-002', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-page1-002', text: 'Synthetic page-one post B.', timestamp: '2025-04-02T09:30:00.000Z', username: 'synth_user' },
    { id: 'synth-page1-003', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-page1-003', text: 'Synthetic page-two post C.', timestamp: '2025-04-03T09:30:00.000Z', username: 'synth_user' }
  ]
};
const repliesPageOne = {
  data: [
    { id: 'synth-reply-p1-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_friend/post/synth-reply-p1-001', text: 'Synthetic reply page one A.', timestamp: '2025-04-01T10:00:00.000Z', username: 'synth_friend' },
    { id: 'synth-reply-p1-002', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_friend/post/synth-reply-p1-002', text: 'Synthetic reply page one B.', timestamp: '2025-04-01T10:10:00.000Z', username: 'synth_friend' }
  ],
  paging: { cursors: { after: 'replies-cursor-2' } }
};
const repliesPageTwo = {
  data: [
    { id: 'synth-reply-p1-002', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_friend/post/synth-reply-p1-002', text: 'Synthetic reply page one B.', timestamp: '2025-04-01T10:10:00.000Z', username: 'synth_friend' },
    { id: 'synth-reply-p2-003', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_friend/post/synth-reply-p2-003', text: 'Synthetic reply page two C.', timestamp: '2025-04-01T10:20:00.000Z', username: 'synth_friend' }
  ]
};

const json = (response: ServerResponse, body: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (mode === 'hang') return;
    if (mode === 'unauthorized') { res.writeHead(401); res.end(); return; }
    if (mode === 'forbidden') { res.writeHead(403); res.end(); return; }
    if (mode === 'rate-limited') { res.writeHead(429, { 'retry-after': '7' }); res.end(); return; }
    if (mode === 'rate-limited-fractional') { res.writeHead(429, { 'retry-after': '1.5' }); res.end(); return; }
    if (mode === 'rate-limited-out-of-range') { res.writeHead(429, { 'retry-after': '1e21' }); res.end(); return; }
    if (pathname.endsWith('/threads')) {
      if (mode === 'empty') return json(res, fixture('posts-empty.json'));
      if (mode === 'malformed') return json(res, fixture('posts-malformed.json'));
      if (mode === 'posts-malformed-item') return json(res, { data: [{}] });
      if (mode === 'posts-mixed-captionless') return json(res, fixture('posts-mixed-captionless.json'));
      if (mode === 'posts-owner-id') return json(res, fixture('posts-owner-id.json'));
      if (mode === 'posts-media-cdn-hosts') return json(res, fixture('posts-media-cdn-hosts.json'));
      if (mode === 'posts-media-http-cdn') return json(res, fixture('posts-media-http-cdn.json'));
      if (mode === 'posts-lookalike-permalink') {
        // A captionless item whose permalink is a lookalike host: still schema drift, so the
        // permalink allowlist is not weakened by the captionless-text rule.
        return json(res, {
          data: [{ id: 'synth-lookalike-001', media_type: 'IMAGE', permalink: 'https://threads.com.evil.example/post/synth-lookalike-001', owner: { id: 'synth-owner-id-1001', username: 'synth_user' } }]
        });
      }
      if (mode === 'posts-bad-paging') {
        return json(res, {
          data: [{ id: 'synth-bad-paging-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-bad-paging-001', text: 'Synthetic post.', username: 'synth_user' }],
          paging: { next: 'not-a-url' }
        });
      }
      if (mode === 'posts-bad-cursor' || mode === 'posts-bad-cursors-shape' || mode === 'posts-array-cursors' || mode === 'posts-empty-cursor' || mode === 'posts-null-cursor') {
        const cursors =
          mode === 'posts-bad-cursor' ? { after: 42 } :
          mode === 'posts-bad-cursors-shape' ? 'cursor-2' :
          mode === 'posts-array-cursors' ? ['cursor-2'] :
          mode === 'posts-empty-cursor' ? { after: '' } :
          { after: null };
        return json(res, {
          data: [{ id: 'synth-bad-cursor-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-bad-cursor-001', text: 'Synthetic post.', username: 'synth_user' }],
          paging: { cursors }
        });
      }
      if (mode === 'posts-paging-container') {
        return json(res, {
          data: [{ id: 'synth-paging-container-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_user/post/synth-paging-container-001', text: 'Synthetic post.', username: 'synth_user' }],
          paging: pagingContainerValue
        });
      }
      if (mode === 'pagination') {
        const after = url.searchParams.get('after');
        seenAfters.push(after);
        return json(res, after === 'cursor-2' ? postsPageTwo : postsPageOne);
      }
      return json(res, fixture('posts-success.json'));
    }
    if (pathname.endsWith('/replies')) {
      if (mode === 'replies-empty') return json(res, fixture('posts-empty.json'));
      if (mode === 'replies-malformed') return json(res, fixture('replies-malformed.json'));
      if (mode === 'replies-malformed-item') return json(res, { data: [{}] });
      if (mode === 'replies-mixed-captionless') return json(res, fixture('replies-mixed-captionless.json'));
      if (mode === 'replies-paging-container') {
        return json(res, {
          data: [{ id: 'synth-reply-pc-001', media_type: 'TEXT_POST', permalink: 'https://www.threads.net/@synth_friend/post/synth-reply-pc-001', text: 'Synthetic reply.', username: 'synth_friend' }],
          paging: pagingContainerValue
        });
      }
      if (mode === 'replies-pagination') {
        const after = url.searchParams.get('after');
        seenAfters.push(after);
        return json(res, after === 'replies-cursor-2' ? repliesPageTwo : repliesPageOne);
      }
      if (mode === 'not-found') { json(res, fixture('replies-404.json'), 404); return; }
      return json(res, fixture('replies-success.json'));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

function backend(options: { requestTimeoutMs?: number } = {}) {
  return new ThreadsApiBackend({ accessToken: 'synthetic', threadsUserId: 'synthetic-user-id', baseUrl: origin }, options);
}
const signal = () => new AbortController().signal;
const postsInput = threadsPostsListInputSchema.parse({ limit: 10 });
const repliesInput = threadsRepliesListInputSchema.parse({ media_id: 'synth-thread-001' });

describe('ThreadsApiBackend', () => {
  it('maps a full posts page into a valid ThreadsPost list', async () => {
    mode = 'normal';
    const { posts, truncated } = await backend().listOwnPosts(postsInput, signal());
    expect(posts).toHaveLength(3);
    expect(truncated).toBe(false);
    for (const post of posts) {
      threadsPostSchema.parse(post);
    }
    expect(posts[0]).toMatchObject({
      provider: 'threads',
      id: 'synth-thread-001',
      threads_user_id: 'synth-owner-id-1001',
      permalink: 'https://www.threads.net/@synth_user/post/synth-thread-001',
      media_type: 'TEXT_POST',
      media_urls: [],
      reply_count: 4,
      like_count: 22,
      posted_at: '2025-04-01T09:30:00.000Z'
    });
    expect(posts[1]).toMatchObject({
      id: 'synth-thread-002',
      media_type: 'IMAGE',
      media_urls: ['https://www.threads.net/synth-image-002.jpg'],
      reply_count: null,
      like_count: null,
      text: 'Synthetic fixture thread: image post with no caption counts.'
    });
    expect(posts[2]).toMatchObject({
      id: 'synth-thread-003',
      media_type: 'VIDEO',
      media_urls: ['https://www.threads.net/synth-video-003.mp4', 'https://www.threads.net/synth-thumbnail-003.jpg'],
      reply_count: 0,
      like_count: 5,
      posted_at: null
    });
  });

  it('returns an empty page when data is the documented zero-result page', async () => {
    mode = 'empty';
    await expect(backend().listOwnPosts(postsInput, signal())).resolves.toEqual({ posts: [], truncated: false });
  });

  it('rejects a posts response without an array data field as schema drift', async () => {
    mode = 'malformed';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads posts response was not recognized.'
    });
  });

  it('rejects a malformed item inside an array posts data as schema drift', async () => {
    mode = 'posts-malformed-item';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads posts response was not recognized.'
    });
  });

  it('rejects an unresolvable paging cursor as schema drift instead of claiming completeness', async () => {
    mode = 'posts-bad-paging';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging cursor was not recognized.'
    });
  });

  it('rejects a non-string cursors.after with no paging.next as schema drift instead of claiming completeness', async () => {
    mode = 'posts-bad-cursor';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging cursor was not recognized.'
    });
  });

  it('rejects an unreadable cursors field with no paging.next as schema drift', async () => {
    mode = 'posts-bad-cursors-shape';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging cursor was not recognized.'
    });
  });

  it('rejects an array cursors field with no paging.next as schema drift', async () => {
    mode = 'posts-array-cursors';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging cursor was not recognized.'
    });
  });

  it('rejects an empty cursors.after with no paging.next as schema drift', async () => {
    mode = 'posts-empty-cursor';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging cursor was not recognized.'
    });
  });

  it('still reports an exhausted page when the provider sends a null cursors.after', async () => {
    mode = 'posts-null-cursor';
    await expect(backend().listOwnPosts(postsInput, signal())).resolves.toMatchObject({ truncated: false });
  });

  it.each([
    ['a string', 'unexpected'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['cursor-2']],
    ['an empty string', ''],
    ['a zero', 0],
    ['a false', false]
  ])('rejects a posts page whose paging container is %s as schema drift instead of claiming completeness', async (_label, value) => {
    mode = 'posts-paging-container';
    pagingContainerValue = value;
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging container was not recognized.'
    });
  });

  it.each([
    ['a string', 'unexpected'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['cursor-2']],
    ['an empty string', ''],
    ['a zero', 0],
    ['a false', false]
  ])('rejects a replies page whose paging container is %s as schema drift instead of claiming completeness', async (_label, value) => {
    mode = 'replies-paging-container';
    pagingContainerValue = value;
    await expect(backend().listReplies(repliesInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads response paging container was not recognized.'
    });
  });

  it('treats an omitted or null paging field as a legitimately exhausted page', async () => {
    // The documented no-pagination shape: posts-success.json omits `paging` entirely, and an
    // explicit `paging: null` is the same exhausted-page case, not schema drift.
    mode = 'normal';
    await expect(backend().listOwnPosts(postsInput, signal())).resolves.toMatchObject({ truncated: false });
    mode = 'posts-paging-container';
    pagingContainerValue = null;
    await expect(backend().listOwnPosts(postsInput, signal())).resolves.toMatchObject({ truncated: false });
    mode = 'replies-paging-container';
    pagingContainerValue = null;
    await expect(backend().listReplies(repliesInput, signal())).resolves.toMatchObject({ truncated: false });
  });

  it('marks a page exhausted at the exact limit as complete, not truncated', async () => {
    // posts-success.json holds exactly three posts with no paging cursor.
    mode = 'normal';
    const exact = await backend().listOwnPosts(threadsPostsListInputSchema.parse({ limit: 3 }), signal());
    expect(exact.posts).toHaveLength(3);
    expect(exact.truncated).toBe(false);
    const capped = await backend().listOwnPosts(threadsPostsListInputSchema.parse({ limit: 2 }), signal());
    expect(capped.posts).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('maps a full replies page into a valid ThreadsReply list and pins media_id to the parent', async () => {
    mode = 'normal';
    const result = await backend().listReplies(repliesInput, signal());
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.replies).toHaveLength(2);
    for (const reply of result!.replies) {
      threadsReplySchema.parse(reply);
      expect(reply.media_id).toBe('synth-thread-001');
      expect(reply.provider).toBe('threads');
    }
    expect(result!.replies[0]).toMatchObject({
      id: 'synth-reply-001',
      threads_user_id: 'synth-owner-id-2001',
      media_type: 'TEXT_POST',
      media_urls: [],
      posted_at: '2025-04-01T10:00:00.000Z'
    });
    expect(result!.replies[1]).toMatchObject({
      id: 'synth-reply-002',
      threads_user_id: 'synth-owner-id-2002',
      media_type: 'IMAGE',
      media_urls: ['https://www.threads.net/synth-reply-image-002.jpg']
    });
  });

  it('maps a 404 replies response to the house no-result case so the tool layer reports NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().listReplies(repliesInput, signal())).resolves.toBeNull();
  });

  it('rejects a replies response without an array data field as schema drift', async () => {
    mode = 'replies-malformed';
    await expect(backend().listReplies(repliesInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads replies response was not recognized.'
    });
  });

  it('rejects a malformed item inside an array replies data as schema drift', async () => {
    mode = 'replies-malformed-item';
    await expect(backend().listReplies(repliesInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads replies response was not recognized.'
    });
  });

  it('maps 401 and 403 to AUTH_EXPIRED', async () => {
    mode = 'unauthorized';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    mode = 'forbidden';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('maps 429 with a retry-after hint to RATE_LIMITED carrying retry_after', async () => {
    mode = 'rate-limited';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'RATE_LIMITED', metadata: { retry_after: 7 }
    });
  });

  it('maps a 429 with a fractional retry-after to RATE_LIMITED carrying a truncated hint', async () => {
    mode = 'rate-limited-fractional';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'RATE_LIMITED', metadata: { retry_after: 1 }
    });
  });

  it('maps a 429 with a beyond-safe-range retry-after to RATE_LIMITED with no retry hint', async () => {
    mode = 'rate-limited-out-of-range';
    const rejection = backend().listOwnPosts(postsInput, signal());
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    const error = await rejection.then(
      () => { throw new Error('expected the Threads posts list to reject'); },
      (thrown: unknown) => thrown as ProviderError
    );
    expect(error.code).toBe('RATE_LIMITED');
    // No hint at all beats a fabricated one: the out-of-range value is dropped, not clamped.
    expect(error.metadata.retry_after).toBeUndefined();
    expect('retry_after' in error.metadata).toBe(false);
  });

  it('follows the paging cursor, dedupes repeated ids, and preserves order', async () => {
    mode = 'pagination';
    seenAfters.length = 0;
    const { posts, truncated } = await backend().listOwnPosts(threadsPostsListInputSchema.parse({ limit: 10 }), signal());
    expect(posts.map((post) => post.id)).toEqual(['synth-page1-001', 'synth-page1-002', 'synth-page1-003']);
    expect(truncated).toBe(false);
    expect(seenAfters).toEqual([null, 'cursor-2']);
  });

  it('marks the result truncated when the limit is reached mid-page with more pages available', async () => {
    mode = 'pagination';
    seenAfters.length = 0;
    const { posts, truncated } = await backend().listOwnPosts(threadsPostsListInputSchema.parse({ limit: 1 }), signal());
    expect(posts.map((post) => post.id)).toEqual(['synth-page1-001']);
    expect(truncated).toBe(true);
    expect(seenAfters).toEqual([null]);
  });

  it('follows the replies paging cursor and dedupes repeated ids', async () => {
    mode = 'replies-pagination';
    seenAfters.length = 0;
    const result = await backend().listReplies(repliesInput, signal());
    expect(result).not.toBeNull();
    expect(result!.replies.map((reply) => reply.id)).toEqual(['synth-reply-p1-001', 'synth-reply-p1-002', 'synth-reply-p2-003']);
    expect(result!.truncated).toBe(false);
    expect(seenAfters).toEqual([null, 'replies-cursor-2']);
  });

  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().listOwnPosts(postsInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports a real deadline expiry as TIMEOUT against a hanging server', async () => {
    mode = 'hang';
    await expect(backend({ requestTimeoutMs: 25 }).listOwnPosts(postsInput, signal())).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports its backend name as "threads"', () => {
    expect(backend().name).toBe('threads');
    expect(ProviderError).toBeDefined();
  });

  it('accepts permalinks on threads.com and threads.net but rejects lookalike hosts and http', () => {
    const base = {
      provider: 'threads' as const,
      id: 'synth-permalink-001',
      threads_user_id: null,
      text: 'Synthetic permalink host probe.',
      media_type: 'TEXT_POST' as const,
      media_urls: [],
      reply_count: null,
      like_count: null,
      posted_at: null
    };
    for (const permalink of [
      'https://www.threads.com/@synth_user/post/synth-permalink-001',
      'https://threads.com/@synth_user/post/synth-permalink-001',
      'https://www.threads.net/@synth_user/post/synth-permalink-001',
      'https://threads.net/@synth_user/post/synth-permalink-001'
    ]) {
      const parsed = threadsPostSchema.safeParse({ ...base, permalink });
      expect(parsed.success, permalink).toBe(true);
    }
    for (const permalink of [
      'https://threads.com.evil.example/post/x',
      'https://notthreads.com/post/x',
      'https://threads.co/post/x',
      'https://threads.net.attacker.example/post/x',
      'http://www.threads.com/post/x',
      'http://www.threads.net/post/x',
      'https://user:pass@www.threads.com/post/x'
    ]) {
      const parsed = threadsPostSchema.safeParse({ ...base, permalink });
      expect(parsed.success, permalink).toBe(false);
    }
  });

  it('returns a mixed page with a captionless post instead of failing the whole page', async () => {
    // The captioned post carries an official threads.com permalink: accepting that host is
    // what keeps the page from dying on a normal primary-host response.
    mode = 'posts-mixed-captionless';
    const { posts, truncated } = await backend().listOwnPosts(postsInput, signal());
    expect(truncated).toBe(false);
    expect(posts.map((post) => post.id)).toEqual(['synth-caption-001', 'synth-caption-002']);
    expect(posts[0]).toMatchObject({
      permalink: 'https://www.threads.com/@synth_user/post/synth-caption-001',
      text: 'Synthetic page-one post A: captioned, on the primary threads.com host.',
      media_type: 'TEXT_POST',
      threads_user_id: 'synth-owner-id-1001'
    });
    expect(posts[1]).toMatchObject({
      id: 'synth-caption-002',
      permalink: 'https://www.threads.com/@synth_user/post/synth-caption-002',
      media_type: 'IMAGE',
      media_urls: ['https://www.threads.com/synth-caption-image-002.jpg'],
      text: null
    });
    // An absent caption is explicit null, never an empty string on the wire.
    expect(threadsPostSchema.safeParse({ ...posts[1], text: '' }).success).toBe(false);
  });

  it('returns a mixed replies page with a captionless reply instead of failing the whole page', async () => {
    mode = 'replies-mixed-captionless';
    const result = await backend().listReplies(repliesInput, signal());
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.replies.map((reply) => reply.id)).toEqual(['synth-reply-caption-001', 'synth-reply-caption-002']);
    expect(result!.replies[0]).toMatchObject({
      text: 'Synthetic reply page one A: captioned.',
      media_type: 'TEXT_POST',
      media_id: 'synth-thread-001'
    });
    expect(result!.replies[1]).toMatchObject({
      id: 'synth-reply-caption-002',
      media_type: 'IMAGE',
      media_id: 'synth-thread-001',
      text: null
    });
    for (const reply of result!.replies) threadsReplySchema.parse(reply);
  });

  it('maps threads_user_id from owner.id and never from the username handle', async () => {
    mode = 'posts-owner-id';
    const { posts } = await backend().listOwnPosts(postsInput, signal());
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ id: 'synth-owner-001', threads_user_id: 'synth-owner-id-7788990011' });
    // An item with no owner still parses; it is not dropped and no handle is relabelled.
    expect(posts[1]).toMatchObject({ id: 'synth-owner-002', threads_user_id: null });
  });

  it('still rejects a captionless item whose permalink is a lookalike host as schema drift', async () => {
    mode = 'posts-lookalike-permalink';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads posts response was not recognized.'
    });
  });

  it('accepts media URLs on the official Meta CDN hosts and preserves them in media_urls', async () => {
    // Real `media_url` / `thumbnail_url` values are served from these roots, so rejecting
    // them would fail an otherwise valid live page.
    mode = 'posts-media-cdn-hosts';
    const { posts, truncated } = await backend().listOwnPosts(postsInput, signal());
    expect(truncated).toBe(false);
    expect(posts[0]).toMatchObject({
      id: 'synth-cdn-001',
      permalink: 'https://www.threads.net/@synth_user/post/synth-cdn-001',
      threads_user_id: 'synth-owner-id-1001',
      media_urls: ['https://scontent-xx.cdninstagram.com/v/synth-image-001.jpg', 'https://scontent.xx.fbcdn.net/v/synth-thumb-001.jpg']
    });
    threadsPostSchema.parse(posts[0]);
  });

  it('returns both posts on a mixed page and drops a lookalike media host instead of failing the page', async () => {
    // A media URL is a display artifact: a URL on an unapproved host is dropped, never
    // returned and never rewritten, and it is not a reason to discard the whole page.
    mode = 'posts-media-cdn-hosts';
    const { posts } = await backend().listOwnPosts(postsInput, signal());
    expect(posts.map((post) => post.id)).toEqual(['synth-cdn-001', 'synth-cdn-002']);
    expect(posts[1]).toMatchObject({
      permalink: 'https://www.threads.net/@synth_user/post/synth-cdn-002',
      media_type: 'IMAGE',
      media_urls: []
    });
    for (const post of posts) {
      threadsPostSchema.parse(post);
      for (const url of post.media_urls) expect(url).not.toContain('evil.example');
    }
  });

  it('drops an http CDN media URL while keeping its https sibling', async () => {
    // https-only holds on the CDN roots too: the insecure URL is dropped, not upgraded.
    mode = 'posts-media-http-cdn';
    const { posts } = await backend().listOwnPosts(postsInput, signal());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: 'synth-cdn-http-001',
      text: null,
      media_urls: ['https://scontent.xx.fbcdn.net/v/synth-thumb-001.jpg']
    });
  });

  it('accepts official Meta CDN hosts in media_urls but rejects lookalikes, http, and non-https forms', () => {
    const base = {
      provider: 'threads' as const,
      id: 'synth-media-host-001',
      threads_user_id: null,
      permalink: 'https://www.threads.com/@synth_user/post/synth-media-host-001',
      text: 'Synthetic media host probe.',
      media_type: 'IMAGE' as const,
      reply_count: null,
      like_count: null,
      posted_at: null
    };
    for (const url of [
      'https://cdninstagram.com/v/synth-image.jpg',
      'https://scontent-xx.cdninstagram.com/v/synth-image.jpg',
      'https://fbcdn.net/v/synth-image.jpg',
      'https://scontent.xx.fbcdn.net/v/synth-image.jpg',
      'https://www.threads.net/synth-image.jpg',
      'https://www.threads.com/synth-image.jpg'
    ]) {
      const parsed = threadsPostSchema.safeParse({ ...base, media_urls: [url] });
      expect(parsed.success, url).toBe(true);
    }
    for (const url of [
      'https://scontent.cdninstagram.com.evil.example/v/synth-image.jpg',
      'https://evil.example/v/synth-image.jpg',
      'https://notcdninstagram.com/v/synth-image.jpg',
      'https://notfbcdn.net/v/synth-image.jpg',
      'https://cdninstagram.com.evil.example/v/synth-image.jpg',
      'https://fbcdn.net.attacker.example/v/synth-image.jpg',
      'http://scontent-xx.cdninstagram.com/v/synth-image.jpg',
      'https://user:pass@scontent.xx.fbcdn.net/v/synth-image.jpg'
    ]) {
      const parsed = threadsPostSchema.safeParse({ ...base, media_urls: [url] });
      expect(parsed.success, url).toBe(false);
    }
    // The CDN roots are a media-URL allowance only: a permalink still requires the exact
    // Threads hosts, so the wider display allowlist never leaks into navigation targets.
    const leak = threadsPostSchema.safeParse({ ...base, permalink: 'https://scontent.xx.fbcdn.net/v/synth-image.jpg' });
    expect(leak.success).toBe(false);
  });
});

describe('ThreadsApiBackend requestTimeoutMs validation', () => {
  // setTimeout coerces delays above 2^31-1 ms to 1, so an out-of-range value must fail at
  // construction rather than abort every request instantly (#119).
  it.each([2_147_483_648, 4_294_967_296, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])(
    'rejects %s at construction', (requestTimeoutMs) => {
      expect(() => backend({ requestTimeoutMs })).toThrow(RangeError);
    }
  );
  it('accepts the 2^31-1 upper bound', () => {
    expect(() => backend({ requestTimeoutMs: 2_147_483_647 })).not.toThrow();
  });
  it.each([0, -1, 1.5, Number.NaN])('keeps rejecting invalid %s', (requestTimeoutMs) => {
    expect(() => backend({ requestTimeoutMs })).toThrow(RangeError);
  });
});
