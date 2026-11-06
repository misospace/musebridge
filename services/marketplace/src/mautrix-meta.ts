import { z } from 'zod';
import {
  conversationMessageSchema,
  conversationReadCoverageSchema,
  conversationThreadSchema
} from './domain.js';
import { normalizeRetryAfterHeader } from './retry-after.js';

/**
 * HTTP client for the isolated `mautrix-meta` transport service (#195).
 *
 * This module is the whole provider boundary Musebridge speaks. The AGPL `mautrix-meta`
 * fork runs as a SEPARATE, separately deployed service (see
 * `docs/mautrix-meta-transport-evaluation.md` §7, option 3); no upstream code is
 * incorporated or modified in this repository, and Musebridge stays license-neutral.
 * The contract pinned here is what the fork's host-facing read API must expose.
 *
 * Boundary rules this client enforces:
 * - GET only. The wire contract has no write route, so a caller cannot mutate anything
 *   through this client even by constructing a request by hand.
 * - The base URL must not be pointable at a Meta-owned host. Musebridge talks only to the
 *   operator's own transport service; pointing it at facebook.com / messenger.com /
 *   meta.com would turn the proof into a direct unofficial-API client, which the boundary
 *   forbids. Loopback and operator-private hosts over http/https are accepted; the
 *   transport carries no Musebridge-side credential, so there is no secret to exfiltrate
 *   through a redirect.
 * - Message content is only ever returned in memory to the tool layer. Nothing here
 *   persists message rows, cursors, session material, or key material; those live inside
 *   the transport service as operator-owned secrets.
 */

/**
 * Typed error codes the transport service may return in an error body.
 * `thread_not_found` is an absence, not a failure: the backend maps it to `null`
 * (the tool's NOT_FOUND), every other code maps to a typed ProviderError.
 * Challenge-family codes (`challenge_required`, `checkpoint_required`, `captcha_required`)
 * are reported exactly as the transport states them: they route the operator to the
 * official app. Nothing here — and nothing in the transport proof — automates a
 * challenge, a checkpoint, or 2FA.
 */
export const MAUTRIX_META_ERROR_CODES = [
  'login_required',
  'auth_expired',
  'session_invalid',
  'challenge_required',
  'checkpoint_required',
  'captcha_required',
  'rate_limited',
  'thread_not_found',
  'upstream_error'
] as const;

export type MautrixMetaErrorCode = typeof MAUTRIX_META_ERROR_CODES[number];

// The transport's action hint stays a fixed vocabulary, never free-form provider text.
const metaErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(MAUTRIX_META_ERROR_CODES),
    message: z.string().min(1).max(256),
    retry_after: z.number().int().nonnegative().optional()
  }).strict()
}).strict();

// Wire responses. The tail read carries the same `tail` coverage contract the browser read
// established (#146). The backfill wire coverage carries only the provider's own signals —
// `has_more_before` plus a scanned-row count; `before` is echoed from the request and
// `truncated` is composed by the backend, so the wire cannot forge either.
export const metaThreadListResponseSchema = z.object({
  threads: z.array(conversationThreadSchema).max(100),
  truncated: z.boolean()
}).strict();

export const metaThreadTailResponseSchema = z.object({
  messages: z.array(conversationMessageSchema).max(200),
  coverage: conversationReadCoverageSchema
}).strict();

export const metaThreadBackfillResponseSchema = z.object({
  messages: z.array(conversationMessageSchema).max(200),
  coverage: z.object({
    window: z.literal('backfill'),
    scanned_rows: z.number().int().nonnegative(),
    has_more_before: z.boolean()
  }).strict()
}).strict();

export type MetaThreadListResponse = z.infer<typeof metaThreadListResponseSchema>;
export type MetaThreadTailResponse = z.infer<typeof metaThreadTailResponseSchema>;
export type MetaThreadBackfillResponse = z.infer<typeof metaThreadBackfillResponseSchema>;

/**
 * Hosts the client refuses as transport destinations, by exact host or dotted subdomain:
 * these are Meta properties, and Musebridge must never speak an unofficial protocol to them
 * directly. Comparison is on the lowercased hostname with a leading-dot check, so
 * `facebook.com.evil.example` is not treated as a Meta host by suffix accident while
 * `m.facebook.com` is refused.
 */
const META_OWNED_HOSTS = ['facebook.com', 'messenger.com', 'meta.com'] as const;

export function isMetaOwnedHost(host: string): boolean {
  return META_OWNED_HOSTS.some((metaHost) => host === metaHost || host.endsWith(`.${metaHost}`));
}

