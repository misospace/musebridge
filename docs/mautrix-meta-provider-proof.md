# mautrix-meta provider proof — boundary, license shape, and session contract (#195)

Parent decision record: [`mautrix-meta-transport-evaluation.md`](mautrix-meta-transport-evaluation.md) (#193). This document is the implementation proof for #195: the narrowest useful, synthetic-first `mautrix-meta` provider. It builds no Go code, adds no dependency, makes no Meta request, and registers no write tool. Every claim about what the proof does is backed by the tests listed in §7; every claim about what the transport service must do is a contract the fork service has to satisfy before any live use.

## 1. What shipped

- A read-only provider boundary type, `MautrixMetaBackend` (`services/marketplace/src/backend.ts`): thread listing, tail read, and older-window backfill. It is deliberately **not** an extension of `ConversationBackend` — sharing that type would inherit `prepareDraft`/`sendThread`. No write method exists on the boundary, and write-class tools can only declare requirements against `ConversationBackend` methods, so no Messenger write can be served through this provider without widening a reviewed type first.
- An HTTP client for the isolated transport service (`services/marketplace/src/mautrix-meta.ts`) and the Musebridge-side backend (`services/marketplace/src/mautrix-meta-backend.ts`). The client is GET-only and refuses Meta-owned destinations (§4).
- Three read tools (`services/marketplace/src/tools.ts`), scope `(facebook, default, messenger_meta)`, risk class `read`: `messenger_meta_threads_list`, `messenger_meta_thread_read`, `messenger_meta_thread_backfill`. Each is registered only while its boundary method is wired (the same `requires`-on-the-entry gate as the consumer tools).
- A synthetic fixture backend (`services/marketplace/src/mautrix-meta-fixtures.ts`) that holds each synthetic thread's whole history, so coverage claims in tests are decidable from the data rather than asserted flags.
- Startup wiring in `services/marketplace/src/service.ts` (§3) and a `marketplace_status` report (§6).

## 2. AGPL-compliant shape (documented before any upstream code)

`mautrix-meta` is AGPL-3.0 and Musebridge holds neither the Beeper nor the Element exception (evaluation §7). The chosen shape is evaluation §7 **option 3**:

- The `mautrix-meta` fork (the `bridgev2` shim from evaluation §2 plus a small read-only host API) is a **separate published service under AGPL-3.0**, deployed by the operator. It is where all AGPL-derived code lives.
- Musebridge contains **no code from the upstream project** — nothing vendored, copied, generated, or linked. What ships here is an independent HTTP client over a documented boundary, so Musebridge stays license-neutral, exactly like its existing eBay/Ticketmaster/Threads HTTP connectors.
- The fork must publish its complete corresponding source (AGPL §13) to everyone who interacts with it over a network. Because the fork's host API is operator-facing only, the practical obligation is publishing the fork repository itself.
- If the boundary ever needs a change, the change happens in the fork and its published source, never by pulling Go code into this repository.

This repository-wide rule follows from the shape: no file under `services/marketplace/` may import, embed, or translate upstream `mautrix-meta` sources. A reviewer can check it by searching for Go files or upstream identifiers — there are none.

## 3. Provider selection and the risk-acknowledgement gate

Two environment variables, both required, checked in order (mirroring the live-Threads gate):

1. `MESSENGER_TRANSPORT=mautrix-meta` — explicit provider selection. Unset or `browser` keeps the shipped browser-backed path; **the default configuration starts nothing for this transport** (no client, no tools, no connection). An invalid value is a startup `RangeError`.
2. `MAUTRIX_META_RISK_ACK=1` — explicit operator acknowledgement that this transport presents Meta with an unofficial client carrying account risk (evaluation §6). Only the literal `1` acknowledges. Missing acknowledgement is a startup `RangeError` naming the variable, and it is checked **before** the base URL so a half-configured deployment learns the risk gate first.

Additional rules:

- `MAUTRIX_META_BASE_URL` (required with the selection) is the operator's own transport service. There is no default destination (§4).
- One Messenger transport per account: selecting `mautrix-meta` while the browser messenger scope would start (`MARKETPLACE_BACKEND=facebook` + `MARKETPLACE_MESSENGER=1`) is a startup `RangeError`. Two concurrent Messenger clients on one account multiply request volume against the same session — the exact risk the acknowledgement is scoped to.
- The browser path stays the default and the fallback: unset `MESSENGER_TRANSPORT` (or the experimental transport being down) leaves the browser Messenger scope and its tools exactly as shipped; a broken transport fails its own tools with typed errors and never touches the browser session.

## 4. The boundary API (the contract the fork service must expose)

All requests are `GET` with `Accept: application/json`; there is no write route on the contract at all. Message content crosses the boundary in memory only.

| Route | Response |
| --- | --- |
| `GET /v1/threads?limit=N` | `{ threads: ConversationThread[], truncated: boolean }` |
| `GET /v1/threads/{thread_id}/messages` | `{ messages: ConversationMessage[], coverage: { window: 'tail', scanned_rows, truncated } }` |
| `GET /v1/threads/{thread_id}/messages?before=<unix-ms>&limit=N` | `{ messages: ConversationMessage[], coverage: { window: 'backfill', scanned_rows, has_more_before } }` |

Failures carry a typed body `{ "error": { "code", "message", "retry_after"? } }` with `code` from: `login_required`, `auth_expired`, `session_invalid`, `challenge_required`, `checkpoint_required`, `captcha_required`, `rate_limited`, `thread_not_found`, `upstream_error`. Musebridge maps each to the repo's `ProviderError` with **static text** (provider body text never reaches tool output or logs): `login_required`→`LOGIN_REQUIRED`, `auth_expired`→`AUTH_EXPIRED`, `session_invalid`→`SESSION_INVALID`, the challenge family→`CAPTCHA_REQUIRED` with `action_required: 'manual_resolution_in_official_app'`, `rate_limited`→`RATE_LIMITED` (+`retry_after`, from the body or a normalized `Retry-After` header even when the body is unclassifiable), `thread_not_found` at HTTP 404→absence (`NOT_FOUND`) — the same label on any other status is a provider failure, not an absence — everything else→`UPSTREAM_ERROR`. An unclassifiable body falls back by status (401/403/429). A success body that fails wire validation is drift: typed `UPSTREAM_ERROR`, never an empty success. Requests use `redirect: 'manual'`: a transport that answers with a redirect is a failure, and Musebridge never follows a reply toward Meta or any other host.

Coverage truthfulness (issue rule "preserve explicit coverage/backfill semantics rather than implying complete history"):

- `before` is exclusive and echoes back from the request — the wire cannot forge it; the provider never composes `truncated`.
- `has_more_before` is the provider's own range disclosure (the pinned paging exposes exactly this signal). The caller-facing `truncated` is composed as `has_more_before || rows dropped by the cap`, so an unexhausted range is never reported as a complete window, and `false` appears only on a proven-exhausted range that the cap left untouched.
- `thread_not_found` yields `NOT_FOUND`; it is never reported as an empty-but-complete window.

Destination rules: `MAUTRIX_META_BASE_URL` must be an http(s) URL with no userinfo, query, or fragment; **Meta-owned hosts (`facebook.com`, `messenger.com`, `meta.com` and their subdomains) are refused** so a misconfiguration cannot turn Musebridge into a direct unofficial-API client (lookalike suffixes like `facebook.com.evil.example` are unrelated hosts and stay valid). Non-loopback destinations must use https. Loopback is the normal sidecar shape. The request carries no Musebridge-side credential, so there is no secret to exfiltrate.

## 5. Native login, session, and E2EE state contract

Native login stays inside the transport service; Musebridge never sees a password, cookie, token, or key (evaluation §5/§9):

- **Login mode:** native Messenger login only (`messenger-lite` / `messenger-lite-android` in the pinned source). The cookie flows are excluded — their login step asks for cookies copied out of a browser, which is the credential export the boundary forbids.
- **MFA/challenge:** typed login steps presented to a human operator inside the transport service's own console. Musebridge automates nothing; outside login, blockers cross the boundary only as the typed challenge errors above, whose text sends the operator to the official app.
- **Session material (owned and persisted by the transport service, handled like credentials — never logged, returned, or exported):** the login-minted session (Android native session fields, or the iOS flow's web session), the messagix `DumpState`/`LoadState` blob (per-sync-group cursors, treated as stale after the pinned 24 h `MaxCachedStateAge`), and the E2EE/secure-history device state (storage key pair, mailbox root key, OCMF client state, epoch root keys, plus the whatsmeow device store).
- **Musebridge persists nothing.** No message-content index, no cursors, no session or key material — the transport scope needs no profile directory analogous to `MESSENGER_PROFILE_DIR` because the state belongs to the fork service, and Musebridge keeps none. The session shape inside the fork (long-lived vs per-request) is the fork's explicit choice and must be recorded in the fork's README when it ships; the boundary API above is unchanged by that choice.
- **E2EE:** honest history needs the secure-history pipeline in the fork. Until a thread's E2EE state is registered there, reads of that thread must fail closed as typed errors — never silently report missing history as complete.
- **Invalidation:** the pinned transport detects session death loudly and never refreshes tokens automatically; `SESSION_INVALID`/`AUTH_EXPIRED` therefore instruct the operator to re-run the native login in the transport service.

## 6. Status and discovery

`marketplace_status` (schema `1.11.0`, additive) reports `messenger_transport: 'browser' | 'mautrix-meta'` and a `capabilities` row `{ surface: 'messenger_meta', provider: 'facebook', backend }`, with `backend: null` whenever the transport is not wired — the disabled-by-default state is observable without probing.

## 7. Synthetic-first proof and done-when mapping

No test contacts the network; every transport response in tests is a synthetic fixture. Live validation stays behind a separate, explicit operator step (§8).

| Done-when (issue #195) | Evidence |
| --- | --- |
| Default configuration starts no mautrix-meta transport | `tests/mautrix-meta-gate.test.ts` (default service; ack-without-selection); `tests/service.test.ts` status reports `messenger_transport: 'browser'` and a null `messenger_meta` backend |
| Cannot start without both selection and acknowledgement (in order) | `tests/mautrix-meta-gate.test.ts` gate suite incl. gate-order case |
| Native-login/session/E2EE state contract documented | this document §5 |
| Read-only thread/history/backfill over synthetic fixtures with truthful coverage | `tests/mautrix-meta-client.test.ts`, `tests/mautrix-meta-backend.test.ts` (has_more_before, cap-drop truncation, exclusive `before`, exhaustion), `tests/messenger-meta-tools.test.ts` |
| No Messenger write tools through this provider | `tests/messenger-meta-tools.test.ts` (risk classes + scope; send/prepare stay gated on `ConversationBackend`), `tests/mautrix-meta-backend.test.ts` (no write methods present), registry gate in `tests/tools-registry.test.ts` |
| Message content not persisted by Musebridge | no persistence code path exists: client/backend/fixture modules contain no filesystem or storage writes; `mautrix-meta.ts` §"Boundary rules" comment carries the invariant |
| AGPL/service boundary documented | this document §2/§4 |
| Live validation behind an operator gate | §8; the transport refuses to start without `MAUTRIX_META_RISK_ACK=1` |

## 8. Live validation (not part of this proof)

Any live-account validation is a separate operator-controlled step after this synthetic proof is reviewed: publish/deploy the AGPL fork, complete a native login in its console, point `MAUTRIX_META_BASE_URL` at it, set `MAUTRIX_META_RISK_ACK=1`, then walk a live checklist (session states, challenge text routing to the official app, coverage honesty against a known thread). Nothing in this repository performs or schedules any of that.

## 9. Cross-links

[`mautrix-meta-transport-evaluation.md`](mautrix-meta-transport-evaluation.md) (decision record, pinned revisions, §2 shim, §5 state layers, §7 license options) · [`messenger-consumer-research.md`](messenger-consumer-research.md) (§2 default boundary policy) · [`provider-action-boundaries.md`](provider-action-boundaries.md) (risk classes) · [`../services/marketplace/README.md`](../services/marketplace/README.md) (operator configuration) · issue #195.
