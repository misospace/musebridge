import { MAX_THREAD_ID_LENGTH, conversationThreadSchema } from './domain.js';

export const MESSENGER_INBOX_OPERATIONS = [
  'CometMarketplaceInboxBuyerTabViewContainerQuery',
  'CometMarketplaceInboxBuyerTabViewPaginationQuery'
] as const;

const MAX_INBOX_CURSOR_LENGTH = 4_096;

/**
 * Why pagination verification failed, classified from the same observations the fail-closed
 * decision itself uses (#204). The reason is a sanitized structural code — never request or
 * response content — so a deployed fail-closed refusal can record which completeness condition
 * fired without logging page data. When several conditions hold, the first in this order wins:
 * `malformed_connection` (an observed connection could not be parsed), `response_limit` (the
 * bounded read stopped before every observed response was read), `unverified_page` (inbox
 * evidence was observed but a page of it could not be linked to the cursor chain — an
 * unidentifiable request, an unrecognized payload, an unreadable body, or a connection with no
 * usable terminal `page_info`), then `incomplete_chain` (recorded pages never reached a
 * terminal page).
 */
export type MessengerInboxIncompleteReason =
  | 'malformed_connection'
  | 'response_limit'
  | 'unverified_page'
  | 'incomplete_chain';

export interface MessengerInboxGraphQLObservation {
  recognized: boolean;
  malformed: boolean;
  empty: boolean;
  incomplete: boolean;
  /** Present only when `incomplete` is true: which completeness condition failed (#204). */
  incompleteReason?: MessengerInboxIncompleteReason;
  // Listing coverage (#151): true only when the observed cursor chain carried more verified
  // thread ids than the bounded snapshot returned. It never claims more than what was observed;
  // unverifiable chains stay `incomplete`, which fails closed before any listing is returned.
  truncated: boolean;
  threadIds: string[];
  /**
   * Sanitized structural counters for the observed GraphQL window (#226), present on every
   * collector snapshot. They never carry request or response content: counts only, so a deployed
   * fail-closed read can record how much traffic the listener window saw and where recognition
   * stopped. On the unrecognized-layout path (`recognized` false) these are the only evidence the
   * snapshot carries — `incompleteReason` does not fire there — and they are what distinguishes
   * "no traffic reached the listener" from "traffic whose requests were not recognizable as inbox
   * operations".
   */
  counters?: MessengerInboxGraphQLWindowCounters;
}

/**
 * The observed-traffic shape of one bounded read window (#226). Counted per same-origin
 * `/api/graphql/` response the backend listener observed:
 *
 * - `observedResponses`: responses in the window at all. Zero means the listener saw no
 *   same-origin GraphQL traffic — settle-timing variance (responses after the window), a page
 *   that issued none, or a listener that never attached; these three leave identical counters.
 * - `knownOperationRequests`: responses whose request referenced a known inbox operation
 *   (the initial page request, or a continuation carrying a known name). Zero with traffic
 *   present means no request was recognizable as an inbox operation — provider request-side
 *   drift (a renamed operation, or request bodies that no longer carry a parseable name).
 * - `unrelatedRequests`: responses whose request carried a parseable operation name that is not
 *   an inbox operation. Traffic with `knownOperationRequests` zero and these nonzero is the
 *   operation-rename drift signature.
 * - `unreadBodies`: request-relevant responses whose body never reached the connection parser
 *   (non-JSON content type, the read bound, a stalled or failed body read). Any nonzero value
 *   sets `recognized`, so a snapshot with `recognized` false always has zero here — a nonzero
 *   value beside `recognized` false would be a collector-state inconsistency.
 * - `recognizedPayloads`: read payloads that parsed as the verified inbox connection envelope.
 *
 * The response-side counterpart of `knownOperationRequests`: a request-side-recognized window
 * with `recognizedPayloads` zero cannot produce the unrecognized-layout outcome (an unrecognized
 * payload on a known request sets `recognized`), so that signature live would indicate collector
 * state loss rather than provider drift — the synthetic suite excludes the former on deployed
 * code, which is what makes the drift reading conclusive.
 */
export interface MessengerInboxGraphQLWindowCounters {
  observedResponses: number;
  knownOperationRequests: number;
  unrelatedRequests: number;
  unreadBodies: number;
  recognizedPayloads: number;
}

export type MessengerInboxGraphQLRequestObservation =
  | { kind: 'page'; cursor: string | null }
  | { kind: 'unverified'; knownInboxOperation?: boolean }
  | { kind: 'unrelated' };

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

type ParsedResponse =
  | { kind: 'unrelated' }
  | {
    kind: 'connection';
    threadIds: string[];
    empty: boolean;
    malformed: boolean;
    incomplete: boolean;
    pageInfo?: PageInfo;
  };

