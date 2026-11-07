import { z } from 'zod';
import {
  conversationMessageSchema,
  conversationReadCoverageSchema,
  conversationThreadSchema,
  type ConversationMessage
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
 *   forbids. Loopback and operator-private hosts over http/https are accepted.
 * - The boundary is authenticated. A non-loopback destination (anything that leaves the
 *   host) requires the service credential, and every request then carries it as
 *   `Authorization: Bearer <token>`. The credential belongs to Musebridge and its own
 *   transport service, never to Meta. It travels only to the fixed configured destination,
 *   and redirects stay manual, so a redirect cannot exfiltrate it.
 * - Message content is only ever returned in memory to the tool layer. Nothing here
 *   persists message rows, cursors, session material, key material, or the service
 *   credential; the credential stays in memory, and session material lives inside the
 *   transport service as operator-owned secrets.
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
//
// The row caps below are the transport's own page bounds, not the caller-facing window: the
// transport may page wider than a caller asked for, and the backend composes the window the
// caller receives out of the page (see `mautrix-meta-backend.ts`). The transport's page order
// is part of the pinned contract — threads newest-first, messages chronological
// oldest-to-newest — because the composition drops the oldest rows and keeps the newest.
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
 * The transport answered, but its answer cannot support the coverage claim Musebridge makes.
 *
 * Every coverage claim on this boundary is proven by the message rows' own timestamps: the
 * tail window's newest end is the newest row's instant, and the backfill window's exclusive
 * bound is checked against every row. A page that breaks that proof — a row without a
 * timestamp, rows out of chronological order, a row at or after the requested bound, or a
 * tail window with no rows at all (no rows, no newest end) — is not a window. It fails closed
 * as a typed upstream failure instead of becoming a window that claims more than it can
 * prove. The message is this service's own static text: no provider row ever reaches it.
 */
export class MautrixMetaContractError extends Error {
  constructor() {
    super('mautrix-meta transport response violates the pinned coverage contract');
    this.name = 'MautrixMetaContractError';
  }
}

/**
 * The instant a row carries, or `undefined` when the row carries none. The wire schema types
 * `sent_at` as an optional ISO 8601 instant, so a present value always parses.
 */
function rowInstant(row: ConversationMessage): number | undefined {
  if (row.sent_at === undefined) return undefined;
  const instant = Date.parse(row.sent_at);
  return Number.isFinite(instant) ? instant : undefined;
}

/**
 * Every row must carry its own instant, and the rows must be chronological (oldest first).
 * The newest end of a window is the newest row's instant, so an undated page cannot place a
 * row in the window at all, and an out-of-order page cannot say which row is the newest.
 */
function assertDatedChronologicalRows(rows: readonly ConversationMessage[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const instant = rowInstant(row);
    if (instant === undefined) throw new MautrixMetaContractError();
    if (instant < previous) throw new MautrixMetaContractError();
    previous = instant;
  }
}

/**
 * Every backfill row must be strictly older than the requested bound: the bound is exclusive,
 * so a row at the bound or newer is outside the window the caller asked for and the returned
 * window would no longer be the window the coverage describes.
 *
 * The comparison is made at the millisecond, because that is the unit the bound crosses the
 * wire on and the unit the transport pages on. A row that shares the bound's millisecond is a
 * row at the bound for this contract, so the transport must not return it.
 */
function assertStrictlyOlderThan(rows: readonly ConversationMessage[], beforeUnixMs: number): void {
  for (const row of rows) {
    const instant = rowInstant(row);
    if (instant === undefined || instant >= beforeUnixMs) throw new MautrixMetaContractError();
  }
}

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
 * Loopback hosts. A loopback destination is the network-private sidecar shape: the traffic
 * never leaves the host, so it needs no service credential. The bracketed IPv6 spelling
 * (`http://[::1]:9000`) reaches the same host because `canonicalHostname` strips the
 * brackets.
 */
function isLoopbackHostname(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

/**
 * The service credential format: 1 to 512 printable ASCII characters, from 0x21 to 0x7E.
 * That excludes spaces, control characters, and leading or trailing whitespace, so the
 * value can travel in an `Authorization` header without escaping. One shared validator
 * serves the client constructor and the service gate, so the two layers cannot drift.
 * The value itself never appears in a message.
 */
const SERVICE_TOKEN_PATTERN = /^[\x21-\x7E]{1,512}$/;

/**
 * Reports whether a service credential is well formed. The value is never echoed.
 * The type check comes first: a value that is not a string is not a credential, and the
 * pattern test would otherwise coerce it (`null` becomes the text "null") and accept it.
 */
export function isValidMautrixMetaServiceToken(token: unknown): boolean {
  return typeof token === 'string' && SERVICE_TOKEN_PATTERN.test(token);
}

/**
 * Reports whether a transport base URL points at loopback. A URL that does not parse is
 * refused with the same `TypeError` the resolver raises, so a malformed destination never
 * reads as "not loopback" and slips past the credential requirement.
 */
export function isLoopbackTransportHost(baseUrl: string): boolean {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new TypeError('MAUTRIX_META_BASE_URL must be a valid http(s) URL'); }
  return isLoopbackHostname(canonicalHostname(parsed.hostname));
}

/**
 * Resolves the transport base URL. Must be http(s), with no userinfo, search, or hash.
 * Meta-owned hosts are refused; loopback (the normal sidecar shape) and operator-private
 * hosts are accepted. There is deliberately no default destination: selecting the
 * transport without an explicit base URL fails at assembly, never at first request.
 *
 * A non-loopback destination needs the service credential, and a credential that is
 * configured must be well formed. A loopback destination runs without one, because the
 * traffic never leaves the host.
 *
 * The return value is normalized from the parsed URL, never from the raw operator string:
 * surrounding whitespace is trimmed before parsing, and the result is the origin plus the
 * pathname, with the trailing slash dropped only when the pathname is the bare `/`. A
 * trailing `?` or `#` with no content parses to an empty search/hash, passes every guard,
 * and disappears in this normalization, so the value concatenated into a fetch target can
 * never carry it. A search or hash with content stays refused by the guards above.
 */
export function resolveMetaTransportBaseUrl(baseUrl: string, serviceToken?: string): string {
  let parsed: URL;
  // Trim inside the try: a value that is not a trimmable string must fail with the same
  // typed refusal as one that does not parse, not with a property-access error.
  try { parsed = new URL(baseUrl.trim()); } catch { throw new TypeError('MAUTRIX_META_BASE_URL must be a valid http(s) URL'); }
  const host = canonicalHostname(parsed.hostname);
  const isLoopback = isLoopbackHostname(host);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !host
    || isMetaOwnedHost(host)) {
    throw new TypeError('MAUTRIX_META_BASE_URL must be an http(s) URL of the operator-owned transport service with no userinfo, query, or fragment; Meta-owned hosts are never valid destinations');
  }
  if (!isLoopback && parsed.protocol !== 'https:') {
    throw new TypeError('MAUTRIX_META_BASE_URL must use https unless it points at loopback (the local sidecar shape)');
  }
  if (serviceToken !== undefined && !isValidMautrixMetaServiceToken(serviceToken)) {
    throw new TypeError('MAUTRIX_META_SERVICE_TOKEN must be 1 to 512 printable ASCII characters (0x21 to 0x7E)');
  }
  if (!isLoopback && serviceToken === undefined) {
    throw new TypeError('MAUTRIX_META_SERVICE_TOKEN is required for a MAUTRIX_META_BASE_URL destination that is not loopback');
  }
  // Normalized from the parsed URL: origin plus pathname drops any empty trailing `?`/`#`
  // the guards let through, and the bare-`/` pathname's slash is the only one removed.
  return parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

export interface MautrixMetaClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * The service credential for Musebridge's own transport service. It is not a Meta
   * credential. It stays in memory: it is never logged, never returned, and never
   * persisted.
   */
  serviceToken?: string;
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
  private readonly serviceToken?: string;

  constructor(options: MautrixMetaClientOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('options must be an object');
    // Read the credential once. A caller can hand in an options object whose property
    // returns a different value on each read, and a second read after the check would let
    // the check pass on one value while the client stored another.
    const serviceToken = options.serviceToken;
    this.baseUrl = resolveMetaTransportBaseUrl(options.baseUrl, serviceToken);
    this.serviceToken = serviceToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** GET /v1/threads?limit=N — the bounded recent inbox window. */
  async listThreads(limit: number, signal?: AbortSignal): Promise<MetaThreadListResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    return metaThreadListResponseSchema.parse(await this.apiRequest(`/v1/threads?${params}`, signal));
  }

  /** GET /v1/threads/{threadId}/messages — the newest-end (tail) window of one thread. */
  async readThreadTail(threadId: string, signal?: AbortSignal): Promise<MetaThreadTailResponse> {
    const parsed = metaThreadTailResponseSchema.parse(await this.apiRequest(`/v1/threads/${encodeURIComponent(threadId)}/messages`, signal));
    // The tail window's newest end is proven by the rows' own timestamps, and a window with
    // no rows has no newest end at all. Both are contract violations, not windows.
    assertDatedChronologicalRows(parsed.messages);
    if (parsed.messages.length === 0) throw new MautrixMetaContractError();
    return parsed;
  }

  /**
   * GET /v1/threads/{threadId}/messages?before=<unix-ms>&limit=N — one older-message window.
   * `before` crosses the wire as Unix milliseconds (the LightSpeed paging unit the transport
   * pages on); the tool-facing contract stays ISO 8601. The millisecond is the unit on both
   * sides of this boundary, so the bound is a whole millisecond (the tool input contract
   * refuses a finer fraction) and the exclusive comparison happens at that resolution.
   */
  async backfillThread(threadId: string, beforeUnixMs: number, limit: number, signal?: AbortSignal): Promise<MetaThreadBackfillResponse> {
    const params = new URLSearchParams({ before: String(beforeUnixMs), limit: String(limit) });
    const parsed = metaThreadBackfillResponseSchema.parse(await this.apiRequest(`/v1/threads/${encodeURIComponent(threadId)}/messages?${params}`, signal));
    // The bound is exclusive, so every row of the window has to be strictly older than it.
    assertDatedChronologicalRows(parsed.messages);
    assertStrictlyOlderThan(parsed.messages, beforeUnixMs);
    return parsed;
  }

  private async apiRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // The service credential authenticates Musebridge to its own transport service.
        // It travels only to the fixed configured destination, and a deployment without
        // one sends no authorization header at all.
        ...(this.serviceToken === undefined ? {} : { Authorization: `Bearer ${this.serviceToken}` })
      },
      // Manual redirects: the Meta-host rule constrains every destination Musebridge
      // contacts, not just the configured base URL. A transport that answers with a
      // redirect to Meta or any other host is refused as a failure below instead of
      // being followed. That also keeps the service credential from reaching another
      // host.
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
