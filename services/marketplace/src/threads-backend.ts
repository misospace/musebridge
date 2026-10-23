import { z } from 'zod';
import { ProviderError, type ThreadsBackend, type ThreadsPostPage, type ThreadsReplyPage } from './backend.js';
import { MAX_THREADS_MEDIA_URLS, MAX_THREADS_REPLY_COUNT, isOfficialThreadsMediaUrl, threadsPostSchema, threadsReplySchema, type ThreadsPost, type ThreadsReply } from './domain.js';
import { ThreadsClient, ThreadsHttpError, type ThreadsClientOptions } from './threads.js';
import { validateTimeout } from './timeout.js';

const isoOffsetSchema = z.string().datetime({ offset: true });

// Bounded cursor following: each call may walk at most this many upstream pages, so a
// pathological provider cannot make one tool call unbounded. Reaching the bound with a
// live cursor marks the page truncated rather than silently claiming completeness.
const MAX_THREADS_PAGES = 5;

export class ThreadsApiBackend implements ThreadsBackend {
  readonly name = 'threads';
  private readonly client: ThreadsClient;
  private readonly requestTimeoutMs: number;

  constructor(client: ThreadsClient | ThreadsClientOptions, options: { requestTimeoutMs?: number } = {}) {
    this.client = client instanceof ThreadsClient ? client : new ThreadsClient(client);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    validateTimeout(this.requestTimeoutMs, 'requestTimeoutMs');
  }

  async listOwnPosts(input: Parameters<ThreadsBackend['listOwnPosts']>[0], signal: AbortSignal): Promise<ThreadsPostPage> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        const seen = new Set<string>();
        const posts: ThreadsPost[] = [];
        let after: string | undefined;
        let truncated = false;
        for (let page = 0; page < MAX_THREADS_PAGES; page++) {
          const payload = await this.client.listOwnPosts({
            limit: input.limit,
            ...(input.since !== undefined ? { since: input.since } : {}),
            ...(after !== undefined ? { after } : {})
          }, requestSignal);
          const data = requireDataArray(payload);
          // A non-array `data` is schema drift, never a silent empty page; `{data: []}` is
          // the documented legitimate zero-result page and returns [].
          if (data === null) throw new ProviderError('UPSTREAM_ERROR', 'The Threads posts response was not recognized.');
          const next = cursorAfter(payload);
          // Only unconsumed items in *this* page (or a live cursor) mean more results may
          // exist; hitting the limit on the final item of an exhausted page is complete.
          let moreInPage = false;
          for (let index = 0; index < data.length; index++) {
            const post = mapPost(data[index]);
            if (!post) throw new ProviderError('UPSTREAM_ERROR', 'The Threads posts response was not recognized.');
            if (seen.has(post.id)) continue;
            seen.add(post.id);
            posts.push(post);
            if (posts.length >= input.limit) { moreInPage = index < data.length - 1; break; }
          }
          if (posts.length >= input.limit) {
            truncated = moreInPage || next !== undefined;
            break;
          }
          if (next === undefined) {
            truncated = false;
            break;
          }
          after = next;
          if (page === MAX_THREADS_PAGES - 1) truncated = true;
        }
        return { posts, truncated };
      } catch (error) { throw mapError(error); }
    });
  }

  async listReplies(input: Parameters<ThreadsBackend['listReplies']>[0], signal: AbortSignal): Promise<ThreadsReplyPage | null> {
    return this.withDeadline(signal, async (requestSignal) => {
      try {
        const seen = new Set<string>();
        const replies: ThreadsReply[] = [];
        let after: string | undefined;
        let truncated = false;
        for (let page = 0; page < MAX_THREADS_PAGES; page++) {
          const payload = await this.client.listReplies({
            mediaId: input.media_id,
            ...(after !== undefined ? { after } : {})
          }, requestSignal);
          const data = requireDataArray(payload);
          if (data === null) throw new ProviderError('UPSTREAM_ERROR', 'The Threads replies response was not recognized.');
          const next = cursorAfter(payload);
          // Only unconsumed items in *this* page (or a live cursor) mean more results may
          // exist; hitting the cap on the final item of an exhausted page is complete.
          let moreInPage = false;
          for (let index = 0; index < data.length; index++) {
            const reply = mapReply(data[index], input.media_id);
            if (!reply) throw new ProviderError('UPSTREAM_ERROR', 'The Threads replies response was not recognized.');
            if (seen.has(reply.id)) continue;
            seen.add(reply.id);
            replies.push(reply);
            if (replies.length >= MAX_THREADS_REPLY_COUNT) { moreInPage = index < data.length - 1; break; }
          }
          if (replies.length >= MAX_THREADS_REPLY_COUNT) {
            truncated = moreInPage || next !== undefined;
            break;
          }
          if (next === undefined) {
            truncated = false;
            break;
          }
          after = next;
          if (page === MAX_THREADS_PAGES - 1) truncated = true;
        }
        return { replies, truncated };
      } catch (error) {
        // A missing media is the house "no result" case: return null and let the tool layer
        // report NOT_FOUND, mirroring the other backends.
        if (error instanceof ThreadsHttpError && error.status === 404) return null;
        throw mapError(error);
      }
    });
  }

  private async withDeadline<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw timeoutOrAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), this.requestTimeoutMs);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(timeoutOrAbort(controller.signal)), { once: true }))
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}