interface InboxPage {
  cursor: string | null;
  threadIds: string[];
  pageInfo: PageInfo;
}

interface RequestFields {
  operationName?: string;
  variables?: Record<string, unknown>;
  variablesSpecified: boolean;
  variablesMalformed: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVariables(value: unknown): { variables?: Record<string, unknown>; malformed: boolean } {
  if (isObject(value)) return { variables: value, malformed: false };
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isObject(parsed) ? { variables: parsed, malformed: false } : { malformed: true };
    } catch {
      return { malformed: true };
    }
  }
  return { malformed: true };
}

function requestFieldsFromBody(body: string | null | undefined): RequestFields {
  if (typeof body !== 'string' || body.length === 0) {
    return { variablesSpecified: false, variablesMalformed: false };
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (isObject(parsed)) {
      const operationName = typeof parsed.operationName === 'string'
        ? parsed.operationName
        : typeof parsed.fb_api_req_friendly_name === 'string'
          ? parsed.fb_api_req_friendly_name
          : undefined;
      const variablesSpecified = Object.prototype.hasOwnProperty.call(parsed, 'variables');
      if (!variablesSpecified) return { operationName, variablesSpecified, variablesMalformed: false };
      const variables = parseVariables(parsed.variables);
      return {
        operationName,
        variables: variables.variables,
        variablesSpecified,
        variablesMalformed: variables.malformed
      };
    }
  } catch {
    // Facebook also sends form-encoded GraphQL request bodies.
  }

  try {
    const params = new URLSearchParams(body);
    const operationName = params.get('operationName') ?? params.get('fb_api_req_friendly_name') ?? undefined;
    const rawVariables = params.get('variables');
    if (rawVariables === null) return { operationName, variablesSpecified: false, variablesMalformed: false };
    const variables = parseVariables(rawVariables);
    return {
      operationName,
      variables: variables.variables,
      variablesSpecified: true,
      variablesMalformed: variables.malformed
    };
  } catch {
    return { variablesSpecified: false, variablesMalformed: false };
  }
}

function requestFieldsFromUrl(url: string | undefined): RequestFields {
  if (typeof url !== 'string') return { variablesSpecified: false, variablesMalformed: false };
  try {
    const params = new URL(url).searchParams;
    const operationName = params.get('operationName') ?? params.get('fb_api_req_friendly_name') ?? undefined;
    const rawVariables = params.get('variables');
    if (rawVariables === null) return { operationName, variablesSpecified: false, variablesMalformed: false };
    const variables = parseVariables(rawVariables);
    return {
      operationName,
      variables: variables.variables,
      variablesSpecified: true,
      variablesMalformed: variables.malformed
    };
  } catch {
    return { variablesSpecified: false, variablesMalformed: false };
  }
}

/**
 * Extract only the pagination cursor for an observed request. Unknown request shapes are kept as
 * unverified so the response schema can still recognize them, but they can never establish a
 * complete cursor chain. Request bodies and cursor values are never returned by diagnostics.
 */
export function parseMessengerInboxGraphQLRequest(input: {
  body?: string | null;
  url?: string;
}): MessengerInboxGraphQLRequestObservation {
  const body = requestFieldsFromBody(input.body);
  const url = requestFieldsFromUrl(input.url);
  const operationName = body.operationName ?? url.operationName;
  const knownOperation = MESSENGER_INBOX_OPERATIONS.find((operation) => operation === operationName);
  if (!knownOperation) {
    const knownNameInOpaqueSource = MESSENGER_INBOX_OPERATIONS.some((operation) =>
      input.body?.includes(operation) || input.url?.includes(operation)
    );
    if (knownNameInOpaqueSource) return { kind: 'unverified', knownInboxOperation: true };
    if (operationName === undefined) return { kind: 'unverified' };
    return { kind: 'unrelated' };
  }

  const variablesMalformed = (body.variablesSpecified && body.variablesMalformed)
    || (!body.variablesSpecified && url.variablesSpecified && url.variablesMalformed);
  if (variablesMalformed) return { kind: 'unverified', knownInboxOperation: true };
  const variables = body.variablesSpecified ? body.variables : url.variables;
  const hasCursor = variables !== undefined && Object.prototype.hasOwnProperty.call(variables, 'cursor');
  if (!hasCursor) {
    if (knownOperation === MESSENGER_INBOX_OPERATIONS[0]) {
      return { kind: 'page', cursor: null };
    }
    return { kind: 'unverified', knownInboxOperation: true };
  }

  const cursor = variables?.cursor;
  if (cursor === null) return { kind: 'page', cursor: null };
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_INBOX_CURSOR_LENGTH) {
    return { kind: 'unverified', knownInboxOperation: true };
  }
  return { kind: 'page', cursor };
}

