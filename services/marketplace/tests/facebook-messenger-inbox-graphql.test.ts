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
      threadIds: [...firstPageIds, ...secondPageIds],
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 2 }
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
      recognized: true, malformed: false, empty: false, incomplete: true, incompleteReason: 'incomplete_chain', truncated: false, threadIds: [],
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 1 }
    });
  });

  it('rejects a chain with a missing middle page even when a later terminal page arrived', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(['12345678']), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(['12345680'])), 'cursor-two');
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, incompleteReason: 'incomplete_chain', truncated: false, threadIds: ['12345678'],
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 2 }
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
      recognized: true, malformed: false, empty: false, incomplete: true, incompleteReason: 'unverified_page', truncated: false, threadIds: [],
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 0 }
    });
  });

  it('fails closed when a known continuation request has an unusable cursor and no connection response', () => {
    const collector = new MessengerInboxGraphQLCollector();
    const request = parseMessengerInboxGraphQLRequest({
      body: JSON.stringify({ operationName: MESSENGER_INBOX_OPERATIONS[1], variables: { count: 12 } })
    });
    collector.observe({ errors: [{ message: 'unavailable' }] }, request);
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: true, incompleteReason: 'unverified_page', truncated: false, threadIds: [],
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 0 }
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

// #204: the deployed session reached a verified authenticated state, yet one bounded
// messenger_threads_list call returned the typed pagination-unverifiable refusal. Each test
// here pins one candidate deployed shape to the completeness condition that fails closed for
// it, so the recorded `incompleteReason` distinguishes the shapes on the next authorized run.
describe('Messenger inbox deployed fail-closed classification (#204)', () => {
  it('verifies a legitimate single-page inbox that carries an explicit terminal marker', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(ids(1, 20)), terminal), null);
    expect(collector.snapshot()).toEqual({
      recognized: true, malformed: false, empty: false, incomplete: false, truncated: false,
      threadIds: ids(1, 20),
      counters: { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 1 }
    });
  });

  it('classifies a single page without a terminal page_info as an unverified page, not a chain failure', () => {
    const collector = new MessengerInboxGraphQLCollector();
    // Connection shape matches the verified live record (#64: edges[].node MessageThread with
    // thread_key.thread_fbid) but the connection carries no page_info at all.
    observe(collector, response(edges(ids(1, 20)), null), null);
    expect(collector.snapshot()).toMatchObject({
      recognized: true, malformed: false, empty: false, incomplete: true,
      incompleteReason: 'unverified_page', threadIds: []
    });
  });

  it('classifies a malformed page_info as an unverified page', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(ids(1, 20)), { has_next_page: 'no' }), null);
    expect(collector.snapshot()).toMatchObject({
      incomplete: true, malformed: true, incompleteReason: 'malformed_connection'
    });
  });

  it('classifies an initial request that cannot be tied to its connection as an unverified page', () => {
    const collector = new MessengerInboxGraphQLCollector();
    // The response parses as a terminal connection, but the request observation is not the
    // initial page request (unreadable body, unknown friendly name, or unusable cursor).
    collector.observe(response(edges(ids(1, 20)), terminal), { kind: 'unverified' });
    expect(collector.snapshot()).toMatchObject({
      recognized: true, malformed: false, incomplete: true, incompleteReason: 'unverified_page', threadIds: []
    });
  });

  it('classifies an unrecognized payload on a verified page request as an unverified page', () => {
    const collector = new MessengerInboxGraphQLCollector();
    // An error envelope (or any response whose shape is not the verified connection) on the
    // initial page request leaves the page evidence ambiguous.
    observe(collector, { errors: [{ message: 'unavailable' }] }, null);
    expect(collector.snapshot()).toMatchObject({
      recognized: true, malformed: false, incomplete: true, incompleteReason: 'unverified_page', threadIds: []
    });
  });

  it('classifies a first page whose continuation was never observed as an incomplete chain', () => {
    const collector = new MessengerInboxGraphQLCollector();
    // A first page that promises more threads keeps the listing incomplete until the collector
    // observes the continuation request and its terminal response in the same bounded window.
    observe(collector, response(edges(ids(1, 12)), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    expect(collector.snapshot()).toMatchObject({
      recognized: true, malformed: false, incomplete: true, incompleteReason: 'incomplete_chain', threadIds: ids(1, 12)
    });
  });

  it('classifies a bounded read that stopped before every observed response was read as a response limit', () => {
    const collector = new MessengerInboxGraphQLCollector();
    observe(collector, response(edges(ids(1, 12)), { has_next_page: true, end_cursor: 'cursor-one' }), null);
    observe(collector, response(edges(ids(13, 12)), { has_next_page: true, end_cursor: 'cursor-two' }), 'cursor-one');
    // Fill the response window to its bound without recording a terminal page, then exhaust it.
    for (let index = 0; index < 39; index += 1) {
      collector.observe(response(edges(['12345678'])), { kind: 'page', cursor: `cursor-${index}` });
    }
    expect(collector.snapshot()).toMatchObject({
      recognized: true, malformed: false, incomplete: true, incompleteReason: 'response_limit'
    });
  });
});

