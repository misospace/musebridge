import { z } from 'zod';
import { PROVIDER_SESSION_ASSESSMENTS } from './browser.js';

export const SCHEMA_VERSION = '1.4.0';
export const SERVICE_VERSION = '0.1.0'; // x-release-please-version
export const MAX_QUERY_LENGTH = 256;
export const MAX_LOCATION_LENGTH = 256;
export const MAX_LISTING_ID_LENGTH = 128;
export const MAX_THREAD_ID_LENGTH = 128;
export const MAX_BACKEND_NAME_LENGTH = 64;
export const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 256;
export const MAX_PROVIDER_ACTION_LENGTH = 128;

export const PROVIDER_ERROR_CODES = [
  'AUTH_EXPIRED',
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'SESSION_INVALID',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'TIMEOUT'
] as const;

export const backendNameSchema = z.string().min(1).max(MAX_BACKEND_NAME_LENGTH).regex(/\S/);

const httpUrlSchema = z.string().max(2048).url().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s/@]+(?:[/?#][^\s]*)?$/).meta({ format: 'uri' }).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Must be an HTTP(S) URL');

const isoDateTimeSchema = z.string().datetime({ offset: true });
const threadIdSchema = z.string().trim().min(1).max(MAX_THREAD_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const listingIdSchema = z.string().min(1).max(MAX_LISTING_ID_LENGTH);

export const sellerSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  url: httpUrlSchema.optional()
}).strict();

export const listingSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH),
  url: httpUrlSchema,
  title: z.string().min(1).max(256),
  price: z.number().finite().nonnegative().nullable(),
  currency: z.string().min(1).max(3),
  location: z.string().min(1).max(MAX_LOCATION_LENGTH),
  posted_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
  description: z.string().max(280),
  images: z.array(httpUrlSchema).max(6),
  seller: sellerSchema.nullable(),
  state: z.enum(['active', 'sold', 'pending', 'removed', 'unknown'])
}).strict();

export type Listing = z.infer<typeof listingSchema>;

const conversationThreadIdSchema = threadIdSchema;

export const conversationThreadSchema = z.object({
  thread_id: conversationThreadIdSchema,
  participants: z.array(z.string().min(1).max(128)).max(8).optional(),
  preview: z.string().min(1).max(280).optional(),
  item_id: listingIdSchema.optional()
}).strict();

export const conversationMessageSchema = z.object({
  sender: z.enum(['you', 'other']).optional(),
  sender_name: z.string().min(1).max(128).optional(),
  text: z.string().min(1).max(2000),
  sent_at: isoDateTimeSchema.optional()
}).strict();

export type ConversationThread = z.infer<typeof conversationThreadSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationThreadMessages = { thread_id: string; messages: ConversationMessage[] };

// Cross-site shopping contract (#48). `productOffer` is a sibling of `listing`, not a
// replacement: Facebook tools keep the deployed `listing` contract, and a later comparison
// layer unions the two. Facts only — deal scoring stays consumer-side.
export const productConditionSchema = z.enum(['new', 'used', 'refurbished', 'unknown']);
export const productAvailabilitySchema = z.enum(['in_stock', 'out_of_stock', 'preorder', 'unknown']);
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 currency code');

export const productOfferSchema = z.object({
  provider: z.literal('ebay'),
  id: listingIdSchema,
  product_id: listingIdSchema.nullable(),
  url: httpUrlSchema,
  title: z.string().min(1).max(256),
  price: z.number().finite().nonnegative().nullable(),
  currency: currencyCodeSchema,
  condition: productConditionSchema,
  availability: productAvailabilitySchema,
  shipping_cost: z.number().finite().nonnegative().nullable(),
  shipping_currency: currencyCodeSchema.nullable(),
  location: z.string().max(MAX_LOCATION_LENGTH).nullable(),
  seller: sellerSchema.nullable(),
  posted_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
  images: z.array(httpUrlSchema).max(6),
  state: z.enum(['active', 'sold', 'pending', 'removed', 'unknown'])
}).strict();

