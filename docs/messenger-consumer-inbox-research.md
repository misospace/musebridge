# Messenger ordinary personal inbox discovery (#78)

Parent: #45 (consumer Messenger). Related Marketplace-only recovery: #64. Design record: [PR #74](https://github.com/misospace/musebridge/pull/74), merged October 10, which adds `docs/messenger-consumer-research.md`. **Status: rendered row-to-key discovery verified; non-opening access remains unverified.** Two October 10 authenticated Chrome loads changed `/messages/` to `/messages/t/[redacted]` without a conversation click. The operator separately authorized metadata-only investigation after the first stop. That follow-up found 22 list rows with distinct provider-supplied thread links, including an E2EE URL form missed by the existing extractor. Direct navigation remains **NO-GO for the proposed non-opening listing workflow in this session**. Keep #78 open; do not create an implementation child. This document complements `provider-action-boundaries.md` (normative enforcement) and `conversation-surface-research.md` (#43 step 1, authoritative for the Marketplace surface).

## What #78 asks

Issue #78 asks whether the **ordinary personal Messenger inbox** at `www.facebook.com/messages/` can expose an authoritative, per-conversation key through a normal authenticated load, so that a future `consumer_threads_list`-shaped tool could list personal chats separately from the Marketplace inbox.

The problem the issue names:

- `messenger_threads_list` currently navigates the **Marketplace** `/marketplace/inbox/` view; ordinary personal chats under `/messages/` are not exposed by that tool.
- The October 8 research (#64) disproved anchor-only extraction in the Marketplace view; it does **not** establish what the ordinary inbox looks like.
- The existing broken selector contract must not be copied.

What the issue requires:

- Read-only authenticated inspection of `www.facebook.com/messages/` **without opening individual conversations**; if navigation auto-opens a thread, stop and obtain operator approval before any receipt-generating action.
- A decision on whether the ordinary inbox surfaces authoritative conversation keys in normal loaded GraphQL responses, accessible DOM attributes, or another verified **passive** channel — never inferred from names, order, previews, or timestamps, and never via replaying authenticated requests.
- A separate, bounded `consumer_threads_list` (name tentative) or a justified shared implementation without silently broadening `messenger_threads_list`, preserving session isolation and privacy boundaries.
- Observable errors, fixtures, and an operator validation protocol. Draft/send work stays in #62/#63.

## What exists / what does not

**Exists (Marketplace-scoped, not consumer-inbox):**

- `messenger_threads_list` and `messenger_thread_read` are `read`-class under scope `(facebook, default, messenger)` (`services/marketplace/src/tools.ts:36-38,76-89`).
- `messenger_threads_list` reads the Marketplace inbox `/marketplace/inbox/` (`services/marketplace/src/facebook-messenger-backend.ts:85`; `MESSENGER_INBOX_PATH` in `services/marketplace/src/facebook-messenger-url.ts:5`).
- `messenger_thread_read` uses `/messages/t/{id}/` (`MESSENGER_THREAD_PATH`, `facebook-messenger-url.ts:4`).
- Input is `limit` 1..20 default 10; list output is `{ ok, backend, threads[] }` (`services/marketplace/src/domain.ts:151-153,236-243`).

**Does not exist:**

- Any ordinary-inbox listing logic. `/messages/` appears in the codebase only as the messenger session-probe target (`FACEBOOK_MESSENGER_PATH = '/messages/'`, `services/marketplace/src/facebook.ts:8`; the probe path is selected per surface, `facebook.ts:64-70`).
- The extractor only recognizes `/messages/t/{id}/` anchors with the id grammar `^[A-Za-z0-9][A-Za-z0-9._-]*$` bounded to 128 (`services/marketplace/src/facebook-messenger-extract.ts:70,118`), thread message rows `[role="row"]` with `You said/sent/replied:` / `{Name} said:` markers (`facebook-messenger-extract.ts:172-201`), and the empty marker `no conversations|no messages yet|nothing here yet` (`facebook-messenger-extract.ts:101`).
- An unrecognized layout is a typed `UPSTREAM_ERROR`, never an empty success (`services/marketplace/src/facebook-messenger-parse.ts`).

## Live operator observation (2026-10-10)

The operator explicitly authorized one controlled `/messages/` load after being told that automatic conversation selection could generate a Facebook read acknowledgment visible as Seen to the participants. This authorization covered the initial load, not message inspection or further conversation interaction.

Procedure and sanitized evidence:

- Used the operator's authenticated Chrome profile and a new tab. No login credentials, cookies, tokens, or request headers were exported.
- Opened DevTools Network on the new tab and verified recording was active **before** navigating. The existing `graphql` filter was active; the capture log was cleared before the one load. No request was replayed.
- Navigated once to `https://www.facebook.com/messages/`. After the page settled, both Chrome's address field and the page accessibility root reported `/messages/t/[redacted]`. No conversation control was clicked. This verifies automatic thread navigation/selection in this session; it does not establish which thread was selected or why.
- The capture showed 12 request rows matching the same-origin `/api/graphql/` endpoint. No operation names, request payloads, response schemas, or response bodies were inspected after the automatic selection. This count proves neither a listing connection nor a receipt.
- Stopped inspection immediately on that result and closed the inspection tab. Verified that the thread page was absent afterward. No message bodies were extracted and no identifiers were saved.

**Verified:** the tested root-inbox navigation automatically selected a thread URL. **Unverified:** whether a Seen receipt was emitted, message content rendered, an authoritative listing connection exists, or the behavior repeats in another session. No rollout explanation is claimed.

The first run did not inspect DOM selectors, hydration state, populated/empty list structure, login/challenge markers, pagination/virtualization, E2EE/session requirements, or personal-vs-Marketplace membership. The stop rule prevented those probes; it did not undo any side effect of the authorized load. The separately approved follow-up below supplies additional evidence without retroactively broadening that first authorization.

## Metadata-only follow-up (2026-10-10)

After PR #82 merged, the operator requested further passive discovery and a follow-up PR. Before another load, the investigator explained that closing the first tab had lost its capture and that the new load could select a thread again. The follow-up remained metadata-only: no conversation entry clicks, message-body extraction, request replay, private-module invocation, or saved identifiers. The new root-inbox load again selected `/messages/t/[redacted]`; this verifies repetition across two loads in the same profile, not across accounts or fresh service profiles. Seen emission remains unknown.

### Rendered DOM contract

The executed in-page probes returned only counts, roles, attribute names, and key-shape/equality summaries:

| Observation | Result |
|---|---|
| All `a[href]` elements | 33 |
| Same-origin `/messages/t/[redacted]` links | 8, all within the first 60 anchors |
| Same-origin `/messages/e2ee/t/[redacted]` links | 14 |
| Distinct observed thread keys | 22; all numeric strings, 15–17 digits in this sample |
| Thread links with a closest `[role="row"]` | 22 |
| Distinct rows containing those links | 22; each contains exactly one distinct linked key |
| Thread-link elements and explicit roles | `A`, `role="link"`; ancestor roles include `gridcell` and `row` |
| All `[role="row"]` elements | 25; do not treat every row as a conversation |
| `main, [role="main"]` | 1 |
| Existing auth-marker selector | 2 matches |
| `input[type="password"]` | 0 |
| Thread/conversation-named attributes on buttons or rows | None |

The association is the link contained by each row, not an inferred join by name, position, preview, timestamp, or matching counts. Numeric grammar and uniqueness were checked in memory; actual keys were not printed or persisted. This is an authoritative **rendered navigation key** for each observed linked row. Stability across loads, total inbox completeness, and correspondence to a transport-level key remain unverified. No linked destination was visited by clicking it.

The current extractor's `/messages/t/` scan would recognize only the eight plain links, omitting the fourteen E2EE links. Its first-60 bound did not exclude plain links in this sample. A future consumer extractor must recognize both route forms, validate same-origin URLs and bounded keys, and associate links with their containing list rows. It must not infer E2EE read behavior from a URL or rebuild every destination as `/messages/t/{id}` without verifying that normalization. This evidence does not change Marketplace's button-only contract.

### Normal requests and bootstrap state

The second capture contained 12 same-origin `/api/graphql/` request rows. Only `fb_api_req_friendly_name` was projected from request metadata; no payload values or response bodies were exported. The observed operation names were:

- `fetchMWChatVideoAutoplaySettingQuery`
- `FBYRPTimeLimitsEnforcementQuery`
- `OhaiWebPublicKeyConfigQuery`
- `MWQuickPromotionThreadViewBannerContainerQuery`
- `MWComposerDisclosureMSipNoticesMwbSafetyInterventionQuery`
- `useMWEncryptedBackupsFetchBackupIdsV2Query`
- `CometSearchBootstrapKeywordsDataSourceQuery`
- `usePseudoBlockedUserInterstitialF3Query` (twice)
- `RTWebCallBlockSettingHooksQuery`
- `MAWVerifyThreadCutover_ContactCapabilities2Query`
- `MWQuickPromotionThreadlistBannerQuery`

Neither Marketplace inbox operation from #64 appeared in this capture. Operation names alone do not establish the presence or absence of an ordinary-inbox connection, or receipt behavior. These were normal page requests, not requests replayed by the investigator.

A bounded schema probe parsed 100 embedded `script[type="application/json"]` blocks, visited 17,128 object/array nodes, and skipped 1,025 sensitive fields. Bounds: at most 200 script blocks, 15 MB per block, depth 22, 100,000 visited nodes, and 1,000 array entries per traversal step. It skipped message/body/text/content/preview/snippet/participant/name/title/credential fields, returned schema paths and types only, and did not invoke private React or database APIs.

Observed structural candidates include:

```text
$.require.[].[].[].__bbox.require.[].[].[].__bbox.result.data.viewer.message_threads : object
$.require.[].[].[].__bbox.require.[].[].[].initialRouteInfo.route.rootView.props.thread_key : string
$.require.[].[].[].__bbox.require.[].[].[].initialRouteInfo.route.hostableView.props.thread_key : string
$.require.[].[].[].__bbox.require.[].[].[].initialRouteInfo.route.params.thread_key : string
$.require.[].[].[].__bbox.define.[].[].activeThreadKeys : array
$.require.[].[].[].__bbox.define.[].[].allActiveThreadKeys : array
```

The operator subsequently executed the connection-schema/equality probe on the ordinary inbox tab. Its `message_threads` object had only `unseen_count:number` and `recent_unread_count_with_e2ee:number`; no `edges`, node keys, or page-info fields were present, so it yielded zero authoritative keys or DOM matches. This object is unread-count metadata, not a verified inbox identity source. Route-state keys describe selected-route state and must not be presented as an inbox list.

### Remaining access gate and limitations

A Facebook homepage/header Messenger list is a concrete alternative under investigation. The separate homepage tab initially exposed no page content through accessibility; after the operator's next handoff it was inspectable. The header had a `pop up button` named `Messenger`. Opening that control kept Chrome at the Facebook root URL, exposed a `Chats` heading, and exposed no detected `Write to`/`Type a message` composer. No chat entry or `See all in Messenger` link was clicked. Thread URLs appearing in the accessibility tree at this point were links, not evidence of navigation.

The same structural probe then found 18 linked rows, each with one distinct key. Whole-page links included unrelated/navigation destinations, so the list container still needs a verified semantic boundary before a consumer extractor is specified.

The operator executed the homepage bootstrap connection probe. One `message_threads` object contained only unread counts; another contained `edges:array` with 10 nodes. All 10 `thread_key.thread_fbid` values were bounded numeric strings and distinct. For all 10, the opaque node `id` decoded in memory to `message_thread:` plus the same key. Only five keys matched the **whole-page** set of rendered thread-link keys; this does not establish five matches inside the header list. No `page_info` fields were present. Node field names/types included `thread_key:object`, `is_xac:boolean`, `updated_time:number`, `customization_info:object`, `name:string|object`, `image:object`, `all_participants:object`, and `id:string`; private field values were not extracted. The meaning of `is_xac` was not verified.

This verifies provider-supplied bootstrap keys and partial equality with rendered destinations, not complete coverage or a reliable association with every header row. Neither position nor matching counts may fill that gap. These were embedded preloaded result structures; their correspondence to a captured network operation remains unverified. The header list remains a candidate, not an approved production path. No alternate URL flags, private endpoints, request replay, or speculative redirect suppression were tried.

Empty-state, challenge states, pagination/virtualization, cross-load key stability, encryption/session requirements, and personal-vs-Marketplace membership remain unverified. The `/messages/e2ee/t/` path and backup-operation name do not prove that the automation profile can decrypt or restore anything. Counts do not prove completeness. During Console-input troubleshooting one diagnostic inadvertently displayed a private composer label; it was not repeated or copied into this document. No message body was extracted.

The existing serialized Playwright page can inspect rendered attributes and observe normal responses within `runExclusive`, with cancellation and cleanup. That is an implementation capability, not a verified non-opening consumer path. Reuse the messenger scope/profile; do not add a browser/auth subsystem or private runtime dependency. A passive response collector also materializes the response JSON, so projecting allowed fields afterward must not be described as avoiding all message-body materialization. The safe-loading gate must be resolved before a consumer implementation child.

## Existing probe and integration risk

The messenger probe **already navigates `/messages/` on every messenger tool call**:

1. `messenger_threads_list` and `messenger_thread_read` both call `ensureUsableSession` (`facebook-messenger-backend.ts:104,157`).
2. `ensureUsableSession` calls `probeSession` (`facebook-messenger-backend.ts:205-208`).
3. The messenger-surface probe navigates its probe URL, which is `/messages/` (`facebook.ts:8,64-70`; the navigation is `loadSnapshot` → `page.goto(this.probeUrl)` at `facebook.ts:103-107`).

**Observed navigation hazard, unverified receipt:** the live Chrome run automatically selected a thread. The same probe target in a service profile could therefore open a thread before a listing call, but this run did not execute the service or verify its receipt behavior. Do not add production `/messages/` navigation to a non-opening list operation on this evidence. A manual research visit requires informed approval before the first potentially receipt-generating load.

**Base and in-flight change.** The code citations in this document describe the PR's original base `ff215e2`. A live repository check on October 10 against `main` at `4e820c8` confirmed that the default messenger probe still targets `/messages/`. The Marketplace-only recovery [PR #81](https://github.com/misospace/musebridge/pull/81) was open and unmerged at that check; it proposes changing the messenger probe and credential-login verification to `/marketplace/inbox/`. Landing that change would remove this root-inbox navigation from those paths; it would not verify an ordinary-inbox listing source or make new `/messages/` listing navigation safe.

## Access paths evaluated

Cross-reference PR #74 `docs/messenger-consumer-research.md` for the full consumer Messenger access-path decision record; this table only covers the ordinary-inbox discovery question.

| Path | What it could yield | Status | Basis |
|---|---|---|---|
| DOM anchor scan of `/messages/` | Thread hrefs/keys from rendered links | **22 row-linked keys verified after automatic selection** | Eight plain and fourteen E2EE links; non-opening loading behavior remains unverified |
| Passively observed GraphQL/JSON responses | An authoritative key in a normal loaded response | **Operation names observed; connection keys unverified** | Twelve normal GraphQL requests; no Marketplace inbox operation; no request replay |
| Embedded hydration/bootstrap state | A key in initial page state | **Ordinary tab contains only unread counts** | No edges/keys there; selected-route state is not a list |
| Homepage/header Messenger list | Thread keys without ordinary-root navigation | **18 linked rows; 10 bootstrap keys with partial DOM overlap** | Root URL retained and no detected composer; all 10 opaque node IDs corroborate their keys, but only five keys match whole-page links; semantic boundary and coverage unverified |
| `messenger.com` standalone | Same ordinary inbox on another origin | **Rejected for now** | Adds an origin/login for no discovery gain; `conversation-surface-research.md` |
| Official API | Personal inbox listing | **Does not exist** | Messenger Platform is Page/business-scoped; no personal-consumer-inbox API (`conversation-surface-research.md`) |

**Load-bearing fact:** the Marketplace result is a scoped observation, not a reusable contract. #64 proved a passive GraphQL connection exists for the **Marketplace** inbox only; nothing about it transfers to `/messages/` without its own live investigation.

## The discovery question

Define the **authoritative key** before any implementation: a single stable per-conversation identifier that the provider supplies in a normal authenticated load, maps 1:1 to one conversation, and is independent of presentation order, display name, preview snippet, or timestamp. A Marketplace-shaped `thread_key.thread_fbid`-like value is a candidate *shape*, not a verified contract for `/messages/`.

Candidate **passive channels** — their evidence and loading limits are recorded above:

- DOM attributes on the loaded `/messages/` page: row-contained links supply the observed keys.
- Passively observed same-origin GraphQL/JSON responses (listener attached before navigation, as in #64).
- Embedded hydration/bootstrap state present in the initial load.

No mapping may be inferred from names, order, previews, or timestamps, and authenticated requests must never be replayed.

## Auto-open / receipt risk

Two distinct risks must be separated:

1. **Probe navigation (current default):** the messenger probe visits `/messages/`. Automatic thread selection was observed in the operator's Chrome session; whether the service profile does the same or emits a receipt is unverified. The current probe does not enforce the intended non-opening list boundary.
2. **Listing navigation (future):** direct `/messages/` navigation failed the non-opening requirement in this run. Per `provider-action-boundaries.md:39,86`, the named "Seen" exception is scoped to **thread opens only**; a listing operation is expected to open **no** threads and emit **no** receipts. A list tool cannot silently inherit that exception. A different non-opening access path must be verified before implementation.

Detecting a thread URL and aborting after navigation is a containment measure, not proof that a receipt was prevented. It cannot establish a side-effect-free listing path.

## State classification

Classification must reuse the existing fail-closed discipline:

- Login, checkpoint, and captcha states surface as typed provider errors.
- An authenticated page with no recognizable threads and no recognized empty state is `UPSTREAM_ERROR`, never empty success.
- A positively verified empty inbox is the only path to `[]`.
- Ordinary-inbox virtualization/pagination is unverified and must not be assumed complete from one page.
- The personal-vs-Marketplace distinction must be established from the page/response itself, not from the URL alone.

## Proposed `consumer_threads_list` contract (conditional)

If, and only if, the operator protocol below positively verifies a passive authoritative key and non-auto-open behavior, the following contract is proposed — **separate tool, not a broadening of `messenger_threads_list`**:

- **Name:** `consumer_threads_list` (tentative).
- **Scope/profile:** same `(facebook, default, messenger)` scope and same `MESSENGER_PROFILE_DIR` (`~/.marketplace/browser-profile-messenger`), enabled only by `MARKETPLACE_MESSENGER=1` (`services/marketplace/src/service.ts:126,127-137,398-400`). No new scope or profile.
- **Risk class:** `read`, only if listing opens no threads and does not rely on the thread-read Seen exception.
- **Input:** bounded `limit`, mirroring the existing 1..20 default 10 (`domain.ts:151-153`).
- **Output:** `{ ok, backend, threads[] }` with an explicit `threads[].thread_id`: an authoritative, grammar-bounded key (`MAX_THREAD_ID_LENGTH = 128`, `domain.ts:9,36`) and no inferred preview/participant fields. Bounded validated IDs are permitted in the authorized MCP result; they are prohibited in logs, research reports, stored diagnostic artifacts, and raw response dumps. Synthetic fixtures may contain invented IDs.
- **Fail-closed:** unrecognized layout or absent/unsupported key source → typed error, never empty success; ids never synthesized; read URLs (if ever added) rebuilt from the configured origin with the redirect guard (`facebook-messenger-parse.ts:102-107`; inbox guard `:51-52`).

## Observable errors

Reuse the existing typed sets:

- Provider codes: `AUTH_EXPIRED, LOGIN_REQUIRED, CAPTCHA_REQUIRED, SESSION_INVALID, RATE_LIMITED, UPSTREAM_ERROR, TIMEOUT` (`domain.ts:14-22`).
- Runtime adds `NOT_FOUND, INTERNAL_ERROR, APPROVAL_REQUIRED, ACTION_FORBIDDEN` (`domain.ts:162-168`).
- `UPSTREAM_ERROR` covers "layout/response not recognized"; `LOGIN_REQUIRED`/`CAPTCHA_REQUIRED`/`SESSION_INVALID` cover auth and challenge states; `TIMEOUT` covers a page/response that never settles.
- The existing human-readable messages are Marketplace-worded (`facebook-messenger-backend.ts:296-303`, e.g. "…to read Marketplace conversations"); an ordinary-inbox tool must re-target or neutralize that wording rather than reuse it verbatim.

## Fixtures and bounded tests (specified, not built)

Any future implementation must ship fixture-first, against synthetic sanitized pages/responses only, with the fixture backend remaining the integration reference:

- Populated ordinary inbox yields deduplicated validated keys.
- Positively verified empty connection yields `[]`.
- Absent/unknown/malformed source fails with a typed error (never a false empty).
- Duplicate valid keys are deduplicated; malformed authoritative records fail closed rather than producing a false empty result.
- Plain and E2EE row-contained links are recognized; navigation, unrelated, and unlinked rows are excluded without reading their text. Multiple conflicting keys in one row fail closed. Key shape and origin validation never fabricate an ID.
- More than 60 unrelated anchors preceding valid row-contained links must not silently truncate discovery; filter the bounded list region before applying the requested result limit.
- E2EE destination provenance is preserved rather than silently rewriting an encrypted route to the plain thread path.
- Late/out-of-order/unrelated responses are bounded and never fabricate completeness.
- Response listeners are attached before navigation and removed in `finally`.
- Abort and handler cleanup are covered.
- Authorized MCP results contain only the specified bounded validated IDs, never message bodies, raw responses, cookies, tokens, or headers. Logs and diagnostic reports contain counts/booleans only and no identifiers or content.
- Automatic `/messages/t/` navigation prevents successful list classification; cleanup runs without inspecting the selected conversation. This test detects the failure and does not claim that aborting prevents Seen.
- Auth probes and login verification for a non-opening list must not navigate a conversation-selecting surface. The existing probe path is an integration prerequisite, not a selector-only fix.
- Browser tests must make zero Facebook requests.

## Operator validation protocol (read-only)

Run manually in an authenticated Chrome session; record **sanitized structural evidence** (schemas, counts, booleans, and key shapes), never actual identifiers, names, previews, or message text.

1. Confirm explicit informed operator consent to the initial load. Explain that automatic thread selection could send a read acknowledgment to Facebook and make Seen visible to participants. Stopping afterward cannot undo that side effect. Without consent, do not navigate.
2. Stage passive capture **before the first navigation**: DevTools Network recording on a fresh tab, or an existing approved Playwright response listener. Do not export a HAR, authenticated HTML, headers, payloads, or raw response bodies.
3. Load `/messages/` once. Immediately check the sanitized URL and structural selection indicators. **If a thread is selected, stop immediately before DOM/state/response inspection or further interaction; close the inspection tab.** Do not infer that a receipt was prevented or emitted. Any further research requires separate approval for its concrete actions.
4. Only if the first load remains a list with no selected conversation, record booleans for login/checkpoint/captcha/empty and authenticated markers.
5. Inspect only passive captured response structure and metadata: connection presence, operation name, allowlisted key shape, and in-memory uniqueness/equality checks. Do not replay requests, invoke private modules, or read message fields.
6. Check DOM/hydration candidates without clicking. Never infer association from names, order, preview snippets, timestamps, or matching counts. A second load is not part of this protocol; stability across loads remains unverified unless separately authorized and performed safely.
7. Record whether virtualization/pagination is structurally exposed; do not scroll, paginate, or claim completeness from one load without further authorization and evidence.
8. Classify personal-vs-Marketplace from verified page/response structure, not the URL alone. Record only schemas, counts, booleans, and key grammar/length, never actual keys or private content.

The first October 10 run stopped at step 3. The operator then separately approved the metadata-only follow-up documented above; that authorization did not establish a safe production list path or approve conversation clicks.

## Verified vs assumed

**Verified in this repository (code state at `ff215e2`):**

- The Marketplace scoping and tool declarations; the `/marketplace/inbox/` list path and `/messages/t/{id}/` read path; the probe targeting `/messages/`.
- The extractor's anchor/row/empty-marker rules and fail-closed parse; thread-id grammar and bounds; provider/runtime error codes; input limits and output shape.
- The `MARKETPLACE_MESSENGER=1` gate and messenger profile default.

**Live #64 evidence (issue #64's 2026-10-08 inspection; a parallel branch, not current code state):**

- The Marketplace inbox had 24 conversation buttons and zero `/messages/t/` anchors, with GraphQL `CometMarketplaceInboxBuyerTabViewContainerQuery`/`PaginationQuery` carrying `data.viewer.marketplaceInboxBuyerMessageThreads.edges[].node` (`__typename: "MessageThread"`, `thread_key.thread_fbid`) — **Marketplace-scope ONLY**, and not assumed for `/messages/`.

**Live #78 evidence (2026-10-10 operator run):**

- One informed, authorized root-inbox load automatically navigated to `/messages/t/[redacted]` without a conversation click. Capture was staged first; inspection stopped and the tab was closed. See the procedure above for the evidence and limits.
- A separately authorized second load repeated automatic selection. Metadata-only probes verified 22 distinct row-contained plain/E2EE navigation keys and a candidate bootstrap `message_threads` object. Transport-level association and non-opening access remain unverified.
- Opening the homepage header `Messenger` control retained the root URL and exposed 18 linked rows without a detected composer. A bootstrap connection had 10 distinct numeric keys, all corroborated by decoded node IDs; five matched whole-page thread links. No complete header-row association or coverage was established.

**Assumed / unverified (do not treat as fact):**

- That the observed navigation keys are stable across loads or correspond to a validated bootstrap/response connection.
- Whether automatic selection repeats across sessions, and whether the observed load emitted Seen.
- That Marketplace's GraphQL connection shape recurs on `/messages/`.
- That ordinary-inbox pagination/virtualization is bounded like Marketplace's.
- That rendered keys can be acquired in a workflow that opens no conversation.

## Safety, privacy, and boundaries

Mapped to `provider-action-boundaries.md`:

- **Risk class.** The intended consumer listing is `read` only if it meets the non-opening boundary. The named Seen exception (`provider-action-boundaries.md:39,86`) covers **thread opens only**. The statement that listing opens no threads is a required contract, not verified runtime behavior for the current probe chain or an ordinary-inbox implementation.
- **No new scope.** Same `(facebook, default, messenger)` scope and profile; no shared state change.
- **Results versus diagnostics.** A future authorized MCP result may return the specified bounded validated IDs. Logs, diagnostic output, research reports, and stored diagnostic artifacts must contain no identifiers or private content. Never return message bodies, raw responses, cookies, tokens, or headers from this listing tool. The operator investigation does not persist actual identifiers.
- **Never automate 2FA or challenges.** Challenge states surface as typed errors requiring manual recovery.
- **No replay / no endpoint calls.** Only passively observed normal loads; no hardcoded tokens or undocumented calls.
- **Untrusted content.** Any extracted text remains other-participant-controlled and bounded; interpretation belongs to Miso.

## Deliberate gaps / recommendation

- **Recommendation:** keep #78 open for the unresolved passive-access question. The tested direct-navigation path is NO-GO for a non-opening listing tool; this is observed evidence, not proof that every alternative is infeasible. Do not implement `consumer_threads_list` now.
- **#78 acceptance criteria mapped:** (1) populated row-to-navigation-key structure and direct-navigation failure observed; empty structure, transport association, and alternate non-opening access remain unverified; (2) potential auto-open/receipt was approved before each investigation phase; no conversation entries clicked and no message bodies extracted; receipt emission remains unknown; (3) structural evidence, limitations, and bounded tests specified, not built; (4) **no implementation child created**, because no non-opening authoritative source is verified.
- **No implementation child is proposed.** A future ticket may be opened only after the operator protocol positively verifies a passive authoritative key and non-auto-open behavior.
- **Cross-links:** `provider-action-boundaries.md` (normative enforcement), `conversation-surface-research.md` (#43 step 1 Marketplace surface), PR #74 `docs/messenger-consumer-research.md` (consumer Messenger design record), #64 (Marketplace-only listing recovery), and `services/marketplace/AGENTS.md` (scope, credential, privacy invariants).
- **Owner and handoff:** assigned through Dispatch to the operator/Codex team. Next evidence collection must propose a concrete passive path that avoids automatic selection, with any potential side effects explained and authorized before action. Establish an authoritative source and its safe loading behavior before creating an implementation child. This document does not authorize another `/messages/` load or change the provider boundary.