/**
 * Comparison form of a WHATWG hostname: lowercased, IPv6 brackets stripped, and one
 * trailing dot stripped. The trailing dot matters because `https://facebook.com.` is the
 * fully-qualified spelling of the same host — DNS resolves it to Meta — and the bracket
 * form matters because `http://[::1]:9000` is the documented IPv6 sidecar.
 */
function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
}

/**
 * Resolves the transport base URL. Must be http(s), with no userinfo, search, or hash.
 * Meta-owned hosts are refused; loopback (the normal sidecar shape) and operator-private
 * hosts are accepted. There is deliberately no default destination: selecting the
 * transport without an explicit base URL fails at assembly, never at first request.
 */
export function resolveMetaTransportBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new TypeError('MAUTRIX_META_BASE_URL must be a valid http(s) URL'); }
  const host = canonicalHostname(parsed.hostname);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !host
    || isMetaOwnedHost(host)) {
    throw new TypeError('MAUTRIX_META_BASE_URL must be an http(s) URL of the operator-owned transport service with no userinfo, query, or fragment; Meta-owned hosts are never valid destinations');
  }
  if (!isLoopback && parsed.protocol !== 'https:') {
    throw new TypeError('MAUTRIX_META_BASE_URL must use https unless it points at loopback (the local sidecar shape)');
  }
  return baseUrl.replace(/\/$/, '');
}

export interface MautrixMetaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class MautrixMetaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: MautrixMetaErrorCode | 'unknown',
    readonly retryAfter?: number
  ) {
    super(`mautrix-meta transport returned HTTP ${status}`);
    this.name = 'MautrixMetaHttpError';
  }
}

export class MautrixMetaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MautrixMetaClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    this.baseUrl = resolveMetaTransportBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /v1/threads?limit=N — the bounded recent inbox window. */
  async listThreads(limit: number, signal?: AbortSignal): Promise<MetaThreadListResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    return metaThreadListResponseSchema.parse(await this.apiRequest(`/v1/threads?${params}`, signal));
  }

  /** GET /v1/threads/{threadId}/messages — the newest-end (tail) window of one thread. */
  async readThreadTail(threadId: string, signal?: AbortSignal): Promise<MetaThreadTailResponse> {
    return metaThreadTailResponseSchema.parse(await this.apiRequest(`/v1/threads/${encodeURIComponent(threadId)}/messages`, signal));
  }

  /**
   * GET /v1/threads/{threadId}/messages?before=<unix-ms>&limit=N — one older-message window.
   * `before` crosses the wire as Unix milliseconds (the LightSpeed paging unit the transport
   * pages on); the tool-facing contract stays ISO 8601.
   */
  async backfillThread(threadId: string, beforeUnixMs: number, limit: number, signal?: AbortSignal): Promise<MetaThreadBackfillResponse> {
    const params = new URLSearchParams({ before: String(beforeUnixMs), limit: String(limit) });
    return metaThreadBackfillResponseSchema.parse(await this.apiRequest(`/v1/threads/${encodeURIComponent(threadId)}/messages?${params}`, signal));
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Manual redirects: the Meta-host rule constrains every destination Musebridge
      // contacts, not just the configured base URL. A transport that answers with a
      // redirect to Meta or any other host is refused as a failure below instead of
      // being followed.
      redirect: 'manual',
      signal
    });
    if (!response.ok) throw await responseError(response);
    return response.json();
  }
}

/**
 * Reads the transport's typed error body. A body that fails validation keeps only the
 * status: the raw provider text is never carried forward (logs and outputs must not
 * echo provider content), and an unreadable failure is still a failure — never an
 * empty success.
 */
async function responseError(response: Response): Promise<MautrixMetaHttpError> {
  let code: MautrixMetaErrorCode | 'unknown' = 'unknown';
  let retryAfter: number | undefined;
  try {
    const parsed = metaErrorBodySchema.safeParse(await response.json());
    if (parsed.success) {
      code = parsed.data.error.code;
      retryAfter = parsed.data.error.retry_after;
    }
  } catch {
    // Non-JSON failure: keep 'unknown'.
  }
  // Header retry-after is only a hint when the body carried none; normalization is shared
  // with the other provider clients (retry-after.ts).
  if (retryAfter === undefined) retryAfter = normalizeRetryAfterHeader(response.headers.get('retry-after'));
  return new MautrixMetaHttpError(response.status, code, retryAfter);
}
