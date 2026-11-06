# Conversation surface research (#43 step 1)

Findings behind the read-only conversation capabilities (`messenger_threads_list`, `messenger_thread_read`). This document separates **verified** facts (public documentation, this repository's own behavior) from **assumed** contracts (written from research but not yet validated against the live Facebook surface), and states the validation plan. It complements `provider-action-boundaries.md`, which remains the normative enforcement contract. The consolidated cross-capability inventory and integration-path decision record is [`capability-inventory.md`](capability-inventory.md) (#39); this document remains authoritative for the conversation surface and its live-DOM validation status.

## What Marketplace conversations are

Marketplace buyer↔seller chats are **Messenger conversations**, not a separate messaging system. Facebook's own help documentation states that Marketplace messages appear in the Marketplace **Inbox** (with *Buying* / *Selling* views, optionally grouped by listing) and that "you can also see your messages with buyers and sellers on Messenger" ([View your Facebook Marketplace messages](https://www.facebook.com/help/347147066002616)). There is one conversation store; the Marketplace inbox is a filtered view of it.

Consequences for session isolation:

- The conversation surfaces are served by `www.facebook.com` itself (`/marketplace/inbox/`, `/messages/t/...`); no separate `messenger.com` login is needed. A session authenticated on facebook.com can reach both.
- Isolation is nevertheless enforced at the **scope** level, not the cookie level: per `provider-action-boundaries.md`, the `messenger` surface gets its own session assessment, its own browser profile directory (`MESSENGER_PROFILE_DIR`, default `~/.marketplace/browser-profile-messenger`), and its own credential-login instance. A Marketplace session grants nothing on Messenger by declaration, and vice versa — even though both profiles would hold facebook.com cookies for the same identity.

## Access paths evaluated

| Path | Verdict | Basis |
|---|---|---|
| Graph API / Conversations API | **Not available** | The Messenger Platform Conversations API is business/Page-scoped: it requires `pages_messaging`, `pages_manage_metadata` etc. and addresses Page↔user (PSID) threads. There is no public API for personal Marketplace buyer↔seller chats. |
| `messenger.com` standalone | Rejected for now | Adds a second origin and login flow for no capability gain; the same threads are reachable on `www.facebook.com/messages`. Revisit only if the facebook.com surfaces prove unusable. |
| `www.facebook.com` browser session | **Selected** | Same approach as marketplace search/fetch: navigate a real persistent-profile session and extract from accessibility-contract signals. |

## Page structure (research findings)

The inbox assumptions below are historical: authenticated inspection on October 8 found conversation buttons without thread links, and #64 / PR #81 added passive, validated inbox GraphQL key discovery. That fix does not establish thread-page URL semantics or message structure. Thread navigation and extraction remain subject to the consent-controlled [#77 live-validation protocol](messenger-live-validation.md).

October 11 consented inspection of one operator-selected conversation found a same-origin **Open in Messenger** menu link; its key reached the expected `/messages/t/<thread>/` route. The canonical page rendered messages as unlabeled `role="article"` containers inside a `role="log"`, with no message-log role rows or `time[datetime]` elements. The current sender-label extractor remains unsupported on this observed layout and must fail closed. This is structural evidence from the operator browser, not validation of the isolated production backend or delivery confirmation. Canonical and encrypted routes also matched the loaded provider message-control metadata in memory. The updated extractor returned zero attributed messages on the actual page, and the parser explicitly rejects article logs. The deployed read tool refused at its authentication boundary. Full sanitized findings and the remaining production limitations are in the protocol; closing #77 records this negative validation, not successful extraction or send enablement.

- **Thread identification** happens on the Marketplace inbox page (`/marketplace/inbox/` — the *Buying* view is the buyer-side filter; the exact query parameter for the tab filter is **unverified**). Threads are links to Messenger threads; the anchor href shape `/{origin}/messages/t/{threadId}/` is the long-standing Messenger thread URL pattern (**assumed** — widely documented historically, not re-verified against the current site).
- **Message reading** happens on the thread page (`/messages/t/{threadId}/`). Message content is rendered in the modern www Messenger UI, which is heavily obfuscated and virtualized (**verified risk** — no public stable DOM map exists; community scrapers report frequent breakage).
- The inbox view may group or label threads by listing; whether item context is directly attached to thread anchors on the current site is **unverified**.

## The extraction contract and why it is shaped this way

Because the DOM contract cannot be validated from this repository (synthetic identities only; tests never touch real accounts), the extractors follow the strictest defensible rules:

1. **Accessibility-contract signals only** — anchors with `/messages/t/{id}` hrefs, `role="row"` message rows, `aria-label` orientation patterns (`You said: …` / `{Name} said: …`), `time[datetime]` timestamps. Never CSS classes, never obfuscated internals.
2. **Fail closed on the unknown** — an authenticated page that shows neither recognizable threads/messages nor a recognized empty state is a typed `UPSTREAM_ERROR` ("layout was not recognized"), never an empty success. A false "no conversations" is worse than an error.
3. **No fabricated fields** — participant names are *not* extracted by the Facebook backend this wave (attribution heuristics would be guesses); the fixture backend provides them synthetically. Message rows without a recognizable orientation marker are skipped, not attributed. Seller identity is established by following `item_id` through `marketplace_fetch`, and by Miso's own reasoning — Musebridge extracts, Miso interprets.
4. **Opaque thread ids** — `thread_id` is an opaque token matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` parsed only from extracted hrefs. `messenger_thread_read` rebuilds the thread URL from the configured base origin; caller-supplied URLs are never navigated (same rule as `marketplace_fetch`).

## Verified vs assumed — validation plan

**Verified** (public documentation / this repo's tests):
- No public API for Marketplace buyer↔seller chats; Graph API is Page-scoped.
- Marketplace messages live in Messenger; the Marketplace Inbox offers Buying/Selling views.
- The session-isolation machinery: separate profile directories, per-surface probe classification, per-backend single-in-flight credential login — all covered by the test suite against synthetic servers.

**Assumed, pending operator validation against the live site** (one session, manual, read-only):
1. `/marketplace/inbox/` renders thread anchors with `/messages/t/{id}` hrefs when logged in.
2. Thread anchors expose usable preview text, and (sometimes) an attached `/marketplace/item/{id}` link.
3. Thread pages expose `role="row"` elements with the `You said:` / `{Name} said:` aria-label patterns.
4. The Buying/Selling tab filter (query parameter or click target) — currently the extractor reads whatever the inbox page renders, without selecting a tab.
5. Whether `/messages/t/{id}` addresses are stable or Facebook canonicalizes them — the redirect guard makes any mismatch loud (`UPSTREAM_ERROR`) rather than attributing the wrong conversation, but the operator should record what actually happens.

**If validation fails:** the extractors fail closed with typed errors, so a wrong assumption degrades to a loud `UPSTREAM_ERROR`, not wrong data. Corrections then land as extractor/fixture updates with the same fail-closed discipline. Until validation passes, these tools should be treated as *contract-shaped but unproven against production* — suitable for Miso integration testing against the fixture backend.

## Untrusted content

Thread previews and message texts are seller-controlled content. They are returned verbatim (bounded) as tool output; Miso owns interpretation and must treat them as untrusted input — prompt-injection handling is a consumer-side responsibility for reads, and becomes a Musebridge-enforced concern at the send step (#43 step 3), where the approved payload digest binds exactly what will be sent.

## Provider-visible side effects of reads

Opening a thread page may mark it **"Seen"** for the other participant, and the visit may surface presence. The exact receipt behavior has not been observed in the controlled #77 investigation. Do not promise a side-effect-free browser read; disclose this risk and obtain explicit operator consent before live validation opens a thread. The send step's delivery reconciliation also reads threads. This is a **named exception** to the `read` class's "no external side effect" definition, scoped to provider-side bookkeeping intrinsic to reading the caller's own data, and recorded in the boundary contract and tool description. `messenger_threads_list` opens no threads. A redirect guard rejects attribution from an unexpected address; it cannot prevent a receipt emitted by navigation to the redirected conversation. See the [#77 protocol](messenger-live-validation.md) for identity checks and evidence limits.

## Deliberate gaps this wave

- **No interactive re-auth for the messenger scope.** The marketplace scope's loopback re-auth console owns its profile; wiring a second lease target is deferred to the send step, where the messenger surface first carries real write intent. Until then, a captcha/checkpoint on the messenger profile surfaces as `CAPTCHA_REQUIRED` / `SESSION_INVALID` and requires manual profile recovery.
- **No status surface for the messenger assessment.** There is no `messenger_status` tool; the messenger scope's session state is observable only through the conversation tools' typed failures (`LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, timeouts). A status tool can be added cheaply if operators need proactive visibility.
- **No Buying/Selling tab selection.** Threads are read from the inbox page as rendered.
- **No pagination/scrolling** — one page, bounded extraction, mirroring search.

