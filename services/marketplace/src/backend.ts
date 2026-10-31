import { z } from 'zod';
import {
  fetchInputSchema,
  threadsListInputSchema,
  threadReadInputSchema,
  threadSendInputSchema,
  consumerThreadsListInputSchema,
  consumerThreadsSearchInputSchema,
  shoppingFetchInputSchema,
  shoppingSearchInputSchema,
  eventsFetchInputSchema,
  eventsSearchInputSchema,
  threadsPostsListInputSchema,
  threadsRepliesListInputSchema,
  providerErrorMetadataSchema,
  providerErrorSchema,
  searchInputSchema,
  type ConsumerSearchCoverage,
  type ConsumerThread,
  type ConsumerThreadMatch,
  type ConsumerMenuCoverage,
  type Listing,
  type ConversationMessage,
  type ConversationThread,
  type ConversationThreadMessages,
  type ConversationDraft,
  type EventAvailability,
  type ProductOffer,
  type ProviderErrorCode,
  type ProviderErrorMetadata,
  type ThreadSendInput,
  type ThreadsPost,
  type ThreadsReply
} from './domain.js';
import { FIXTURE_CONVERSATIONS, FIXTURE_LISTINGS } from './fixtures.js';
import { searchConsumerThreads } from './consumer-thread-search.js';

export interface MarketplaceBackend {
  readonly name: string;
  search(input: ReturnType<typeof searchInputSchema.parse>, signal: AbortSignal): Promise<Listing[]> | Listing[];
  fetch(input: ReturnType<typeof fetchInputSchema.parse>, signal: AbortSignal): Promise<Listing | null> | Listing | null;
}

// Listing coverage (#151). A thread listing is a bounded recent window, so it carries an
// explicit `truncated` indicator: true when more threads are known or plausibly exist beyond
// the returned window, false only when the provider set behind this listing was exhausted.
export interface ConversationThreadListPage {
  threads: ConversationThread[];
  truncated: boolean;
}

export interface ConversationBackend {
  readonly name: string;
  // A backend may return the coverage-carrying page or, if it predates #151, a bare thread
  // array. A bare array reports no coverage: the tool then omits `truncated` rather than
  // fabricating a completeness claim the host backend cannot substantiate.
  listThreads(input: ReturnType<typeof threadsListInputSchema.parse>, signal: AbortSignal): Promise<ConversationThreadListPage | ConversationThread[]> | ConversationThreadListPage | ConversationThread[];
  readThread(input: ReturnType<typeof threadReadInputSchema.parse>, signal: AbortSignal): Promise<ConversationThreadMessages | null> | ConversationThreadMessages | null;
  /** Conversation-scoped draft context for a proposed send, or null when no such thread exists. Never sends and never records a message. */
  prepareDraft(input: ReturnType<typeof threadSendInputSchema.parse>, signal: AbortSignal): Promise<ConversationDraft | null> | ConversationDraft | null;
  sendThread(input: ReturnType<typeof threadSendInputSchema.parse>, signal: AbortSignal): Promise<void> | void;
  // Personal-inbox consumer discovery (#79), over the verified homepage header menu source. Both
  // methods are optional on the interface on purpose: a backend that does not implement them
  // keeps the consumer tools unregistered (the `requires` gate reads them off the tool entries)
  // instead of advertised and failing at dispatch. Coverage semantics live in `ConsumerMenuCoverage`.
  listConsumerThreads?(input: ReturnType<typeof consumerThreadsListInputSchema.parse>, signal: AbortSignal): Promise<ConsumerThreadListPage> | ConsumerThreadListPage;
  /** Search is the same single listing load filtered in memory — the query is never typed into the provider and the search layer adds no request. */
  searchConsumerThreads?(input: ReturnType<typeof consumerThreadsSearchInputSchema.parse>, signal: AbortSignal): Promise<ConsumerThreadSearchPage> | ConsumerThreadSearchPage;
}

// The verified menu observation, bounded and deduplicated. `coverage.complete` is `false` for the
// Facebook backend permanently — the menu exposes no pagination signal — and `true` for the
// fixture backend, which holds its whole synthetic list by construction.
export interface ConsumerThreadListPage {
  threads: ConsumerThread[];
  truncated: boolean;
  coverage: ConsumerMenuCoverage;
}

export interface ConsumerThreadSearchPage {
  matches: ConsumerThreadMatch[];
  truncated: boolean;
  coverage: ConsumerSearchCoverage;
}

