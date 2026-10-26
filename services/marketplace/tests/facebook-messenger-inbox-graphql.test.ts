import { describe, expect, it } from 'vitest';
import {
  MessengerInboxGraphQLCollector,
  MESSENGER_INBOX_OPERATIONS,
  parseMessengerInboxGraphQLRequest,
  parseMessengerInboxGraphQLResponse
} from '../src/facebook-messenger-inbox-graphql.js';

const terminal = { has_next_page: false, end_cursor: null };

function response(edges: unknown[], pageInfo: Record<string, unknown> | null = terminal) {
  const connection: Record<string, unknown> = { edges };
  if (pageInfo) connection.page_info = pageInfo;
  return { data: { viewer: { marketplaceInboxBuyerMessageThreads: connection } } };
}

function edge(threadId: unknown, extra: Record<string, unknown> = {}) {
  return { node: { __typename: 'MessageThread', thread_key: { thread_fbid: threadId }, ...extra } };
}

function ids(start: number, count: number): string[] {
  return Array.from({ length: count }, (_value, index) => String(start + index).padStart(8, '0'));
}

function edges(threadIds: string[]): unknown[] {
  return threadIds.map((threadId) => edge(threadId));
}

function observe(collector: MessengerInboxGraphQLCollector, payload: unknown, cursor: string | null = null): void {
  collector.observe(payload, { kind: 'page', cursor });
}

describe('Messenger inbox GraphQL request parsing', () => {
  it('identifies the initial request and reads the continuation cursor from JSON or form data', () => {
    expect(parseMessengerInboxGraphQLRequest({
      body: JSON.stringify({ operationName: MESSENGER_INBOX_OPERATIONS[0], variables: { count: 12 } })
    })).toEqual({ kind: 'page', cursor: null });

    const body = new URLSearchParams({
      fb_api_req_friendly_name: MESSENGER_INBOX_OPERATIONS[1],
      variables: JSON.stringify({ cursor: 'cursor-one', count: 12 })
    }).toString();
    expect(parseMessengerInboxGraphQLRequest({ body })).toEqual({ kind: 'page', cursor: 'cursor-one' });
  });

  it('does not treat unrelated or cursor-ambiguous operations as pagination evidence', () => {
    expect(parseMessengerInboxGraphQLRequest({
      body: JSON.stringify({ operationName: 'UnrelatedMarketplaceQuery' })
    })).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLRequest({
      body: JSON.stringify({ operationName: MESSENGER_INBOX_OPERATIONS[1], variables: { count: 12 } })
    })).toEqual({ kind: 'unverified', knownInboxOperation: true });
  });
});

describe('Messenger inbox GraphQL response parsing', () => {
  it('parses valid terminal connections, deduplicates ids, and accepts literal and base64 ids', () => {
    const base64Id = Buffer.from('message_thread:abc').toString('base64');
    expect(parseMessengerInboxGraphQLResponse(response([
      edge('abc'),
      edge('abc', { id: 'message_thread:abc' }),
      edge('abc', { id: base64Id })
    ]))).toEqual({
      kind: 'connection', threadIds: ['abc'], empty: false, malformed: false, incomplete: false,
      pageInfo: { hasNextPage: false, endCursor: null }
    });
  });

  it('recognizes an empty terminal connection only with explicit page_info', () => {
    expect(parseMessengerInboxGraphQLResponse(response([]))).toEqual({
      kind: 'connection', threadIds: [], empty: true, malformed: false, incomplete: false,
      pageInfo: { hasNextPage: false, endCursor: null }
    });
  });

  it('marks empty and non-empty non-terminal pages as incomplete until the collector follows them', () => {
    expect(parseMessengerInboxGraphQLResponse(response([], { has_next_page: true, end_cursor: 'cursor-one' }))).toEqual({
      kind: 'connection', threadIds: [], empty: false, malformed: false, incomplete: true,
      pageInfo: { hasNextPage: true, endCursor: 'cursor-one' }
    });
    expect(parseMessengerInboxGraphQLResponse(response(edges(['12345678']), { has_next_page: true, end_cursor: 'cursor-one' })))
      .toMatchObject({ kind: 'connection', threadIds: ['12345678'], incomplete: true });
  });

  it('treats absent or malformed page_info as unverified', () => {
    expect(parseMessengerInboxGraphQLResponse(response([], null))).toMatchObject({
      kind: 'connection', empty: false, malformed: false, incomplete: true
    });
    expect(parseMessengerInboxGraphQLResponse(response([], { has_next_page: 'no' }))).toMatchObject({
      kind: 'connection', empty: false, malformed: true, incomplete: true
    });
    expect(parseMessengerInboxGraphQLResponse(response([], { has_next_page: true }))).toMatchObject({
      kind: 'connection', empty: false, malformed: true, incomplete: true
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
      expect(parseMessengerInboxGraphQLResponse(response([item]))).toMatchObject({
        kind: 'connection', threadIds: [], malformed: true, incomplete: false
      });
    }
  });

  it('ignores unrelated payloads and marks malformed connections', () => {
    expect(parseMessengerInboxGraphQLResponse(null)).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: {} } })).toEqual({ kind: 'unrelated' });
    expect(parseMessengerInboxGraphQLResponse({ data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: null } } } }))
      .toMatchObject({ kind: 'connection', malformed: true, incomplete: true });
    expect(parseMessengerInboxGraphQLResponse(response([null, { node: null }]))).toMatchObject({
      kind: 'connection', malformed: true
    });
  });
});

