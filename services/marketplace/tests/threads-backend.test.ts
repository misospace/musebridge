import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ThreadsApiBackend } from '../src/threads-backend.js';
import { ProviderError } from '../src/backend.js';
import { threadsPostSchema, threadsReplySchema, threadsPostsListInputSchema, threadsRepliesListInputSchema } from '../src/domain.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/threads/${name}`, import.meta.url), 'utf8'));
let server: Server;
let origin = '';
let mode = 'normal';

beforeAll(async () => {
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (mode === 'hang') return;
    if (pathname.endsWith('/threads')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(
        mode === 'empty' ? fixture('posts-empty.json')
          : mode === 'malformed' ? fixture('posts-malformed.json')
            : fixture('posts-success.json')
      ));
      return;
    }
    if (pathname.endsWith('/replies')) {
      if (mode === 'replies-empty') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fixture('posts-empty.json')));
        return;
      }
      if (mode === 'replies-malformed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fixture('replies-malformed.json')));
        return;
      }
      if (mode === 'not-found') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture('replies-404.json'))); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fixture('replies-success.json')));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP server');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

function backend() { return new ThreadsApiBackend({ accessToken: 'synthetic', threadsUserId: 'synthetic-user-id', baseUrl: origin }); }
const signal = () => new AbortController().signal;
const postsInput = threadsPostsListInputSchema.parse({ limit: 10 });

describe('ThreadsApiBackend', () => {
  it('maps a full posts page into a valid ThreadsPost list', async () => {
    mode = 'normal';
    const posts = await backend().listOwnPosts(postsInput, signal());
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      threadsPostSchema.parse(post);
    }
    expect(posts[0]).toMatchObject({
      provider: 'threads',
      id: 'synth-thread-001',
      threads_user_id: 'synth_user',
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
      like_count: null
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

  it('returns an empty list when data is the documented zero-result page', async () => {
    mode = 'empty';
    await expect(backend().listOwnPosts(postsInput, signal())).resolves.toEqual([]);
  });

  it('rejects a posts response without an array data field as schema drift', async () => {
    mode = 'malformed';
    await expect(backend().listOwnPosts(postsInput, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads posts response was not recognized.'
    });
  });

  it('maps a full replies page into a valid ThreadsReply list and pins media_id to the parent', async () => {
    mode = 'normal';
    const replies = await backend().listReplies(threadsRepliesListInputSchema.parse({ media_id: 'synth-thread-001' }), signal());
    expect(replies).not.toBeNull();
    expect(replies).toHaveLength(2);
    for (const reply of replies!) {
      threadsReplySchema.parse(reply);
      expect(reply.media_id).toBe('synth-thread-001');
      expect(reply.provider).toBe('threads');
    }
    expect(replies![0]).toMatchObject({
      id: 'synth-reply-001',
      threads_user_id: 'synth_friend',
      media_type: 'TEXT_POST',
      media_urls: [],
      posted_at: '2025-04-01T10:00:00.000Z'
    });
    expect(replies![1]).toMatchObject({
      id: 'synth-reply-002',
      threads_user_id: 'synth_visitor',
      media_type: 'IMAGE',
      media_urls: ['https://www.threads.net/synth-reply-image-002.jpg']
    });
  });

  it('maps a 404 replies response to the house no-result case so the tool layer reports NOT_FOUND', async () => {
    mode = 'not-found';
    await expect(backend().listReplies(threadsRepliesListInputSchema.parse({ media_id: 'missing' }), signal())).resolves.toBeNull();
  });

  it('rejects a replies response without an array data field as schema drift', async () => {
    mode = 'replies-malformed';
    await expect(backend().listReplies(threadsRepliesListInputSchema.parse({ media_id: 'synth-thread-001' }), signal())).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR', message: 'The Threads replies response was not recognized.'
    });
  });

  it('honors an already-aborted signal as TIMEOUT', async () => {
    mode = 'hang';
    const controller = new AbortController(); controller.abort(new Error('caller aborted'));
    await expect(backend().listOwnPosts(postsInput, controller.signal)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('reports its backend name as "threads"', () => {
    expect(backend().name).toBe('threads');
    expect(ProviderError).toBeDefined();
  });
});