// #226: the 2026-11-10 deployed run reached a verified authenticated inbox and returned the
// unrecognized-layout refusal with `recognized === false` — the collector observed no
// recognizable inbox GraphQL traffic, and `incompleteReason` cannot fire on that path. The
// window counters are the only structural evidence such a run carries, so each test here pins
// one candidate live cause to the exact counter signature it would leave, making a single
// operator-authorized re-validation conclusive without loosening the #97 contract.
describe('Messenger inbox observed-window counters (#226)', () => {
  const zeroCounters = { observedResponses: 0, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 0 };

  it('counts every same-origin response by its request-side classification', () => {
    const collector = new MessengerInboxGraphQLCollector();
    // The initial page request: a known inbox operation.
    collector.observeGraphqlRequest({ kind: 'page', cursor: null });
    // A continuation request whose name is known but whose cursor is unusable.
    collector.observeGraphqlRequest({ kind: 'unverified', knownInboxOperation: true });
    // A request with a parseable operation name that is not an inbox operation.
    collector.observeGraphqlRequest({ kind: 'unrelated' });
    // A request with no parseable operation name at all.
    collector.observeGraphqlRequest({ kind: 'unverified' });

    expect(collector.snapshot()).toEqual({
      recognized: false, malformed: false, empty: false, incomplete: false, truncated: false, threadIds: [],
      counters: { observedResponses: 4, knownOperationRequests: 2, unrelatedRequests: 1, unreadBodies: 0, recognizedPayloads: 0 }
    });
  });

  it('leaves every counter zero when the listener window saw no GraphQL traffic', () => {
    // The settle-timing / page-issued-no-GraphQL / listener-attachment signature: the collector
    // snapshot is the deployed run's only record, and it cannot distinguish those three — the
    // synthetic suite excludes the third on deployed code by pinning the listener attachment.
    const collector = new MessengerInboxGraphQLCollector();
    expect(collector.snapshot()).toEqual({
      recognized: false, malformed: false, empty: false, incomplete: false, truncated: false, threadIds: [],
      counters: zeroCounters
    });
  });

  it('records the operation-rename drift signature with no connection evidence', () => {
    // Every observed request carries a parseable operation name that is not an inbox operation,
    // so the handler never feeds a payload to the connection parser: `recognized` stays false.
    const collector = new MessengerInboxGraphQLCollector();
    collector.observeGraphqlRequest({ kind: 'unrelated' });
    expect(collector.snapshot()).toEqual({
      recognized: false, malformed: false, empty: false, incomplete: false, truncated: false, threadIds: [],
      counters: { observedResponses: 1, knownOperationRequests: 0, unrelatedRequests: 1, unreadBodies: 0, recognizedPayloads: 0 }
    });
  });

  it('records the opaque-request drift signature when no request name is parseable and no payload is recognized', () => {
    // Unnamed requests reach the connection parser only through an observed body; a payload that
    // is not the verified envelope records nothing on an unnamed request, so `recognized` stays
    // false while the window demonstrably carried traffic.
    const collector = new MessengerInboxGraphQLCollector();
    collector.observeGraphqlRequest({ kind: 'unverified' });
    collector.observe({ data: { viewer: { marketplaceInboxThreads: { edges: [] } } } }, { kind: 'unverified' });
    expect(collector.snapshot()).toEqual({
      recognized: false, malformed: false, empty: false, incomplete: false, truncated: false, threadIds: [],
      counters: { observedResponses: 1, knownOperationRequests: 0, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 0 }
    });
  });

  it('marks unread request-relevant bodies and keeps them out of the recognized-payload count', () => {
    const collector = new MessengerInboxGraphQLCollector();
    collector.observeGraphqlRequest({ kind: 'page', cursor: null });
    collector.markUnobservedResponse();
    const snapshot = collector.snapshot();
    // An unread body is itself evidence of inbox-relevant traffic (`recognized` true), so an
    // unreadBodies value above zero can never stand beside the unrecognized-layout outcome: the
    // deployed log would expose such a snapshot as a collector-state inconsistency.
    expect(snapshot).toMatchObject({
      recognized: true, incomplete: true, incompleteReason: 'unverified_page',
      counters: { observedResponses: 1, knownOperationRequests: 1, unrelatedRequests: 0, unreadBodies: 1, recognizedPayloads: 0 }
    });
  });

  it('cannot produce the unrecognized-layout outcome from a request-side-recognized window', () => {
    // The structural exclusion the classification relies on: with a known inbox request and a
    // read body, either the payload is the verified envelope (`recognizedPayloads` counts it) or
    // it is not (an unrelated payload on a known request still sets `recognized`). Both leave
    // `recognized` true, so the deployed signature observed=positive beside knownOperationRequests
    // positive on an unrecognized-layout run would mean collector state loss, not provider drift.
    const driftedPayloadCollector = new MessengerInboxGraphQLCollector();
    driftedPayloadCollector.observeGraphqlRequest({ kind: 'page', cursor: null });
    driftedPayloadCollector.observe({ data: { viewer: { marketplaceInboxThreads: { edges: [] } } } }, { kind: 'page', cursor: null });
    expect(driftedPayloadCollector.snapshot()).toMatchObject({
      recognized: true, incomplete: true, incompleteReason: 'unverified_page',
      counters: { observedResponses: 1, knownOperationRequests: 1, unrelatedRequests: 0, unreadBodies: 0, recognizedPayloads: 0 }
    });

    const unreadBodyCollector = new MessengerInboxGraphQLCollector();
    unreadBodyCollector.observeGraphqlRequest({ kind: 'page', cursor: null });
    unreadBodyCollector.markUnobservedResponse();
    expect(unreadBodyCollector.snapshot()).toMatchObject({
      recognized: true, counters: { knownOperationRequests: 1, unreadBodies: 1 }
    });
  });
});
