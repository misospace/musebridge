# Bounded personal-message search design (#79)

Parent: #45 (consumer Messenger). Evidence inputs: #78 (personal-inbox discovery no-go, [`messenger-consumer-inbox-research.md`](messenger-consumer-inbox-research.md)), #64/#97/#151 (Marketplace inbox listing and its coverage semantics), #146/#158 (thread-read coverage), #77 (live validation), #62/#63 (Marketplace Messenger draft/send), the 2026-10-24 reliability audit (`docs/audits/browser-and-session-reliability.md`), and `provider-action-boundaries.md` (normative).

**Status of this document: decision and contract only.** It supplies #79 acceptance items 1–3 (evidence-backed decision and exact tool contract; coverage semantics and receipt consequences; the no-crawl rule with a specified synthetic test plan). It implements nothing: #79 stays `status/blocked`, the tool below is not registered, and no selector or DOM work is attempted, per the grooming direction of 2026-10-10/2026-10-11 and the #78 no-go. Implementation begins only after the operator evidence protocol in this document positively verifies the source it is conditional on.

## Decision (evidence-backed)

1. **The bounded search surface is thread-level discovery search over a passively observed, non-opening personal-inbox listing.** The query is evaluated in memory against provider-supplied per-row data observed during one authenticated load. The query is never typed into the provider, no request is issued or replayed against any provider endpoint, and no conversation is opened. Search is a thin filter over the same verified listing a future `consumer_threads_list` (#78, conditional) would use — never an independent crawl, never a stored index, never a second collection mechanism.
2. **Historical message-content search is out of scope for this tool.** It has no verified non-opening source (#78: no listing connection observed on a `/messages/` load; embedded state carried unread counts only), and the only demonstrated access path to message bodies is a thread read, which trips the named Seen receipt per thread. The `read` risk class carries exactly one side-effect exception — the receipt intrinsic to opening a thread (`provider-action-boundaries.md`, "Action risk classes"; the exception is scoped to thread opens) — and a search loop over thread reads would scale that exception into bulk receipt emission. That is not a `read` tool, and no other risk class fits a discovery operation, so content search does not ship in any form under current evidence.
3. **Provider search-UI automation is rejected.** Typing a query into the Messenger search box is an unverified interactive surface with unknown side effects and an unknown result contract; it also violates the no-replay/no-speculative-interaction discipline and #78's prohibition on assuming `/messages/` DOM structure.
4. **The tool is `consumer_threads_search` (tentative name, sibling of #78's tentative `consumer_threads_list`)**, scope `(facebook, default, messenger)`, risk class `read` conditional on the verified non-opening source, gated behind `MARKETPLACE_MESSENGER=1`. It reuses the messenger scope's profile, probe, reauth loop, and account circuit breaker. No new scope, no new browser or auth subsystem.
5. **The tool must not ship until the source evidence exists, and it has its own evidence-based no-go branch:** if the operator protocol verifies a non-opening source that supplies a per-row authoritative key but *no* matchable per-row text field, then a thread-level search over bare ids has nothing to match and the search tool is concluded as a no-go on that evidence — exactly as #78 was — rather than implemented against inferred names, previews, or order.

## Evidence base (2026-10-31)

- **#78 no-go (2026-10-10).** Two authorized `/messages/` loads auto-selected `/messages/t/[redacted]` without a click; receipt emission remains unknown. The metadata-only follow-up verified 22 row-contained thread keys (8 plain `/messages/t/`, 14 E2EE `/messages/e2ee/t/`), found the embedded hydration state carried only unread counts (no edges, no keys), and captured 12 normal GraphQL operations with no inbox-listing operation and no `page_info`. The homepage header Messenger menu exposed 18 linked rows and a bootstrap `message_threads` connection with 10 keys (node ids decoding to `message_thread:<fbid>`), but no `page_info`, no verified region containment, only partial (5/10) overlap with rendered links, and the region was later observed absent. Scope, completeness, cross-load stability, and receipt-safe loading were all left unverified.
- **The verified passive-collection pattern exists only for the Marketplace inbox** (#64, #97, #151). `facebook-messenger-inbox-graphql.ts` recognizes inbox operations by request name, verifies cursor chains to a terminal page, cross-checks each `thread_key.thread_fbid` against the `message_thread:` global-id form, deduplicates, and fails closed through `recognized/malformed/empty/incomplete/truncated`. The 2026-10-24 audit traced this collector end-to-end and found it sound. #78's load-bearing fact stands: nothing about it transfers to `/messages/` without its own live investigation.
- **Coverage contracts to reuse as precedent.** The listing reports truthful `truncated` coverage (#151, merged 2026-10-26), and thread reads report `coverage {window: 'tail', scanned_rows, truncated}` with a newest-end proof (#146, merged 2026-10-25). A partial result in this service is labelled, never silent — the exact discipline #79 requires for search.
- **The messenger probe and reauth land on `/marketplace/inbox/`** (`facebook.ts:10`, `facebook.ts:114`), never on `/messages/` (post-#81). This design preserves that; a personal-inbox listing/search must not move the probe onto an auto-selecting surface.
- **No official API exists** for the personal consumer inbox: Messenger Platform is Page/business-scoped (`conversation-surface-research.md`).

## What search can mean

| Semantics | Verdict | Basis |
|---|---|---|
| Full-history message search (match inside message bodies) | **Out of scope** | No verified non-opening message source; the only known access path opens threads and emits Seen per thread; the read exception cannot be scaled into a search loop; no provider API. |
| Provider search-UI automation (type the query into Messenger's search box) | **Rejected** | Unverified interactive surface, unknown side effects, unknown result contract; violates no-replay/no-speculative-interaction; #78 forbids assuming `/messages/` DOM. |
| Thread-level discovery search over a passively observed listing (match against provider-supplied per-row metadata) | **Selected** | Same boundary as the conditional listing tool: one load, no thread opens, in-memory filter, no persistence. |

The consequence is deliberate and must be stated in the tool description: **search coverage equals the underlying listing's coverage.** One bounded recent window per call, observed live. Not full history, not an index, not paginated by the caller.

## The exact public tool contract (conditional target spec)

Strict Zod, `.strict()`, reusing existing bounds and schemas: `MAX_QUERY_LENGTH` (256), `conversationThreadIdSchema` (grammar-bounded ≤ 128), and `conversationThreadSchema`'s field bounds (`participants` ≤ 8 × 128 chars, `preview` ≤ 280 chars). Registration is an additive public-contract change (schema minor version bump). Names remain tentative until implementation.

### Input

```
consumer_threads_search input = {
  query: z.string().trim().min(1).max(256).regex(/\S/),
  limit: z.number().int().min(1).max(20).default(10)
}
```

Matching semantics — strict, no fabrication:

- Normalize both the query and candidate field values: Unicode casefold, trim, collapse internal whitespace.
- A match is a case-insensitive substring hit against **allowlisted searchable fields only** — exactly the fields the verified source supplies per row authoritatively (candidates: participant labels, thread title/label, listing-item label, snippet). No regex, no fuzzy matching, no stemming, no inference from position, order, preview shaping, or timestamps.
- The searched field set is part of the output (see `coverage.searchable_fields`), so a caller always knows what the query was matched against.

### Output

```
success = {
  ok: true,
  backend,
  matches: [{                       // max 20
    thread_id,                      // authoritative, grammar-bounded; never synthesized
    route: 'plain' | 'e2ee',        // provider-supplied route provenance, preserved verbatim
    matched_on: string[],           // nonempty; which searchable fields matched
    participants?: string[],        // ≤ 8 × 128, only when provider-supplied
    preview?: string                // ≤ 280, only when provider-supplied
  }],
  coverage: {
    threads_observed: number,       // ≥ 0; unique threads the verified observation carried, before caps
    window: 'recent-load',          // literal: this call's observed inbox window only
    complete: boolean,              // true ONLY on a verified terminal cursor chain
    searchable_fields: string[]     // the allowlisted fields actually available this call
  },
  truncated: boolean
}
```

- `matched_on` is the provenance field: it names which allowlisted fields matched, so a caller can weigh a participant-label hit against a snippet hit.
- `route` preserves E2EE provenance. An E2EE-surfaced key is never rewritten to the plain `/messages/t/{id}` path; whether an E2EE thread is reachable for a later read is a separate, unverified question that this tool deliberately does not answer.
- `coverage.threads_observed` exposes how much the observation actually carried, so "no result" can be weighed against "small window".
- `coverage.complete: true` requires the collector discipline: a complete, cursor-verified terminal chain (`page_info.has_next_page === false`) over recognized requests. No personal-inbox source has ever shown a `page_info`; until one does, `complete` is `false` and the tool description says the results cover only the observed recent window. **A partial scan is never labelled comprehensive.**
- `truncated: true` when the verified observation carried more threads than the bounded search examined, or more matches than `limit` returned — the #151 truthfulness rule: counted-but-unreturned is what makes the flag honest, and it never claims more than was observed.
- The tool does not paginate: it issues no requests and follows no cursors. It observes whatever the provider's own single load surfaces; a caller needing a wider window calls again (a fresh observation, never a cached or merged index).

### Error taxonomy (fail-closed; no-result is distinguishable from everything else)

| Condition | Result |
|---|---|
| Verified terminal observation; zero matches | `{ok: true, matches: [], truncated: false, coverage: {complete: true, …}}` — the **only** empty-success path |
| Verified observation; more matches than `limit` or more threads than searched | Success with `truncated: true` |
| Unrecognized layout; no verified source on the page | `UPSTREAM_ERROR` (never `[]`) |
| Unverified page, non-terminal/unverified cursor chain, malformed record, unobserved response, response-limit hit | `UPSTREAM_ERROR` — a search over an observation that cannot be trusted returns no results, because its own emptiness cannot be scoped. (Tighter than the listing's #151 path, which may truthfully bound a *verified* chain; a search may not even do that over an unverified one.) |
| Automatic thread selection during the load (a `/messages/t/` route appears) | `UPSTREAM_ERROR` with containment cleanup that never inspects the selected conversation. The error never claims a receipt was or was not emitted — containment is not prevention. |
| Auth expiry, challenge, ambiguous probe | `LOGIN_REQUIRED` / `CAPTCHA_REQUIRED` / `SESSION_INVALID` / fail-closed `session_unknown` via the existing `ensureUsableSession` gate |
| Deadline / budget | `TIMEOUT`, `RATE_LIMITED` per the existing taxonomy |

### Registration, scope, and risk class

- `TOOLS` entry: name `consumer_threads_search` (tentative), `riskClass: 'read'`, scope `{ provider: 'facebook', account: 'default', surface: 'messenger' }`, gated on `MARKETPLACE_MESSENGER=1` and declared with its own conversation-backend `requires` entry (the tools.ts capability pattern), so fixture deployments can integration-test the search layer without the live path.
- The `read` class is valid **only** under the verified non-opening precondition. The declared contract says: no thread opens, no receipt, no message bodies read. If the source evidence cannot establish non-opening behavior, the tool does not ship — there is no fallback risk class for a discovery operation.
- The messenger scope's probe and reauth landing path stay on `/marketplace/inbox/`; this tool must not move them onto an auto-selecting surface.
- The fixture backend remains the default and the integration reference, per the service's standing rules.

### Privacy, diagnostics, and state

- **Stateless per call.** One load, one in-memory observation, one in-memory filter, output, done. No persisted index of private text, no cross-call cache of listings or matches, no raw graph responses retained beyond the call, no cookies/tokens/headers handled outside the existing profile machinery.
- Results carry bounded validated ids and only provider-supplied allowlisted text at schema bounds. Logs and diagnostics carry counts, booleans, operation names, and shapes only — never ids, participant names, snippets, query text, or URL keys (the discipline `facebook-marketplace-diagnostics.ts` already follows).
- The query is caller intent, not provider content: it is validated, used in memory, and never logged or echoed into diagnostics.
- Matched participant labels and snippets are other-participant-controlled untrusted content, returned bounded and verbatim; interpretation belongs to Miso.

## Read-receipt consequences (explicit)

- The tool performs no thread opens. The named Seen exception in the risk-class table is scoped to thread opens and is **not inherited** by this tool; a conforming implementation emits no receipt and may be classified `read` for that reason, not by assertion.
- The residual risk is the listing load itself (the same residual risk a `consumer_threads_list` would carry). That risk is resolved by evidence, not by code: the operator protocol below must positively verify a non-opening source before any implementation exists.
- If a load nonetheless auto-selects a thread, the implementation must abort with containment cleanup and a typed error, and must make **no claim** about whether a receipt was prevented or emitted — the same discipline the #78 protocol recorded ("detecting a thread URL and aborting is a containment measure, not proof that a receipt was prevented").
- The response listener is attached before navigation and removed in `finally`; no request is replayed, no endpoint is called, nothing is typed into the provider; abort and cleanup are bounded and tested.

## Synthetic test plan (specified here, built with implementation)

Fixture-first, synthetic and sanitized only, zero Facebook requests, extending #78's fixture list and the collector's existing test patterns. The issue's named five first:

1. **Search-result identity.** Every returned `thread_id` comes from the verified observation, passes the grammar, and (where the source supplies the global-id form) is cross-checked against it; a mismatching or malformed record marks the observation malformed and the whole search fails closed rather than shipping a pruned result.
2. **Duplicate threads.** The same key observed twice (across pages or across DOM/connection sources) yields one match; counts and `threads_observed` reflect unique ids with first-occurrence order preserved.
3. **Incomplete pages.** Non-terminal chain, unrecognized request shape, unobserved response, response-limit hit, and malformed edges each produce the typed `UPSTREAM_ERROR` with zero matches — never a partial success, never `[]`.
4. **Login and challenge.** Probe classifications produce `LOGIN_REQUIRED` / `CAPTCHA_REQUIRED` / `SESSION_INVALID` before any listing navigation; an ambiguous probe fails closed as `session_unknown`; the credential circuit-breaker rules apply unchanged.
5. **Layout drift.** Unknown connection shape, absent expected region, a page that renders no recognizable list, and the auto-selection case each fail with typed errors; the auto-selection fixture also asserts cleanup ran without inspecting the selected conversation and that the error makes no receipt claim.

Additionally:

- **Matching semantics.** Case-insensitivity, whitespace normalization, no-match over verified data, multi-field hits, `matched_on` accuracy, `limit` capping with truthful `truncated`, and refusal to ship when no searchable field exists (the no-go branch is testable at the contract level).
- **Coverage truthfulness.** `complete: true` only on a verified terminal chain; `threads_observed` counts pre-cap uniques; `truncated` true exactly when the verified observation exceeded what was searched or returned.
- **Provenance.** E2EE rows keep `route: 'e2ee'`; nothing rewrites an encrypted route to the plain path; unrelated links, navigation, and rows outside the verified list region contribute nothing.
- **Privacy and lifecycle.** Diagnostics projection contains counts/booleans/names-of-fields only; the query never reaches a log; the listener is attached before navigation and removed in `finally`; aborts and the bounded flush behave under cancellation.

## Operator evidence protocol (the gate that unblocks implementation)

This reuses #78's read-only protocol — informed consent before the first potentially receipt-generating load; capture staged before navigation; immediate stop and tab closure if a thread is selected; sanitized structural evidence only (schemas, counts, booleans, key shapes); no replay, no private-module invocation, no persisted identifiers — and adds the positives this design depends on:

1. A non-opening personal-inbox observation source exists and repeats across at least two loads in the service profile (not just the operator's Chrome).
2. It supplies a per-row authoritative key (provider-supplied, 1:1, presentation-independent).
3. It supplies per-row matchable text fields, enumerated with their association provenance — or it does not, which triggers this design's no-go branch for search.
4. Terminality is provable (a `page_info`/has-next signal is observed) or is not — this decides whether `coverage.complete` can ever be `true`.
5. Personal-vs-Marketplace membership is decidable from the page/response structure itself.
6. E2EE-surfaced rows: present, and how are they keyed and routed?

End-to-end operator validation of any implementation happens only after separate, explicit permission, per #79's scope.

## Verified vs assumed

**Verified:** the Marketplace-inbox passive collector and its fail-closed coverage semantics (#64/#97/#151, audited); the read-window coverage contract (#146/#158); the #78 observations cited above; the current probe/reauth landing path; the existing error taxonomy and grant machinery this design reuses.

**Assumed / unverified (must not be treated as fact):** that any non-opening personal-inbox source exists; that it supplies per-row keys or matchable fields; that terminality is ever provable there; that automatic selection does not recur in a service profile; that E2EE rows are usable for anything. The conditional contract above is written so that none of these assumptions is load-bearing: each maps to a protocol step or to the no-go branch.

## Acceptance mapping for #79

- **"Evidence-backed decision for bounded search surface and the exact public tool contract"** — the Decision and contract sections of this document.
- **"Explicit search coverage semantics and read-receipt consequences"** — the coverage fields, the error taxonomy, and the receipt section.
- **"No broad personal-message crawling/indexing; synthetic tests and privacy-preserving diagnostics"** — the single-observation/no-persistence rule, the test plan, and the diagnostics rules. Tests are built with the implementation PR; this document specifies them.
- **"Only then implement the narrow tool"** — remains gated on the operator protocol above. The implementation PR must not precede that evidence, must not touch `status/blocked` on this issue by itself, and must keep drafts/send exactly where #62/#63 left them.
