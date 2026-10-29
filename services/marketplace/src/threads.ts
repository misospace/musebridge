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