export type ProductOffer = z.infer<typeof productOfferSchema>;

export const shoppingSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).regex(/\S/),
  min_price: z.number().finite().nonnegative().optional(),
  max_price: z.number().finite().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).default(10)
}).strict().refine((input) => {
  return input.min_price === undefined || input.max_price === undefined || input.min_price <= input.max_price;
}, { message: 'min_price must be less than or equal to max_price', path: ['max_price'] });

export const shoppingFetchInputSchema = z.object({
  // A legacy item id, or eBay's RESTful item id (v1|legacy|variation) exactly as Browse
  // search returns it — the only form that addresses a specific variation.
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH).regex(/^(?:v1\|[A-Za-z0-9][A-Za-z0-9._-]{0,60}\|[A-Za-z0-9][A-Za-z0-9._-]{0,60}|[A-Za-z0-9][A-Za-z0-9._-]*)$/).optional(),
  url: httpUrlSchema.optional()
}).strict().refine((input) => Number(input.id !== undefined) + Number(input.url !== undefined) === 1, {
  message: 'Provide exactly one of id or url'
});

export type ShoppingSearchInput = z.infer<typeof shoppingSearchInputSchema>;
export type ShoppingFetchInput = z.infer<typeof shoppingFetchInputSchema>;

export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).regex(/\S/),
  location: z.string().trim().min(1).max(MAX_LOCATION_LENGTH).regex(/\S/),
  min_price: z.number().finite().nonnegative().optional(),
  max_price: z.number().finite().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).default(5)
}).strict().refine((input) => {
  return input.min_price === undefined || input.max_price === undefined || input.min_price <= input.max_price;
}, { message: 'min_price must be less than or equal to max_price', path: ['max_price'] });

export const fetchInputSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  url: httpUrlSchema.optional()
}).strict().refine((input) => Number(input.id !== undefined) + Number(input.url !== undefined) === 1, {
  message: 'Provide exactly one of id or url'
});

export const statusInputSchema = z.object({}).strict();

export const threadsListInputSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10)
}).strict();

export const threadReadInputSchema = z.object({
  thread_id: conversationThreadIdSchema
}).strict();

export type ThreadsListInput = z.infer<typeof threadsListInputSchema>;
export type ThreadReadInput = z.infer<typeof threadReadInputSchema>;

// Shared outbound shapes so a prepared draft and a sent message can never drift apart.
const outboundMessageSchema = z.string().min(1).max(2000).regex(/^[^\u0000-\u001F\u007F]+$/, 'message must not contain control characters');
const idempotencyTokenSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);

// Messenger send contract (#63). The idempotency token is embedded in the sent message so a
// timed-out send can be reconciled against the thread before any retry (never resent blindly).
export const threadSendInputSchema = z.object({
  thread_id: conversationThreadIdSchema,
  message: outboundMessageSchema,
  idempotency_token: idempotencyTokenSchema
}).strict();

export type ThreadSendInput = z.infer<typeof threadSendInputSchema>;

// Messenger prepare contract (#62). The tool mints the idempotency token first, builds and
// validates the complete send payload, and only then digests that payload, so the published
// subject_digest is exactly what a later messenger_send authorization is checked against. It
// sends nothing and grants no approval.
export const threadPrepareInputSchema = z.object({
  thread_id: conversationThreadIdSchema,
  message: outboundMessageSchema
}).strict();

export type ThreadPrepareInput = z.infer<typeof threadPrepareInputSchema>;

/** Conversation-scoped draft context for a proposed send: the counterparty the draft would address,
 * or null when no counterparty name is attributed. Deliberately carries no thread id — the send
 * target is the caller's validated input, so a backend can never redirect a prepared send. */
export interface ConversationDraft {
  readonly participant: string | null;
}

export const runtimeErrorCodeSchema = z.enum([
  ...PROVIDER_ERROR_CODES,
  'NOT_FOUND',
  'INTERNAL_ERROR',
  'APPROVAL_REQUIRED',
  'ACTION_FORBIDDEN',
  'SURFACE_DISABLED'
]);

