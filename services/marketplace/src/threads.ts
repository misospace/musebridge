import { normalizeRetryAfterHeader } from './retry-after.js';
import { resolveCredentialBaseUrl } from './credential-url.js';

export interface ThreadsClientOptions {
  accessToken: string;
  threadsUserId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ThreadsPostsListOptions {
  limit: number;
  since?: string;
  after?: string;
}

export interface ThreadsMentionsListOptions {
  limit: number;
  since?: string;
  after?: string;
}

// The mentions endpoint documents `since` as a timestamp that must be >= 1688540400
// (2023-07-05T07:00:00Z, the Threads launch floor). The user-posts endpoints document the
// `since=YYYY-MM-DD` date form instead, so only mentions converts the calendar date.
export const THREADS_MENTIONS_MIN_SINCE_UNIX = 1_688_540_400;

export class ThreadsHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter?: number) {
    super(`Threads API returned HTTP ${status}`);
    this.name = 'ThreadsHttpError';
  }
}

export class ThreadsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken: string;
  private readonly threadsUserId: string;

  constructor(options: ThreadsClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    if (typeof options.accessToken !== 'string' || !options.accessToken.trim()) throw new TypeError('accessToken must not be empty');
    if (typeof options.threadsUserId !== 'string' || !options.threadsUserId.trim()) throw new TypeError('threadsUserId must not be empty');
    // The Threads Graph API travels a bearer token; destination restriction
    // shared with the other provider clients (see credential-url.ts).
    this.baseUrl = resolveCredentialBaseUrl(
      options.baseUrl ?? 'https://graph.threads.net',
      ['graph.threads.net'],
      'baseUrl must be https://graph.threads.net or a loopback test address'
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.accessToken = options.accessToken;
    this.threadsUserId = options.threadsUserId;
  }

  async listOwnPosts(options: ThreadsPostsListOptions, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams();
    // `fields` documents the only fields we can promise to map (#46); unrequested fields
    // would silently widen the contract. `owner` is requested because `threads_user_id` is
    // mapped from `owner.id`: without it a live response carries no owner and every post
    // would map to `threads_user_id: null`.
    params.set('fields', 'id,media_type,media_url,permalink,text,thumbnail_url,timestamp,username,owner,shortcode,is_quote_post,quoted_post,reposted_post,reply_count,like_count');
    params.set('limit', String(options.limit));
    if (options.since !== undefined) {
      // Calendar date `since` is forwarded verbatim. The Threads API accepts the
      // YYYY-MM-DD shape and parses it server-side as a lower-bound inclusive local
      // timestamp; we forward it as-is rather than inventing an offset.
      params.set('since', options.since);
    }
    if (options.after !== undefined && options.after !== '') {
      params.set('after', options.after);
    }
    return this.apiRequest(`/${encodeURIComponent(this.threadsUserId)}/threads?${params}`, signal);
  }

  async listMentions(options: ThreadsMentionsListOptions, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams();
    // Same media-object projection as the user-posts endpoints: the mentions reference
    // documents the retrieve-posts field list, and `owner` is requested because a
    // mention's `threads_user_id` maps from `owner.id` (the mentioning author).
    params.set('fields', 'id,media_type,media_url,permalink,text,thumbnail_url,timestamp,username,owner,shortcode,is_quote_post,quoted_post,reposted_post,reply_count,like_count');
    params.set('limit', String(options.limit));
    if (options.since !== undefined) {
      // The mentions endpoint documents `since` as a Unix timestamp with a documented lower
      // bound (THREADS_MENTIONS_MIN_SINCE_UNIX), unlike the user-posts endpoints whose docs
      // show the `since=YYYY-MM-DD` date form. Convert the validated calendar date to its
      // UTC-midnight seconds — the same lower-bound-inclusive semantics a date carries —
      // instead of forwarding a shape the endpoint does not document.
      params.set('since', String(mentionsSinceUnixSeconds(options.since)));
    }
    if (options.after !== undefined && options.after !== '') {
      params.set('after', options.after);
    }
    return this.apiRequest(`/${encodeURIComponent(this.threadsUserId)}/mentions?${params}`, signal);
  }

  async listReplies(input: { mediaId: string; after?: string }, signal?: AbortSignal): Promise<unknown> {
    if (!input || typeof input !== 'object') throw new TypeError('input must be an object');
    const { mediaId, after } = input;
    if (typeof mediaId !== 'string' || !mediaId.trim()) throw new TypeError('mediaId must not be empty');
    const params = new URLSearchParams();
    params.set('fields', 'id,media_type,media_url,permalink,text,thumbnail_url,timestamp,username,owner,shortcode,is_quote_post,quoted_post,reposted_post');
    if (after !== undefined && after !== '') {
      params.set('after', after);
    }
    return this.apiRequest(`/${encodeURIComponent(mediaId)}/replies?${params}`, signal);
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json'
      },
      signal
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
}

async function responseError(response: Response): Promise<ThreadsHttpError> {
  // Normalization (blank/negative/nonnumeric/out-of-range → no hint, fraction truncated) is
  // shared with the other provider clients in retry-after.ts.
  return new ThreadsHttpError(response.status, normalizeRetryAfterHeader(response.headers.get('retry-after')));
}

// Converts a validated `YYYY-MM-DD` calendar date to the Unix-seconds value the mentions
// endpoint expects, enforcing the documented lower bound. The input schema rejects
// out-of-range dates as InvalidParams before a request is ever assembled; this guard is
// what a directly-constructed client call hits instead, so no request goes out below the
// bound (the endpoint would reject it) and no malformed date reaches the query string.
export function mentionsSinceUnixSeconds(since: string): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(since);
  const year = parts ? Number(parts[1]) : Number.NaN;
  const month = parts ? Number(parts[2]) : Number.NaN;
  const day = parts ? Number(parts[3]) : Number.NaN;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Calendar round-trip (same check as the input schema): `Date.UTC` rolls day-invalid
  // strings like `2025-02-30` over to March and yields Invalid Date for a missing match,
  // so require the components to survive.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError('since must be a valid YYYY-MM-DD date');
  }
  const seconds = Math.floor(date.getTime() / 1000);
  if (seconds < THREADS_MENTIONS_MIN_SINCE_UNIX) {
    throw new TypeError(`since must not be earlier than the mentions endpoint minimum timestamp ${THREADS_MENTIONS_MIN_SINCE_UNIX}`);
  }
  return seconds;
}