// Cross-site shopping surface (#48). HTTP-API-backed, no browser session; `name` is the
// configured backend kind ('ebay'), while each offer carries its own `provider` value.
export interface ShoppingBackend {
  readonly name: string;
  search(input: ReturnType<typeof shoppingSearchInputSchema.parse>, signal: AbortSignal): Promise<ProductOffer[]> | ProductOffer[];
  fetch(input: ReturnType<typeof shoppingFetchInputSchema.parse>, signal: AbortSignal): Promise<ProductOffer | null> | ProductOffer | null;
}

// Events availability surface (#50). HTTP-API-backed and strictly read-only; `name` is the
// configured backend kind ('ticketmaster'), while each event carries its own `provider` value.
export interface EventsBackend {
  readonly name: string;
  search(input: ReturnType<typeof eventsSearchInputSchema.parse>, signal: AbortSignal): Promise<EventAvailability[]> | EventAvailability[];
  fetch(input: ReturnType<typeof eventsFetchInputSchema.parse>, signal: AbortSignal): Promise<EventAvailability | null> | EventAvailability | null;
}

// Cross-site Threads (Meta) social surface (#84). HTTP-API-backed, strictly read-only;
// `name` is the configured backend kind ('threads'), while each post/reply carries its
// own `provider: 'threads'` value. No DMs, no saved items, no keyword search, no
// external profile discovery, no browser session — fail closed on missing credentials
// (#46/#38).
export interface ThreadsPostPage {
  posts: ThreadsPost[];
  truncated: boolean;
}

export interface ThreadsReplyPage {
  replies: ThreadsReply[];
  truncated: boolean;
}

export interface ThreadsBackend {
  readonly name: string;
  listOwnPosts(input: ReturnType<typeof threadsPostsListInputSchema.parse>, signal: AbortSignal): Promise<ThreadsPostPage> | ThreadsPostPage;
  listReplies(input: ReturnType<typeof threadsRepliesListInputSchema.parse>, signal: AbortSignal): Promise<ThreadsReplyPage | null> | ThreadsReplyPage | null;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly metadata: ProviderErrorMetadata;

  constructor(code: ProviderErrorCode, message: string, metadata: ProviderErrorMetadata = {}) {
    const parsedMetadata = providerErrorMetadataSchema.safeParse(metadata);
    const parsed = providerErrorSchema.safeParse({ ...metadata, code, message });
    if (!parsedMetadata.success || !parsed.success) throw new TypeError('Invalid ProviderError fields');
    super(parsed.data.message);
    this.name = 'ProviderError';
    this.code = parsed.data.code;
    this.metadata = parsedMetadata.data;
  }
}

export class SurfaceDisabledError extends Error {
  readonly code = 'SURFACE_DISABLED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceDisabledError';
  }
}

// The delivery form that binds the grant's idempotency token into the delivered text, so a
// timed-out send can be reconciled against the thread (matched by the token substring).
export function renderDeliveredMessage(input: ThreadSendInput): string {
  return `${input.message} [${input.idempotency_token}]`;
}

export class FixtureBackend implements MarketplaceBackend, ConversationBackend {
  readonly name = 'fixture';
  // Per-instance store of messages 'you' sent through sendThread; fixture data is never mutated.
  private readonly sentMessages = new Map<string, ConversationMessage[]>();

  constructor(private readonly listings: readonly Listing[] = FIXTURE_LISTINGS) {}

  search(input: ReturnType<typeof searchInputSchema.parse>, _signal: AbortSignal): Listing[] {
    const query = input.query.toLowerCase();
    const location = input.location.toLowerCase();

    return this.listings.filter((listing) => {
      const matchesText = listing.title.toLowerCase().includes(query) || listing.description.toLowerCase().includes(query);
      const matchesLocation = listing.location.toLowerCase().includes(location);
      const matchesMin = input.min_price === undefined || (listing.price !== null && listing.price >= input.min_price);
      const matchesMax = input.max_price === undefined || (listing.price !== null && listing.price <= input.max_price);
      return matchesText && matchesLocation && matchesMin && matchesMax;
    }).slice(0, input.limit);
  }