export const providerErrorMetadataSchema = z.object({
  action_required: z.string().min(1).max(MAX_PROVIDER_ACTION_LENGTH).optional(),
  login_url: httpUrlSchema.optional(),
  retry_after: z.number().int().nonnegative().optional(),
  // True only when a send was interrupted after its submit (Enter) was dispatched, so the
  // caller cannot categorically report the message as unsent.
  submit_triggered: z.boolean().optional()
}).strict();

export const providerErrorSchema = z.object({
  code: z.enum(PROVIDER_ERROR_CODES),
  message: z.string().min(1).max(MAX_PROVIDER_ERROR_MESSAGE_LENGTH),
  ...providerErrorMetadataSchema.shape
}).strict();

const runtimeErrorSchema = z.object({
  code: runtimeErrorCodeSchema,
  message: z.string().min(1).max(MAX_PROVIDER_ERROR_MESSAGE_LENGTH),
  ...providerErrorMetadataSchema.shape
}).strict();

export const runtimeFailureSchema = z.object({
  ok: z.literal(false),
  error: runtimeErrorSchema
}).strict();

export const searchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  listings: z.array(listingSchema).max(20)
}).strict();

export const fetchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  listing: listingSchema
}).strict();

export const facebookSessionSchema = z.object({
  status: z.enum(PROVIDER_SESSION_ASSESSMENTS)
}).strict();

export const capabilitySchema = z.object({
  surface: z.enum(['marketplace', 'shopping', 'messenger', 'events']),
  provider: z.enum(['facebook', 'ebay', 'ticketmaster']),
  backend: backendNameSchema.nullable()
}).strict();

export const statusSuccessSchema = z.object({
  ok: z.literal(true),
  service_version: z.literal(SERVICE_VERSION),
  schema_version: z.literal(SCHEMA_VERSION),
  backend: backendNameSchema,
  facebook_session: facebookSessionSchema.optional(),
  shopping_backend: backendNameSchema.optional(),
  events_backend: backendNameSchema.optional(),
  capabilities: z.array(capabilitySchema).min(1)
}).strict();

export const searchOutputSchema = z.union([searchSuccessSchema, runtimeFailureSchema]);
export const fetchOutputSchema = z.union([fetchSuccessSchema, runtimeFailureSchema]);

export const shoppingSearchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  offers: z.array(productOfferSchema).max(20)
}).strict();

export const shoppingFetchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  offer: productOfferSchema
}).strict();

export const shoppingSearchOutputSchema = z.union([shoppingSearchSuccessSchema, runtimeFailureSchema]);
export const shoppingFetchOutputSchema = z.union([shoppingFetchSuccessSchema, runtimeFailureSchema]);

// Cross-site events availability surface (#50). Read-only, sibling to `productOffer`: the
// Discovery API reports event-level on-sale status and price ranges only, never seat-level
// inventory, so `sold_out` is deliberately not produced by the live provider.
export const eventStatusSchema = z.enum(['on_sale', 'off_sale', 'sold_out', 'cancelled', 'postponed', 'rescheduled', 'unknown']);

export const eventAvailabilitySchema = z.object({
  provider: z.literal('ticketmaster'),
  id: listingIdSchema,
  url: httpUrlSchema,
  name: z.string().min(1).max(256),
  starts_at: isoDateTimeSchema.nullable(),
  timezone: z.string().min(1).max(64).nullable(),
  status: eventStatusSchema,
  price_min: z.number().finite().nonnegative().nullable(),
  price_max: z.number().finite().nonnegative().nullable(),
  currency: currencyCodeSchema.nullable(),
  venue: z.string().min(1).max(256).nullable(),
  location: z.string().max(MAX_LOCATION_LENGTH).nullable(),
  on_sale_start: isoDateTimeSchema.nullable(),
  on_sale_end: isoDateTimeSchema.nullable(),
  classifications: z.array(z.string().min(1).max(64)).max(6),
  images: z.array(httpUrlSchema).max(6)
}).strict();