describe('Messenger inbox GraphQL pagination coverage', () => {
  it('proves coverage for two pages containing the observed 12 plus 12 thread shape', () => {
    const firstPageIds = ids(1, 12);
    const secondPageIds = ids(13, 12);
    const collector = new MessengerInboxGraphQLCollector({ maxThreads: 40 });

    observe(collector, response(edges(firstPageIds), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(secondPageIds), { has_next_page: false, end_cursor: 'cursor-two' }), 'cursor-one');

    expect(collector.snapshot()).toEqual({
      recognized: true,
      malformed: false,
      empty: false,
      incomplete: false,
      truncated: false,
      threadIds: [...firstPageIds, ...secondPageIds]
    });
  });

  it('orders pages by their request cursors when terminal response arrives first', () => {
    const firstPageIds = ids(1, 12);
    const secondPageIds = ids(13, 12);
    const collector = new MessengerInboxGraphQLCollector({ maxThreads: 40 });

    observe(collector, response(edges(secondPageIds), { has_next_page: false, end_cursor: 'cursor-two' }), 'cursor-one');
    expect(collector.snapshot().incomplete).toBe(true);
    observe(collector, response(edges(firstPageIds), { has_next_page: true, end_cursor: 'cursor-one' }), null);

    expect(collector.snapshot()).toMatchObject({
      malformed: false,
      empty: false,
      incomplete: false,
      threadIds: [...firstPageIds, ...secondPageIds]
    });
  });

  it('marks a complete chain beyond the thread cap as truncated and keeps the bounded prefix (#151)', () => {
    const firstPageIds = ids(1, 12);
    const secondPageIds = ids(13, 12);
    const thirdPageIds = ids(25, 4);
    const collector = new MessengerInboxGraphQLCollector();

    observe(collector, response(edges(firstPageIds), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(secondPageIds), { has_next_page: true, end_cursor: 'cursor-two' }), 'cursor-one');
    observe(collector, response(edges(thirdPageIds)), 'cursor-two');

    const snapshot = collector.snapshot();
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.threadIds).toEqual([...firstPageIds, ...secondPageIds.slice(0, 8)]);
  });

  it('does not mark the exact thread-cap boundary truncated on a complete chain (#151)', () => {
    const firstPageIds = ids(1, 12);
    const secondPageIds = ids(13, 8);
    const collector = new MessengerInboxGraphQLCollector();

    observe(collector, response(edges(firstPageIds), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(secondPageIds)), 'cursor-one');

    const snapshot = collector.snapshot();
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.threadIds).toEqual([...firstPageIds, ...secondPageIds]);
    expect(snapshot.threadIds).toHaveLength(20);
  });

  it('counts deduplicated ids toward the cap so retry overlap never fabricates truncation (#151)', () => {
    const firstPageIds = ids(1, 12);
    const overlappingIds = [...ids(7, 6), ...ids(13, 8)];
    const collector = new MessengerInboxGraphQLCollector();

    observe(collector, response(edges(firstPageIds), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(overlappingIds)), 'cursor-one');

    const snapshot = collector.snapshot();
    expect(snapshot.incomplete).toBe(false);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.threadIds).toHaveLength(20);
  });

  it('rejects a terminal page when the initial page is missing', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(['12345678'])), 'cursor-one');
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, truncated: false, threadIds: []
    });
  });

  it('rejects a chain with a missing middle page even when a later terminal page arrived', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(['12345678']), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(['12345680'])), 'cursor-two');
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, truncated: false, threadIds: ['12345678']
    });
  });

  it('keeps a missing terminal page incomplete and does not allow an unknown request cursor to complete', () => {
    const missingTerminal = new MessengerInboxGraphQLCollector();
    observe(missingTerminal, response(edges(['12345678']), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    expect(missingTerminal.snapshot().incomplete).toBe(true);

    const unknownRequest = new MessengerInboxGraphQLCollector();
    unknownRequest.observe(response(edges(['12345678'])));
    expect(unknownRequest.snapshot()).toMatchObject({ incomplete: true, threadIds: [] });
  });

  it('fails closed when a verified inbox request has no recognizable connection response', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, { errors: [{ message: 'unavailable' }] });
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, truncated: false, threadIds: []
    });
  });

  it('fails closed when a known continuation request has an unusable cursor and no connection response', () => {
    const collector = new MessengerInboxGraphQLCollector();
    const request = parseMessengerInboxGraphQLRequest({
      body: JSON.stringify({ operationName: MESSENGER_INBOX_OPERATIONS[1], variables: { count: 12 } })
    });
    collector.observe({ errors: [{ message: 'unavailable' }] }, request);
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, truncated: false, threadIds: []
    });
  });

  it('deduplicates identical retries and fails closed on conflicting responses for one cursor', () => {
    const page = response(edges(['12345678']));
    const duplicate = new MessengerInboxGraphQLCollector();
    observe(duplicate, page, null);
    observe(duplicate, page, null);
    expect(duplicate.snapshot()).toMatchObject({ malformed: false, incomplete: false, threadIds: ['12345678'] });

    const conflict = new MessengerInboxGraphQLCollector();
    observe(conflict, page, null);
    observe(conflict, response(edges(['12345679'])), null);
    expect(conflict.snapshot()).toMatchObject({ malformed: true, incomplete: true });
  });
});
