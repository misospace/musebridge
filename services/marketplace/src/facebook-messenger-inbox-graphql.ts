import { MAX_THREAD_ID_LENGTH, conversationThreadSchema } from './domain.js';

export const MESSENGER_INBOX_OPERATIONS = [
  'CometMarketplaceInboxBuyerTabViewContainerQuery',
  'CometMarketplaceInboxBuyerTabViewPaginationQuery'
] as const;

export interface MessengerInboxGraphQLObservation {
  recognized: boolean;
  malformed: boolean;
  empty: boolean;
  incomplete: boolean;
  threadIds: string[];
}

type ParsedResponse =
  | { kind: 'unrelated' }
  | { kind: 'connection'; threadIds: string[]; empty: boolean; malformed: boolean; incomplete: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Positive terminal-pagination gate: only an explicit `page_info: { has_next_page: false }` is
 * accepted as the inbox being fully read. Absent `page_info` (or any non-`false` value) is
 * reported as incomplete rather than empty so a future caller can distinguish a verified empty
 * inbox from one we simply did not finish reading.
 */
function isTerminalPagination(connection: Record<string, unknown>): boolean {
  const pageInfo = connection.page_info;
  if (!isObject(pageInfo)) return false;
  return pageInfo.has_next_page === false;
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
    return { kind: 'connection', threadIds: [], empty: false, malformed: true, incomplete: false };
  }
  if (connection.edges.length === 0) {
    // An empty current slice with explicit `page_info: { has_next_page: false }` is the only
    // shape that proves we read the full inbox. Any other shape — `has_next_page: true`, absent
    // `page_info`, or a non-boolean value — is partial pagination; the tool reads one page so
    // claiming completeness would fabricate data.
    if (!isTerminalPagination(connection)) {
      return { kind: 'connection', threadIds: [], empty: false, malformed: false, incomplete: true };
    }
    return { kind: 'connection', threadIds: [], empty: true, malformed: false, incomplete: false };
  }

  const threadIds: string[] = [];
  const seen = new Set<string>();
  let malformed = false;
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
  // Positive thread ids do not prove completeness. Treat every non-terminal shape as incomplete,
  // including missing or malformed page_info, so callers cannot mistake a first slice for a full
  // inbox listing.
  return {
    kind: 'connection',
    threadIds,
    empty: false,
    malformed,
    incomplete: !isTerminalPagination(connection)
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
  private readonly threadIds: string[] = [];
  private readonly seen = new Set<string>();
  private recognized = false;
  private malformed = false;
  private empty = false;
  private incomplete = false;
  private recognizedResponses = 0;

  constructor(options: { maxThreads?: number; maxResponses?: number } = {}) {
    this.maxThreads = options.maxThreads ?? 20;
    this.maxResponses = options.maxResponses ?? 40;
  }

  observe(payload: unknown): void {
    try {
      if (this.recognizedResponses >= this.maxResponses) return;
      const parsed = parseMessengerInboxGraphQLResponse(payload);
      if (parsed.kind === 'unrelated') return;
      this.recognized = true;
      this.recognizedResponses += 1;
      this.malformed ||= parsed.malformed;
      this.empty ||= parsed.empty;
      this.incomplete ||= parsed.incomplete;
      for (const threadId of parsed.threadIds) {
        if (this.threadIds.length >= this.maxThreads) break;
        if (this.seen.has(threadId)) continue;
        this.seen.add(threadId);
        this.threadIds.push(threadId);
      }
    } catch {
      this.recognized = true;
      this.malformed = true;
    }
  }

  snapshot(): MessengerInboxGraphQLObservation {
    return {
      recognized: this.recognized,
      malformed: this.malformed,
      empty: this.empty && this.threadIds.length === 0 && !this.incomplete,
      incomplete: this.incomplete,
      threadIds: [...this.threadIds]
    };
  }
}