export type EventAvailability = z.infer<typeof eventAvailabilitySchema>;

export const eventsSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).regex(/\S/),
  city: z.string().trim().min(1).max(MAX_LOCATION_LENGTH).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date').optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date').optional(),
  limit: z.number().int().min(1).max(20).default(10)
}).strict().refine((input) => input.start_date === undefined || input.end_date === undefined || input.start_date <= input.end_date, { message: 'start_date must be on or before end_date', path: ['end_date'] });

export const eventsFetchInputSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  url: httpUrlSchema.optional()
}).strict().refine((input) => Number(input.id !== undefined) + Number(input.url !== undefined) === 1, { message: 'Provide exactly one of id or url' });

export type EventsSearchInput = z.infer<typeof eventsSearchInputSchema>;
export type EventsFetchInput = z.infer<typeof eventsFetchInputSchema>;

export const eventsSearchSuccessSchema = z.object({ ok: z.literal(true), backend: backendNameSchema, events: z.array(eventAvailabilitySchema).max(20) }).strict();
export const eventsFetchSuccessSchema = z.object({ ok: z.literal(true), backend: backendNameSchema, event: eventAvailabilitySchema }).strict();
export const eventsSearchOutputSchema = z.union([eventsSearchSuccessSchema, runtimeFailureSchema]);
export const eventsFetchOutputSchema = z.union([eventsFetchSuccessSchema, runtimeFailureSchema]);

export const statusOutputSchema = statusSuccessSchema;
export const threadsListOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    backend: backendNameSchema,
    threads: z.array(conversationThreadSchema).max(20)
  }).strict(),
  runtimeFailureSchema
]);
export const threadReadOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    backend: backendNameSchema,
    thread_id: conversationThreadIdSchema,
    messages: z.array(conversationMessageSchema).max(50)
  }).strict(),
  runtimeFailureSchema
]);

// 'sent' means delivered or reconciled-confirmed; 'unknown' means the outcome was never
// confirmed after a timeout. Unconfirmed sends are reported as unknown, not as failure
// or success (provider-action-boundaries: timeout and resend semantics).
export const sendDeliveryStatusSchema = z.enum(['sent', 'unknown']);

export const sendSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  thread_id: conversationThreadIdSchema,
  status: sendDeliveryStatusSchema
}).strict();

export const sendOutputSchema = z.union([sendSuccessSchema, runtimeFailureSchema]);

// Prepared draft envelope (#62). `status: 'draft'` and `sent: false` are literals so no consumer
// can read a prepared draft as a delivery or an authorization; `send_input` is the exact object a
// later messenger_send will be authorized against, and `subject_digest` its digest. `rendered_message`
// is bounded at 2131 — a 2000-character message plus one space, the opening bracket, a 128-character
// token, and the closing bracket.
export const prepareDraftCounterpartyMarkerSchema = z.object({
  included: z.literal(true),
  token: idempotencyTokenSchema,
  // Exactly one bracketed marker, so a later reconciliation can never match an ambiguous text.
  occurrences: z.literal(1),
  disclosure: z.string().min(1).max(320)
}).strict();

export const prepareSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  thread_id: conversationThreadIdSchema,
  status: z.literal('draft'),
  sent: z.literal(false),
  participant: z.string().min(1).max(128).nullable(),
  draft_message: outboundMessageSchema,
  rendered_message: z.string().min(1).max(2131),
  counterparty_marker: prepareDraftCounterpartyMarkerSchema,
  idempotency_token: idempotencyTokenSchema,
  send_input: threadSendInputSchema,
  subject_digest: z.string().regex(/^[0-9a-f]{64}$/, 'subject_digest must be a lowercase sha-256 hex digest')
}).strict();

export const prepareOutputSchema = z.union([prepareSuccessSchema, runtimeFailureSchema]);
export type RuntimeFailure = z.infer<typeof runtimeFailureSchema>;
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];
export type ProviderErrorMetadata = z.infer<typeof providerErrorMetadataSchema>;