## Inbox pagination fail-closed classification (#204, 2026-11-06)

**Observed (deployed, reported in #204):** the Messenger profile reached a verified authenticated state (`messenger_session: session_usable`, classification `messages_authenticated`, no CAPTCHA/checkpoint/login signals), yet one bounded read-only `messenger_threads_list(limit=20)` call returned the typed refusal `UPSTREAM_ERROR` — "The Facebook Marketplace inbox pagination could not be verified; a complete thread list cannot be returned." — with no thread ids, fast.

**Classification: the refusal is correct for the observed evidence, and the evidence is genuinely insufficient to name one cause.** That message is produced by exactly one contract branch (`facebook-messenger-parse.ts`, `interpretMessengerInboxPage`): the collector's snapshot reported `incomplete` with `malformed` false (`facebook-messenger-inbox-graphql.ts`, `snapshot` — `incomplete = recognized && (!chain.complete || unverifiedPage || responseLimitExceeded || malformed)`). Reaching it requires the collector to have observed inbox-relevant GraphQL traffic (`recognized` true — with nothing observed the read would fall back to DOM anchors or report an unrecognized layout instead), so the deployed run saw inbox requests/responses whose pagination evidence did not verify. Four sanitized structural conditions can each produce exactly this outcome, and the observed evidence — one typed refusal, no ids — cannot distinguish them:

| Condition | Where it fails closed | Candidate deployed shape |
|---|---|---|
| `unverified_page` | a page of evidence could not be linked into the cursor chain | a connection with no recognized terminal `page_info` (single page without terminal marker, `parsePageInfo` returning no `pageInfo`); an initial request not identifiable as the container page request (unreadable body, unknown friendly name, unusable cursor); a payload that does not match the verified `data.viewer.marketplaceInboxBuyerMessageThreads` connection shape (error envelope, preloader-style wrapper) on a verified request; a non-JSON or unreadable response body |
| `incomplete_chain` | recorded pages never reached a terminal page | a first page carrying `has_next_page: true` whose continuation request/response was never observed inside the bounded read window (unexpected page count for the window) |
| `response_limit` | the bounded read stopped before every observed response was read | more recognized inbox responses in the window than the read limit (60) |
| `malformed_connection` | an observed connection could not be parsed | edges/node shapes that fail the verified thread-key contract (this one would have produced the "could not be parsed" message instead, so it is excluded by the observed wording) |

A settle-loop early stop **cannot** cause this outcome: the settle loop only re-polls the DOM extraction, while the response listener spans navigation through settle end and the flush bounds pending body reads (`facebook-messenger-backend.ts`, `listThreads`); a window with no observed GraphQL at all would leave `recognized` false and produce a different outcome (DOM fallback or unrecognized-layout error), not this refusal.

**Why no contract loosening was made:** the collector already verifies a legitimate single-page inbox truthfully when the connection carries an explicit terminal marker (`page_info.has_next_page: false` with the observed initial page request) — pinned by regression tests. The only single-page shape the collector refuses is a connection with **no** usable terminal marker, and accepting that would violate the #97 contract (missing/ambiguous page evidence must fail closed) with no documented evidence that the deployed inbox renders that shape. The documented live record (#64) verified the deployed connection's `edges[].node` shape but never recorded the connection's `page_info` field shape, and also observed **both** inbox operations (`ContainerQuery` and `PaginationQuery`) on a 24-conversation inbox — consistent with a paginated flow, not evidence of a marker-less single page.

**Synthetic repro (committed):** each candidate shape above is reproduced through the real collector over synthetic sanitized payloads and pinned to its condition by the `#204` test blocks in `facebook-messenger-inbox-graphql.test.ts` and `facebook-messenger-parse.test.ts`, and end-to-end through the backend in `facebook-messenger-backend.test.ts` — every one yields the observed typed refusal with no threads, and a terminal single page still verifies.

**What distinguishes the shapes live:** the backend now records the failing condition in its error log as a sanitized structural code — `incompleteReason` (`unverified_page` / `incomplete_chain` / `response_limit` / `malformed_connection`), one static line, no request or response content — so a single operator-authorized `messenger_threads_list` re-validation on the now-authenticated deployed session (separate authorization, per #204) names the condition that fired. If that run still reports `unverified_page`, the operator protocol should additionally record, structurally and without content: the initial inbox request's operation/friendly name and whether its variables carried a `cursor`; whether the connection object carries `page_info` at all (exact field name) and whether `has_next_page` is a boolean; whether the response body is plain `{"data":…}` JSON; and the count of same-origin `/api/graphql/` responses in the window versus the number whose bodies completed.