function parsePageInfo(connection: Record<string, unknown>): { pageInfo?: PageInfo; malformed: boolean } {
  if (!Object.prototype.hasOwnProperty.call(connection, 'page_info')) return { malformed: false };
  const value = connection.page_info;
  if (!isObject(value) || typeof value.has_next_page !== 'boolean') return { malformed: true };
  const rawEndCursor = value.end_cursor;
  if (rawEndCursor === undefined || rawEndCursor === null) {
    return value.has_next_page
      ? { malformed: true }
      : { pageInfo: { hasNextPage: false, endCursor: null }, malformed: false };
  }
  if (typeof rawEndCursor !== 'string' || rawEndCursor.length === 0 || rawEndCursor.length > MAX_INBOX_CURSOR_LENGTH) {
    return { malformed: true };
  }
  return { pageInfo: { hasNextPage: value.has_next_page, endCursor: rawEndCursor }, malformed: false };
}

export function parseMessengerInboxGraphQLResponse(payload: unknown): ParsedResponse {
  if (!isObject(payload) || !isObject(payload.data) || !isObject(payload.data.viewer)) {
    return { kind: 'unrelated' };
  }
  const viewer = payload.data.viewer;
  if (!Object.prototype.hasOwnProperty.call(viewer, 'marketplaceInboxBuyerMessageThreads')) {
    return { kind: 'unrelated' };
  }
  const connection = viewer.marketplaceInboxBuyerMessageThreads;
  if (!isObject(connection) || !Array.isArray(connection.edges)) {
    return { kind: 'connection', threadIds: [], empty: false, malformed: true, incomplete: true };
  }

  const pageInfo = parsePageInfo(connection);
  const threadIds: string[] = [];
  const seen = new Set<string>();
  let malformed = pageInfo.malformed;
  for (const edge of connection.edges) {
    if (!isObject(edge) || !isObject(edge.node)) {
      malformed = true;
      continue;
    }
    const node = edge.node;
    const threadKey = node.thread_key;
    const threadId = isObject(threadKey) ? threadKey.thread_fbid : undefined;
    if (
      node.__typename !== 'MessageThread' ||
      typeof threadId !== 'string' ||
      threadId.length < 1 ||
      threadId.length > MAX_THREAD_ID_LENGTH ||
      !conversationThreadSchema.safeParse({ thread_id: threadId }).success
    ) {
      malformed = true;
      continue;
    }
    if (typeof node.id === 'string' && !isConsistentThreadId(node.id, threadId)) {
      malformed = true;
      continue;
    }
    if (!seen.has(threadId)) {
      seen.add(threadId);
      threadIds.push(threadId);
    }
  }

  const terminal = pageInfo.pageInfo?.hasNextPage === false;
  return {
    kind: 'connection',
    threadIds,
    empty: connection.edges.length === 0 && terminal,
    malformed,
    incomplete: !terminal,
    ...(pageInfo.pageInfo ? { pageInfo: pageInfo.pageInfo } : {})
  };
}

/**
 * The verified GraphQL `id` is a Facebook global id that decodes to `message_thread:<thread_fbid>`.
 * Accept the literal form or its exact base64 encoding; anything else is an inconsistent key and is
 * skipped rather than attributed to a thread. Non-thread id shapes are left to `thread_key`.
 */
function isConsistentThreadId(id: string, threadId: string): boolean {
  const expected = `message_thread:${threadId}`;
  return id === expected || id === Buffer.from(expected).toString('base64');
}

export class MessengerInboxGraphQLCollector {
  private readonly maxThreads: number;
  private readonly maxResponses: number;
  private readonly pages = new Map<string | null, InboxPage>();
  private recognized = false;
  private malformed = false;
  private unverifiedPage = false;
  private responseLimitExceeded = false;
  private recognizedResponses = 0;
  private readonly windowCounters: MessengerInboxGraphQLWindowCounters = {
    observedResponses: 0,
    knownOperationRequests: 0,
    unrelatedRequests: 0,
    unreadBodies: 0,
    recognizedPayloads: 0
  };

  constructor(options: { maxThreads?: number; maxResponses?: number } = {}) {
    this.maxThreads = options.maxThreads ?? 20;
    this.maxResponses = options.maxResponses ?? 40;
  }

  /**
   * Records one same-origin `/api/graphql/` response the listener observed, by its request-side
   * classification (#226). The backend calls this for every same-origin GraphQL response in the
   * window — including unrelated ones the connection parser must never see — before any body
   * read, so the counters measure the window itself rather than the subset whose bodies were
   * read. Counts only; the observation never carries request or response content.
   */
  observeGraphqlRequest(request: MessengerInboxGraphQLRequestObservation): void {
    this.windowCounters.observedResponses += 1;
    if (request.kind === 'page') this.windowCounters.knownOperationRequests += 1;
    else if (request.kind === 'unrelated') this.windowCounters.unrelatedRequests += 1;
    else if (request.knownInboxOperation) this.windowCounters.knownOperationRequests += 1;
  }