function timeoutOrAbort(signal: AbortSignal): ProviderError {
  return new ProviderError('TIMEOUT', signal.reason instanceof Error && signal.reason.message === 'deadline exceeded' ? 'The Threads request timed out.' : 'The Threads request was aborted.');
}

function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof ThreadsHttpError) {
    if (error.status === 401 || error.status === 403) return new ProviderError('AUTH_EXPIRED', 'Threads authentication has expired.');
    if (error.status === 429) return new ProviderError('RATE_LIMITED', 'Threads rate limit was reached.', error.retryAfter === undefined ? {} : { retry_after: error.retryAfter });
    return new ProviderError('UPSTREAM_ERROR', 'The Threads request failed.');
  }
  return new ProviderError('UPSTREAM_ERROR', 'The Threads request failed.');
}

// Returns the array-valued `data` field, or null when the payload is not a recognized
// page shape. Callers throw their own distinct drift message so posts and replies stay
// distinguishable; `{data: []}` is a legitimate zero-result page and returns [].
function requireDataArray(payload: unknown): unknown[] | null {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return null;
}

// Extracts the forward cursor without ever surfacing the raw `paging.next` URL: that URL
// can carry the access token, so only the `after` value is ever returned. `cursors.after`
// wins when present; otherwise the `after` search param of `next` is parsed out. A present
// cursor field we cannot read is schema drift — a `paging` container in a shape we do not
// recognize (a non-object, including an array), `next` unresolvable, or `cursors` sent in a
// shape we do not recognize (not an object, or an unusable `after`) — and throwing keeps a
// drifted cursor from silently claiming the page set was exhausted (a false `truncated: false`).
// Only an absent or explicitly-null `paging` field is the documented "no pagination" case.
function cursorAfter(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const paging = (payload as { paging?: unknown }).paging;
  // `undefined` (field omitted) and `null` are the documented exhausted-page shapes; anything
  // else that is not a readable object container (string, number, boolean, array) is drift,
  // because an unrecognized pagination schema may be hiding more results.
  if (paging === undefined || paging === null) return undefined;
  if (typeof paging !== 'object' || Array.isArray(paging)) {
    throw new ProviderError('UPSTREAM_ERROR', 'The Threads response paging container was not recognized.');
  }
  const cursors = (paging as { cursors?: unknown }).cursors;
  // A `cursors` field the provider sent that we cannot read as a forward cursor — a non-object
  // (including an array), or an `after` that is neither a non-empty string nor absent. `next` is
  // a separate field that may still carry one, so this is only drift once `next` cannot help.
  // `after: null`/`undefined` is the documented "no cursor" case and is not drift.
  let cursorsUnreadable = cursors !== undefined && cursors !== null;
  if (cursors && typeof cursors === 'object' && !Array.isArray(cursors)) {
    const after = (cursors as { after?: unknown }).after;
    if (typeof after === 'string' && after !== '') return after;
    cursorsUnreadable = after !== undefined && after !== null;
  }
  const next = (paging as { next?: unknown }).next;
  if (next === undefined || next === null || next === '') {
    if (cursorsUnreadable) {
      throw new ProviderError('UPSTREAM_ERROR', 'The Threads response paging cursor was not recognized.');
    }
    return undefined;
  }
  if (typeof next === 'string') {
    try {
      const after = new URL(next).searchParams.get('after');
      if (after) return after;
    } catch {
      // Fall through to the drift error below.
    }
  }
  throw new ProviderError('UPSTREAM_ERROR', 'The Threads response paging cursor was not recognized.');
}

