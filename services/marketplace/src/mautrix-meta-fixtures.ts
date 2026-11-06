import {
  conversationThreadSchema,
  threadBackfillInputSchema,
  threadReadInputSchema,
  threadsListInputSchema,
  type ConversationMessage,
  type ConversationThread,
  type ConversationThreadMessages
} from './domain.js';
import type { ConversationBackfillPage, ConversationThreadListPage, MautrixMetaBackend } from './backend.js';

/**
 * Synthetic fixture for the experimental `mautrix-meta` Messenger transport surface (#195).
 * The #195 proof is fixture/synthetic-first: the transport contract is exercised by
 * fixture/synthetic tests with no live Meta request, and this module is the zero-network
 * in-process stand-in for the transport service — no fetch, no credential, no session.
 * Every id, participant, timestamp, and message below is synthetic; nothing names a real
 * person, host, or piece of content.
 *
 * Threads are modeled as per-thread message lists, each holding that synthetic conversation's
 * whole history by construction — the same construction argument `FixtureBackend.readThread`
 * uses. Paging truth is therefore decidable from the data alone: a page reports
 * `has_more_before: false` / `truncated: false` because the fixture provably holds no older
 * row beyond the returned window, never because a flag was hard-coded per case.
 */

// Every fixture message carries `sent_at`: the backfill bound is a timestamp comparison, so a
// row without one could not be placed in a window and would make the paging proof hollow.
type SyntheticMessage = ConversationMessage & { sent_at: string };

const META_FIXTURE_CONVERSATIONS: readonly {
  thread: ConversationThread;
  messages: SyntheticMessage[];
}[] = [
  {
    // 7 messages: longer than the tail window, so the tail read demonstrably truncates and
    // backfill pages down through a mid-window (`has_more_before: true`) to a provably
    // exhausted final page.
    thread: {
      thread_id: 'synth-meta-thread-001',
      participants: ['Synthetic Contact A'],
      preview: 'Synthetic long-thread preview.'
    },
    messages: [
      { sender: 'other', sender_name: 'Synthetic Contact A', text: 'Synthetic long message one.', sent_at: '2025-03-01T10:00:00.000Z' },
      { sender: 'you', text: 'Synthetic long reply two.', sent_at: '2025-03-01T10:05:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Contact A', text: 'Synthetic long message three.', sent_at: '2025-03-01T10:10:00.000Z' },
      { sender: 'you', text: 'Synthetic long reply four.', sent_at: '2025-03-01T10:15:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Contact A', text: 'Synthetic long message five.', sent_at: '2025-03-01T10:20:00.000Z' },
      { sender: 'you', text: 'Synthetic long reply six.', sent_at: '2025-03-01T10:25:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Contact A', text: 'Synthetic long message seven.', sent_at: '2025-03-01T10:30:00.000Z' }
    ]
  },
  {
    // 3 messages: fits the tail window, so its tail is complete (`truncated: false`).
    thread: {
      thread_id: 'synth-meta-thread-002',
      participants: ['Synthetic Contact B'],
      preview: 'Synthetic short-thread preview.'
    },
    messages: [
      { sender: 'other', sender_name: 'Synthetic Contact B', text: 'Synthetic short opener.', sent_at: '2025-03-02T09:00:00.000Z' },
      { sender: 'you', text: 'Synthetic short reply.', sent_at: '2025-03-02T09:05:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Contact B', text: 'Synthetic short closer.', sent_at: '2025-03-02T09:10:00.000Z' }
    ]
  },
  {
    // 2 messages: a second short thread so the listing needs at least three entries and the
    // #151 truncation boundary is testable in both directions.
    thread: {
      thread_id: 'synth-meta-thread-003',
      participants: ['Synthetic Contact C'],
      preview: 'Synthetic pair-thread preview.'
    },
    messages: [
      { sender: 'you', text: 'Synthetic pair opener.', sent_at: '2025-03-03T12:00:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Contact C', text: 'Synthetic pair reply.', sent_at: '2025-03-03T12:05:00.000Z' }
    ]
  }
];

export const FIXTURE_META_THREADS: readonly ConversationThread[] = META_FIXTURE_CONVERSATIONS.map(
  ({ thread }) => conversationThreadSchema.parse(thread)
);

// Fixed tail window. The fixture holds each thread's whole history by construction, so a
// returned tail of at most this many messages is complete exactly when the thread itself is
// no longer than the window: the 7-message thread must report `truncated: true` (older rows
// exist beyond the window) while the short threads report an untruncated tail. The value is
// a fixture-construction property, pinned here so the tests assert against the same bound.
const META_TAIL_SIZE = 5;

/**
 * Read-only fixture over `MautrixMetaBackend` (#195). Deliberately no `sendThread`, no
 * `prepareDraft`, and no consumer-listing method: the transport boundary carries no write
 * capability, and the fixture must not grow one.
 */
export class FixtureMautrixMetaBackend implements MautrixMetaBackend {
  readonly name = 'fixture';

  listThreads(input: ReturnType<typeof threadsListInputSchema.parse>, _signal: AbortSignal): ConversationThreadListPage {
    // The fixture holds every synthetic thread, so truncation is exactly the rows the
    // caller's limit left out (#151).
    return {
      threads: FIXTURE_META_THREADS.slice(0, input.limit),
      truncated: FIXTURE_META_THREADS.length > input.limit
    };
  }

  readThread(input: ReturnType<typeof threadReadInputSchema.parse>, _signal: AbortSignal): ConversationThreadMessages | null {
    const conversation = META_FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === input.thread_id);
    if (!conversation) return null;
    const tail = [...conversation.messages].slice(-META_TAIL_SIZE);
    return {
      thread_id: input.thread_id,
      messages: tail,
      coverage: {
        window: 'tail',
        scanned_rows: tail.length,
        truncated: conversation.messages.length > META_TAIL_SIZE
      }
    };
  }

  backfillThread(input: ReturnType<typeof threadBackfillInputSchema.parse>, _signal: AbortSignal): ConversationBackfillPage | null {
    const conversation = META_FIXTURE_CONVERSATIONS.find(({ thread }) => thread.thread_id === input.thread_id);
    if (!conversation) return null;
    const beforeMs = Date.parse(input.before);
    // `before` is an exclusive bound: a row whose sent_at equals it is not part of the window.
    const older = conversation.messages.filter((message) => Date.parse(message.sent_at) < beforeMs);
    const kept = older.slice(-input.limit);
    // The window keeps the newest `limit` rows in chronological order, so a row remains
    // before the returned window exactly when `older` was longer than `kept` (the cap-dropped
    // prefix; and for an empty kept window, any row older than `before` at all). The fixture
    // holds every older row by construction, so `false` here is a proven exhaustion.
    const hasMoreBefore = older.length > kept.length;
    const droppedByCap = older.length - kept.length;
    return {
      messages: kept,
      coverage: {
        window: 'backfill',
        before: input.before,
        scanned_rows: older.length,
        has_more_before: hasMoreBefore,
        truncated: hasMoreBefore || droppedByCap > 0
      }
    };
  }
}