  fetch(input: ReturnType<typeof fetchInputSchema.parse>, _signal: AbortSignal): Listing | null {
    if (input.id !== undefined) {
      return this.listings.find((listing) => listing.id === input.id) ?? null;
    }

    const canonicalTarget = canonicalHttpUrl(input.url!);
    return this.listings.find((listing) => canonicalHttpUrl(listing.url) === canonicalTarget) ?? null;
  }

  listThreads(input: ReturnType<typeof threadsListInputSchema.parse>, _signal: AbortSignal): ConversationThreadListPage {
    // The fixture holds every synthetic conversation, so truncation is exactly the rows the
    // caller's limit left out (#151).
    return {
      threads: FIXTURE_CONVERSATIONS.slice(0, input.limit).map(({ thread }) => thread),
      truncated: FIXTURE_CONVERSATIONS.length > input.limit
    };
  }

  readThread(input: ReturnType<typeof threadReadInputSchema.parse>, _signal: AbortSignal): ConversationThreadMessages | null {
    const conversation = FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === input.thread_id);
    const sent = this.sentMessages.get(input.thread_id);
    if (!conversation && !sent) return null;
    const messages = [...(conversation?.messages ?? []), ...(sent ?? [])];
    // The fixture holds the whole synthetic conversation, so its newest end is complete by
    // construction: that completeness is the proof behind the tail window.
    return {
      thread_id: input.thread_id,
      messages,
      coverage: { window: 'tail', scanned_rows: messages.length, truncated: false }
    };
  }

  prepareDraft(input: ReturnType<typeof threadSendInputSchema.parse>, _signal: AbortSignal): ConversationDraft | null {
    const conversation = FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === input.thread_id);
    // An unknown thread is an absent resource, not a provider failure: it returns null so the tool
    // reports NOT_FOUND exactly as messenger_thread_read does for the same thread id.
    if (!conversation) return null;
    // Search a reversed copy so drafting never mutates the shared fixture arrays, and never records
    // a message: a prepared draft is not a send.
    const lastCounterparty = [...conversation.messages].reverse().find(({ sender }) => sender === 'other');
    return {
      participant: lastCounterparty?.sender_name ?? conversation.thread.participants?.[0] ?? null
    };
  }

  sendThread(input: ReturnType<typeof threadSendInputSchema.parse>, _signal: AbortSignal): void {
    const messages = this.sentMessages.get(input.thread_id) ?? [];
    messages.push({ sender: 'you' as const, text: renderDeliveredMessage(input) });
    this.sentMessages.set(input.thread_id, messages);
  }

  // Personal-inbox consumer discovery (#79). The fixture holds its whole synthetic list by
  // construction, so its menu window is complete by construction — the same reasoning behind the
  // fixture read coverage — and its `truncated` is exactly the rows the caller's limit left out.
  listConsumerThreads(input: ReturnType<typeof consumerThreadsListInputSchema.parse>, _signal: AbortSignal): ConsumerThreadListPage {
    const threads: ConsumerThread[] = FIXTURE_CONVERSATIONS.slice(0, input.limit).map(({ thread }) => ({
      thread_id: thread.thread_id,
      route: 'plain' as const,
      ...(thread.participants ? { participants: thread.participants } : {}),
      ...(thread.preview ? { preview: thread.preview } : {})
    }));
    return {
      threads,
      truncated: FIXTURE_CONVERSATIONS.length > input.limit,
      coverage: { threads_observed: FIXTURE_CONVERSATIONS.length, window: 'recent-load', complete: true }
    };
  }

  searchConsumerThreads(input: ReturnType<typeof consumerThreadsSearchInputSchema.parse>, signal: AbortSignal): ConsumerThreadSearchPage {
    // The search examines the whole observed window, so the fixture's own cap — not the caller's
    // match limit — bounds what the query runs over; the match limit only caps the return.
    const observed = this.listConsumerThreads({ limit: CONSUMER_EXTRACT_MAX_THREADS }, signal);
    const outcome = searchConsumerThreads({ threads: observed.threads, query: input.query });
    const matches = outcome.matches.slice(0, input.limit);
    return {
      matches,
      truncated: outcome.matches.length > matches.length,
      coverage: {
        threads_observed: observed.coverage.threads_observed,
        window: 'recent-load',
        complete: true,
        searchable_fields: outcome.searchableFields
      }
    };
  }
}

// The menu source's extraction cap (#79): the window a search runs over, independent of any
// caller's return limit.
const CONSUMER_EXTRACT_MAX_THREADS = 20;

export function canonicalHttpUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}
