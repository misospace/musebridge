import { describe, expect, it } from 'vitest';
import { MessengerInboxGraphQLCollector, parseMessengerInboxGraphQLResponse } from '../src/facebook-messenger-inbox-graphql.js';

function response(edges: unknown[], pageInfo: Record<string, unknown> | undefined = undefined) {
  const connection: Record<string, unknown> = { edges };
  if (pageInfo) connection.page_info = pageInfo;
  return { data: { viewer: { marketplaceInboxBuyerMessageThreads: connection } } };
}
function edge(threadId: unknown, extra: Record<string, unknown> = {}) {
  return { node: { __typename: 'MessageThread', thread_key: { thread_fbid: threadId }, ...extra } };
}

describe('Messenger inbox GraphQL response parsing', () => {
  it('parses valid connections, deduplicates ids, and accepts literal and base64 thread ids', () => {
    const base64Id = Buffer.from('message_thread:abc').toString('base64');
    expect(parseMessengerInboxGraphQLResponse(response([edge('abc'), edge('abc', { id: 'message_thread:abc' }), edge('abc', { id: base64Id })]))).toEqual({
      kind: 'connection', threadIds: ['abc'], empty: false, malformed: false, incomplete: false
    });
  });

  it('recognizes a well-formed empty connection', () => {
    expect(parseMessengerInboxGraphQLResponse(response([]))).toEqual({
      kind: 'connection', threadIds: [], empty: true, malformed: false, incomplete: false
    });
    expect(parseMessengerInboxGraphQLResponse(response([], { has_next_page: false }))).toEqual({
      kind: 'connection', threadIds: [], empty: true, malformed: false, incomplete: false
    });
  });

  it('marks an empty current slice with has_next_page incomplete instead of empty', () => {
    expect(parseMessengerInboxGraphQLResponse(response([], { has_next_page: true }))).toEqual({
      kind: 'connection', threadIds: [], empty: false, malformed: false, incomplete: true
    });
  });

  it('marks a non-empty connection with has_next_page incomplete even when edges were returned', () => {
    // Regression for the previous `hasMorePages(connection) && threadIds.length === 0` guard,
    // which made the flag unreachable whenever the current slice had any thread.
    expect(parseMessengerInboxGraphQLResponse(response([edge('12345678')], { has_next_page: true }))).toEqual({
      kind: 'connection', threadIds: ['12345678'], empty: false, malformed: false, incomplete: true
    });
  });

  it('marks invalid thread keys and inconsistent ids malformed without returning them', () => {
    const mismatchedBase64 = Buffer.from('message_thread:other').toString('base64');
    for (const item of [
      edge('not numeric?'),
      edge('valid', { id: 'message_thread:other' }),
      edge('valid', { id: mismatchedBase64 }),
      edge('valid', { id: 'message_thread:valid:extra' }),
      edge(123)
    ]) {
      expect(parseMessengerInboxGraphQLResponse(response([item]))).toMatchObject({ kind: 'connection', threadIds: [], malformed: true, incomplete: false });
    }
  });

  it('ignores unrelated payloads and marks malformed connections', () => {
    expect(parseMessengerInboxGraphQLResponse(null)).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: {} } })).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: null } } } }))
      .toMatchObject({ kind: 'connection', malformed: true });
    expect(parseMessengerInboxGraphQLResponse(response([null, { node: null }]))).toMatchObject({ kind: 'connection', malformed: true });
  });

  it('bounds ids and tolerates hostile inputs in observe', () => {
    const collector = new MessengerInboxGraphQLCollector({ maxThreads: 1 });
    expect(() => {
      collector.observe(response([edge('first'), edge('second')]));
      collector.observe(Object.create(null));
      collector.observe(new Proxy({}, { get: () => { throw new Error('hostile'); } }));
    }).not.toThrow();
    expect(collector.snapshot()).toEqual({ recognized: true, malformed: true, empty: false, incomplete: false, threadIds: ['first'] });
  });

  it('does not report empty when an observed response is paginated but the current slice is empty', () => {
    const collector = new MessengerInboxGraphQLCollector();
    collector.observe(response([], { has_next_page: true }));
    expect(collector.snapshot()).toEqual({
      recognized: true,
      malformed: false,
      empty: false,
      incomplete: true,
      threadIds: []
    });
  });

  it('does not let a later paginated empty response overwrite prior thread ids', () => {
    const collector = new MessengerInboxGraphQLCollector();
    collector.observe(response([edge('12345678')]));
    collector.observe(response([], { has_next_page: true }));
    expect(collector.snapshot()).toMatchObject({
      recognized: true,
      empty: false,
      incomplete: true,
      threadIds: ['12345678']
    });
  });

  it('reports incomplete for a non-empty paginated connection even without a follow-up empty slice', () => {
    // Regression for the previous `hasMorePages && threadIds.length === 0` guard, which meant a
    // single observed paginated-but-non-empty connection was reported as complete.
    const collector = new MessengerInboxGraphQLCollector();
    collector.observe(response([edge('12345678')], { has_next_page: true }));
    expect(collector.snapshot()).toEqual({
      recognized: true,
      malformed: false,
      empty: false,
      incomplete: true,
      threadIds: ['12345678']
    });
  });
});