// The documented media_type enum. Anything else maps to `UNKNOWN` rather than guessed;
// the schema's strict() then rejects anything the API returns that we cannot promise to
// interpret (#46: the load-bearing facts).
const MEDIA_TYPE: Readonly<Record<string, ThreadsPost['media_type']>> = {
  TEXT_POST: 'TEXT_POST',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  CAROUSEL_ALBUM: 'CAROUSEL_ALBUM',
  REPOST_FACADE: 'REPOST_FACADE'
};

function mediaTypeFromCode(value: unknown): ThreadsPost['media_type'] {
  if (typeof value !== 'string') return 'UNKNOWN';
  return MEDIA_TYPE[value] ?? 'UNKNOWN';
}

function isoWithOffset(value: unknown): string | null {
  const parsed = isoOffsetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function finiteCount(value: unknown): number | null {
  // Coercion trap: Number(null) and Number('') are both 0, so an absent or empty count
  // must be rejected before coercion, not defaulted to zero.
  if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) && Number.isInteger(num) && num >= 0 ? num : null;
  }
  return null;
}

function ownerIdFromItem(item: Record<string, any>): string | null {
  // `owner.id` is the stable Threads user id; `username`/`owner.username` is a mutable
  // handle and must never be relabelled as an id. Absent owner is `null`, not a
  // fabricated value — and never a reason to drop an otherwise valid item.
  const ownerId = item.owner?.id;
  if (typeof ownerId === 'string' && ownerId.trim() !== '') return ownerId;
  return null;
}

function postText(item: Record<string, any>): string | null {
  // Meta permits image/carousel posts with no caption, so an absent or blank caption is a
  // legitimate `null` (same guard shape as `finiteCount`), not schema drift that would
  // fail the whole upstream page. The text is otherwise returned verbatim.
  if (typeof item.text === 'string' && item.text.trim() !== '') return item.text;
  return null;
}

// Collect the candidate media URLs the item advertises, then keep only those the media-URL
// allowlist accepts. A media URL is a display artifact, not a load-bearing fact: a URL on a
// host outside the allowlist is DROPPED (never returned, never rewritten, never substituted)
// rather than discarding an otherwise valid post and failing the whole upstream page. The
// deliberate consequence: a suppressed media URL is indistinguishable in the output from a
// post that carried none — `media_type` may still say `IMAGE` beside an empty `media_urls`.
// The domain schema stays strict, so no unapproved URL can reach the contract either way.
function mapMediaUrls(item: Record<string, any>): string[] {
  const candidates: string[] = [];
  if (typeof item.media_url === 'string') candidates.push(item.media_url);
  if (typeof item.thumbnail_url === 'string') candidates.push(item.thumbnail_url);
  if (Array.isArray(item.children)) {
    for (const child of item.children) {
      if (typeof child?.media_url === 'string') candidates.push(child.media_url);
      if (typeof child?.thumbnail_url === 'string') candidates.push(child.thumbnail_url);
    }
  }
  return candidates.filter(isOfficialThreadsMediaUrl).slice(0, MAX_THREADS_MEDIA_URLS);
}

function mapPost(value: unknown): ThreadsPost | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, any>;
  const id = typeof item.id === 'string' ? item.id : '';
  const permalink = typeof item.permalink === 'string' ? item.permalink : '';
  if (!id || !permalink) return null;
  const post = {
    provider: 'threads' as const,
    id,
    threads_user_id: ownerIdFromItem(item),
    permalink,
    text: postText(item),
    media_type: mediaTypeFromCode(item.media_type),
    media_urls: mapMediaUrls(item),
    reply_count: finiteCount(item.reply_count),
    like_count: finiteCount(item.like_count),
    posted_at: isoWithOffset(item.timestamp)
  };
  const parsed = threadsPostSchema.safeParse(post);
  return parsed.success ? parsed.data : null;
}

function mapReply(value: unknown, parentMediaId: string): ThreadsReply | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, any>;
  const id = typeof item.id === 'string' ? item.id : '';
  const permalink = typeof item.permalink === 'string' ? item.permalink : '';
  if (!id || !permalink) return null;
  const reply = {
    provider: 'threads' as const,
    id,
    media_id: parentMediaId,
    permalink,
    threads_user_id: ownerIdFromItem(item),
    text: postText(item),
    media_type: mediaTypeFromCode(item.media_type),
    media_urls: mapMediaUrls(item),
    posted_at: isoWithOffset(item.timestamp)
  };
  const parsed = threadsReplySchema.safeParse(reply);
  return parsed.success ? parsed.data : null;
}
