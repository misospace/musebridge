import { ProviderError } from './backend.js';
import type {
  ConversationBackfillPage,
  ConversationThreadListPage,
  MautrixMetaBackend
} from './backend.js';
import {
  MAX_BACKFILL_MESSAGE_COUNT,
  MAX_THREAD_LIST_COUNT,
  MAX_THREAD_READ_MESSAGE_COUNT,
  type ConversationThreadMessages,
  type ThreadBackfillInput,
  type ThreadReadInput,
  type ThreadsListInput
} from './domain.js';
import {
  MautrixMetaClient,
  MautrixMetaContractError,
  MautrixMetaHttpError,
  type MautrixMetaErrorCode
} from './mautrix-meta.js';

/**
 * The read-only Musebridge-side backend over the isolated `mautrix-meta` transport service
 * (#195). The class implements exactly the `MautrixMetaBackend` surface: list, tail read,
 * and older-window backfill. There is deliberately no `sendThread`, no `prepareDraft`, and
 * no other write method on this type — and the tool registry gates write tools on
 * `ConversationBackend` methods this type does not have — so no Messenger write can be
 * served through this provider without widening a reviewed boundary type first.
 *
 * Persistence: none. Message rows cross this class in memory only. Session material,
 * sync-group cursors, and E2EE key material live inside the transport service as
 * operator-owned secrets (see `docs/mautrix-meta-transport-evaluation.md` §5/§9 and
 * `docs/mautrix-meta-provider-proof.md`). Nothing here writes them, logs them, or returns them.
 */
export interface MautrixMetaApiBackendOptions {
  client: MautrixMetaClient;
}

// The static per-code failure text. Provider bodies are validated for classification but
// their text is never carried forward: this service's own message stays the single
// human-facing string, and no provider content reaches logs or outputs.
const META_FAILURE_TEXT: Record<Exclude<MautrixMetaErrorCode, 'thread_not_found'>, { code: 'LOGIN_REQUIRED' | 'AUTH_EXPIRED' | 'SESSION_INVALID' | 'CAPTCHA_REQUIRED' | 'RATE_LIMITED' | 'UPSTREAM_ERROR'; message: string; action_required?: string }> = {
  login_required: {
    code: 'LOGIN_REQUIRED',
    message: 'The mautrix-meta transport has no authenticated session. Complete the native Messenger login in the transport service.',
    action_required: 'native_login_in_transport_service'
  },
  auth_expired: {
    code: 'AUTH_EXPIRED',
    message: 'The mautrix-meta transport session expired. Re-run the native Messenger login in the transport service.',
    action_required: 'native_login_in_transport_service'
  },
  session_invalid: {
    code: 'SESSION_INVALID',
    message: 'The mautrix-meta transport session is invalid. Re-run the native Messenger login in the transport service.',
    action_required: 'native_login_in_transport_service'
  },
  challenge_required: {
    code: 'CAPTCHA_REQUIRED',
    message: 'Meta presents a challenge to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates challenges.',
    action_required: 'manual_resolution_in_official_app'
  },
  checkpoint_required: {
    code: 'CAPTCHA_REQUIRED',
    message: 'Meta presents a checkpoint to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates checkpoints.',
    action_required: 'manual_resolution_in_official_app'
  },
  captcha_required: {
    code: 'CAPTCHA_REQUIRED',
    message: 'Meta presents a captcha to the mautrix-meta transport. Resolve it manually in the official Messenger or Facebook app; this service never automates captchas.',
    action_required: 'manual_resolution_in_official_app'
  },
  rate_limited: {
    code: 'RATE_LIMITED',
    message: 'The mautrix-meta transport is rate limited. Reduce request volume or wait before the next read.'
  },
  upstream_error: {
    code: 'UPSTREAM_ERROR',
    message: 'The mautrix-meta transport reported a failure reading Messenger.'
  }
};

export class MautrixMetaApiBackend implements MautrixMetaBackend {
  readonly name = 'mautrix-meta';
  private readonly client: MautrixMetaClient;

  constructor(options: MautrixMetaApiBackendOptions) {
    if (!options || typeof options !== 'object' || !(options.client instanceof MautrixMetaClient)) {
      throw new TypeError('MautrixMetaApiBackend requires a MautrixMetaClient');
    }
    this.client = options.client;
  }

  /**
   * The bounded recent thread window. The transport may page wider than the caller asked for
   * (its page bound is larger than the public listing bound), so the window the caller
   * receives is composed here: the transport lists newest-first, so the rows that fall outside
   * are the older ones, and dropping them is what makes `truncated` true — more threads exist
   * beyond the window the caller received.
   */
  async listThreads(input: ThreadsListInput, signal: AbortSignal): Promise<ConversationThreadListPage> {
    try {
      const page = await this.client.listThreads(input.limit, signal);
      const window = Math.min(input.limit, MAX_THREAD_LIST_COUNT);
      const dropped = Math.max(page.threads.length - window, 0);
      const threads = dropped > 0 ? page.threads.slice(0, window) : page.threads;
      return { threads, truncated: page.truncated || dropped > 0 };
    } catch (error) {
      throw toProviderFailure(error);
    }
  }