  observe(payload: unknown, request: MessengerInboxGraphQLRequestObservation = { kind: 'unverified' }): void {
    try {
      if (request.kind === 'unrelated') return;
      const parsed = parseMessengerInboxGraphQLResponse(payload);
      if (parsed.kind === 'unrelated') {
        if (request.kind === 'page' || request.knownInboxOperation) {
          this.recognized = true;
          this.unverifiedPage = true;
        }
        return;
      }
      this.recognized = true;
      this.windowCounters.recognizedPayloads += 1;
      if (this.recognizedResponses >= this.maxResponses) {
        this.responseLimitExceeded = true;
        return;
      }
      this.recognizedResponses += 1;
      this.malformed ||= parsed.malformed;
      if (request.kind !== 'page' || !parsed.pageInfo) {
        this.unverifiedPage = true;
        return;
      }

      const page: InboxPage = {
        cursor: request.cursor,
        threadIds: parsed.threadIds,
        pageInfo: parsed.pageInfo
      };
      const previous = this.pages.get(page.cursor);
      if (previous) {
        if (!samePage(previous, page)) this.malformed = true;
        return;
      }
      this.pages.set(page.cursor, page);
    } catch {
      this.recognized = true;
      this.malformed = true;
    }
  }

  markUnobservedResponse(): void {
    this.recognized = true;
    this.unverifiedPage = true;
    this.windowCounters.unreadBodies += 1;
  }

  snapshot(): MessengerInboxGraphQLObservation {
    const chain = this.getPageChain();
    const uniqueThreadIds: string[] = [];
    const seen = new Set<string>();
    for (const page of chain.pages) {
      for (const threadId of page.threadIds) {
        if (!seen.has(threadId)) {
          seen.add(threadId);
          uniqueThreadIds.push(threadId);
        }
      }
    }
    // The cap keeps the returned listing bounded, but the caller must still learn when the
    // observed chain carried more threads than the cap returned: ids counted but not returned
    // are what makes `truncated` a truthful bound rather than an assumed-complete listing.
    const threadIds = uniqueThreadIds.slice(0, this.maxThreads);
    const truncated = uniqueThreadIds.length > threadIds.length;

    const incomplete = this.recognized && (
      !chain.complete || this.unverifiedPage || this.responseLimitExceeded || this.malformed
    );
    return {
      recognized: this.recognized,
      malformed: this.malformed,
      empty: chain.complete && !this.malformed && threadIds.length === 0,
      incomplete,
      // The reason rides the same booleans the fail-closed decision uses, so a deployed refusal
      // can name the completeness condition that fired without logging any page data (#204).
      ...(incomplete ? { incompleteReason: this.incompleteReason() } : {}),
      truncated,
      threadIds,
      // The window counters ride every snapshot (#226): on the unrecognized-layout path they are
      // the only evidence the snapshot carries, and they are what the deployed log records.
      counters: { ...this.windowCounters }
    };
  }

  private incompleteReason(): MessengerInboxIncompleteReason {
    if (this.malformed) return 'malformed_connection';
    if (this.responseLimitExceeded) return 'response_limit';
    if (this.unverifiedPage) return 'unverified_page';
    // `incomplete` is only reached here when the chain itself did not terminate: the recorded
    // pages never reached a terminal page (a missing, unobserved, or unlinked continuation).
    return 'incomplete_chain';
  }

  private getPageChain(): { pages: InboxPage[]; complete: boolean } {
    const pages: InboxPage[] = [];
    const visited = new Set<string | null>();
    let cursor: string | null = null;
    for (;;) {
      if (visited.has(cursor)) return { pages, complete: false };
      visited.add(cursor);
      const page = this.pages.get(cursor);
      if (!page) return { pages, complete: false };
      pages.push(page);
      if (!page.pageInfo.hasNextPage) {
        return { pages, complete: pages.length === this.pages.size };
      }
      const nextCursor = page.pageInfo.endCursor;
      if (nextCursor === null || visited.has(nextCursor)) return { pages, complete: false };
      cursor = nextCursor;
    }
  }
}

function samePage(left: InboxPage, right: InboxPage): boolean {
  return left.pageInfo.hasNextPage === right.pageInfo.hasNextPage
    && left.pageInfo.endCursor === right.pageInfo.endCursor
    && left.threadIds.length === right.threadIds.length
    && left.threadIds.every((threadId, index) => threadId === right.threadIds[index]);
}