  /**
   * The newest-end (tail) window. The rows are chronological and the window is anchored at the
   * newest end, so the rows that fall outside the public bound are the oldest ones: dropping
   * them keeps the newest end intact and makes `truncated` true — older messages exist outside
   * the window the caller received.
   */
  async readThread(input: ThreadReadInput, signal: AbortSignal): Promise<ConversationThreadMessages | null> {
    try {
      const tail = await this.client.readThreadTail(input.thread_id, signal);
      const dropped = Math.max(tail.messages.length - MAX_THREAD_READ_MESSAGE_COUNT, 0);
      const messages = dropped > 0
        ? tail.messages.slice(tail.messages.length - MAX_THREAD_READ_MESSAGE_COUNT)
        : tail.messages;
      return {
        thread_id: input.thread_id,
        messages,
        coverage: {
          window: tail.coverage.window,
          scanned_rows: tail.coverage.scanned_rows,
          truncated: tail.coverage.truncated || dropped > 0
        }
      };
    } catch (error) {
      if (isThreadNotFound(error)) return null;
      throw toProviderFailure(error);
    }
  }

  /**
   * One older window. The wire keeps provider-authored coverage only (`scanned_rows`,
   * `has_more_before`); this method composes the caller-facing window truth: if the
   * provider page carried more rows than the caller's cap kept, the oldest rows (the end
   * farthest from the requested bound) are dropped and `truncated` becomes true even when the
   * provider range itself was exhausted. The dropped rows are older messages that sit before
   * the returned window, so `has_more_before` is true whenever the cap dropped rows, exactly
   * as the fixture backend reports it. `has_more_before: true` always implies
   * `truncated: true` — an unexhausted range is never reported as a complete window.
   */
  async backfillThread(input: ThreadBackfillInput, signal: AbortSignal): Promise<ConversationBackfillPage | null> {
    const beforeUnixMs = Date.parse(input.before);
    if (!Number.isSafeInteger(beforeUnixMs)) {
      // threadBackfillInputSchema already guarantees a parseable ISO instant; this guards
      // a directly-constructed call from fabricating a paging bound.
      throw new TypeError('before must be a parseable ISO 8601 instant');
    }
    try {
      const page = await this.client.backfillThread(input.thread_id, beforeUnixMs, input.limit, signal);
      const window = Math.min(input.limit, MAX_BACKFILL_MESSAGE_COUNT);
      const droppedByCap = Math.max(page.messages.length - window, 0);
      const messages = droppedByCap > 0 ? page.messages.slice(droppedByCap) : page.messages;
      const hasMoreBefore = page.coverage.has_more_before || droppedByCap > 0;
      return {
        messages,
        coverage: {
          window: 'backfill',
          before: input.before,
          scanned_rows: page.coverage.scanned_rows,
          has_more_before: hasMoreBefore,
          truncated: hasMoreBefore
        }
      };
    } catch (error) {
      if (isThreadNotFound(error)) return null;
      throw toProviderFailure(error);
    }
  }
}

// An absence notice is only an absence when the transport says so with a 404. A
// `thread_not_found` code attached to a 5xx (or any other status) is a provider failure
// wearing an absence label: it fails closed through the typed-error mapping rather than
// becoming a definitive NOT_FOUND the caller could cache.
function isThreadNotFound(error: unknown): boolean {
  return error instanceof MautrixMetaHttpError && error.status === 404 && error.code === 'thread_not_found';
}

/**
 * Maps a transport failure to the repo's typed `ProviderError`. A validated typed code
 * wins; an unclassified failure falls back by HTTP status; everything else (including a
 * success body that fails wire validation) is `UPSTREAM_ERROR` — drift fails closed, it is
 * never an empty success and never echoes provider content. Abort errors propagate
 * untouched so the tool layer's deadline/shutdown handling owns them.
 */
function toProviderFailure(error: unknown): unknown {
  if (error instanceof ProviderError) return error;
  if (error instanceof MautrixMetaContractError) {
    // The transport answered, but its answer cannot support the coverage claim: an undated
    // row, rows out of order, a row at or after the requested bound, or a tail window with
    // no rows. It is a typed upstream failure, never a window that claims more than it can
    // prove, and never an empty success.
    return new ProviderError('UPSTREAM_ERROR', 'The mautrix-meta transport returned a window that does not satisfy the pinned coverage contract.');
  }
  if (error instanceof MautrixMetaHttpError) {
    // A 404 thread_not_found never reaches this branch (the callers map it to absence).
    // Reaching here with that label — from a listing route or a non-404 status — is a
    // provider failure, classified like any other status fallback.
    const classified: Exclude<MautrixMetaErrorCode, 'thread_not_found'> =
      error.code === 'unknown' || error.code === 'thread_not_found' ? classifyByStatus(error.status) : error.code;
    const mapped = META_FAILURE_TEXT[classified];
    const metadata = {
      ...(mapped.action_required !== undefined ? { action_required: mapped.action_required } : {}),
      ...(classified === 'rate_limited' && error.retryAfter !== undefined ? { retry_after: error.retryAfter } : {})
    };
    return new ProviderError(mapped.code, mapped.message, metadata);
  }
  if (error instanceof Error && error.name === 'AbortError') return error;
  return new ProviderError('UPSTREAM_ERROR', 'The mautrix-meta transport returned a response this build does not recognize.');
}

// Status fallback for error bodies this build cannot classify: the codes the transport
// documents for these statuses, so an older or proxy-mangled body still fails closed into
// the right family.
function classifyByStatus(status: number): Exclude<MautrixMetaErrorCode, 'thread_not_found'> {
  if (status === 401) return 'login_required';
  if (status === 403) return 'session_invalid';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}
