# Browser automation, session management, and recovery reliability audit

- **Audited commit:** `origin/main` @ `9af629e` (`fix(marketplace): bound Facebook timeout validation to the shared 32-bit setTimeout range (#142)`, 2026-10-24). All file/line references below refer to this commit. Note: the local checkout at the time of the audit was `a07fda8` (88 commits behind `origin/main`); line numbers will not match that stale tree.
- **Method:** read architecture docs (`AGENTS.md`, `docs/provider-action-boundaries.md`, service README), the full browser/session/login/reauth/Messenger/GraphQL implementation, the test suite (814 tests), recent Git history, and GitHub issues #42, #43, #64, #77, #79, #80, #88, #95. Ran the full test suite in a detached worktree (813/814 pass; one flaky assertion, see P3-6) and validated the two most serious findings with purpose-built simulations against a real headless Chromium (described under each finding).
- **Constraints honored:** read-only except this report; no production code modified; no commits, pushes, PRs, or issues; no live accounts or credentials touched. All simulations used synthetic loopback servers.

## Addendum (2026-10-31): post-audit resolution status

The findings below were confirmed against `origin/main` @ `9af629e` (2026-10-24). Every confirmed defect in this report has since been fixed on `main`; the report is retained as the audit record and this list is the review trail:

- **P1-1, P2-1** — the account-wide credential-login circuit breaker with per-scope cooldowns, challenge hard-open, and reauth-lease preemption of in-flight attempts (#144, #154); admin-route lease start preempting the credential wait, pinned by test (#145, #177).
- **P2-2** — thread reads are tail-anchored by explicit timestamps and expose the `coverage` contract (#146, #158).
- **P2-3** — `marketplace_status` reports per-surface session states and downgrades stale assessments on observed auth failures (#147, #161).
- **P3-1** — Marketplace captcha classification requires visible challenge evidence (#148, #169).
- **P3-2** — abandoned-context teardown escalates to owned-process termination (#174, #184).
- **P3-3** — verified unavailable Messenger threads return `NOT_FOUND` (#150, #165).
- **P3-4** — bounded inbox listings report truthful `truncated` coverage (#151, #170).
- **P3-5** — the profile-collision guard compares canonical on-disk identity, including symlinks (#152, #167).
- **P3-6** — the flush-deadline test no longer asserts on a point-in-time set size (#153, #163).

## Scope snapshot

The service (`services/marketplace`) is a stateless MCP HTTP server that fans out to five surfaces. Two are browser-automated Facebook surfaces, each with its own serialized persistent-profile `BrowserSessionManager`, its own `FacebookSessionProbe`, its own optional env-credential login, and its own interactive re-auth loop (Xvfb + x11vnc + websockify, loopback admin server):

- `facebook/default/marketplace` — `marketplace_search`, `marketplace_fetch`, `marketplace_status` (default profile `~/.marketplace/browser-profile`).
- `facebook/default/messenger` — `messenger_threads_list`, `messenger_thread_read`, `messenger_prepare` (`prepare`), `messenger_send` (`send`; requires an HMAC-signed, single-use, payload-bound approval grant) — gated behind `MARKETPLACE_BACKEND=facebook` + `MARKETPLACE_MESSENGER=1`, with `FACEBOOK_MESSENGER_PROBE_ONLY=1` as a diagnostics-only mode (default profile `~/.marketplace/browser-profile-messenger`).

## Invariants that were verified to hold

These were traced end-to-end and found sound; findings below are the exceptions.

- **Challenges are never automated or bypassed.** The credential login stops on `captcha` outcomes (`facebook-login.ts` `waitForUsableSession`), never solves a checkpoint, and reports challenge states as typed errors. The Messenger surface additionally distinguishes visible vs dormant captcha markup (`facebook.ts:173-179`, issue #95's diagnosis path). Re-auth leases hand the profile to a human through a loopback noVNC console; the admin server rejects `Origin` headers and non-loopback `Host`, and `launchArgs` exposing remote debugging are refused at construction (`browser.ts:113-115`).
- **Fail-closed session gating.** Every browser tool gates on `ensureUsableSession`; `session_unknown` never proceeds (`facebook-marketplace-backend.ts:215-218`, `facebook-messenger-backend.ts:422-424`). Ambiguous probes stay unknown. Marketplace search fails closed on unrecognized layouts instead of returning empty success.
- **Profile exclusivity during re-auth.** `runExclusive` rejects while a lease is active; `beginInteractive` drains the work queue and generation-guards in-flight launches (`browser.ts:215-243, 541-602`), so a headless context and an interactive context cannot both hold one profile. Startup refuses two scopes sharing a profile directory (`service.ts:216-221`).
- **Grant enforcement for sends.** Production default is deny-all; the HMAC verifier checks signature, scope, action, payload digest, expiry, and consumes atomically via a durable `wx`-create file claim (`authorization.ts:116-166`, `grant-state.ts:57-91`). A resolved send is never reported `sent` without reading the thread for the idempotency token; unconfirmed sends report `unknown` and are never resent (`tools.ts:470-488, 648-669`).
- **Passive GraphQL inbox collection fails closed.** Only cursor-verified complete chains produce a listing; unrecognized, unverified, malformed, body-read-failed, or non-terminal observations are typed errors, never partial success (`facebook-messenger-inbox-graphql.ts`, `facebook-messenger-parse.ts:55-79`). Thread ids are cross-checked as `message_thread:<fbid>` and de-duplicated.
- **Conversation identity is address-verified.** Inbox and thread content is trusted only at the configured path on the configured origin; a redirect to another conversation is a typed error (`facebook-messenger-parse.ts:15-22, 128-133`).
- **Bounded timeouts everywhere** (32-bit `setTimeout` clamp centralized in `timeout.ts`, issues #119/#137/#142); abort signals are threaded through navigation, tasks, and shutdown; teardown paths are bounded and idempotent; the MCP layer validates every output against the tool's declared schema.
- **Log redaction holds.** Diagnostics are structural booleans/counts only (`facebook-marketplace-diagnostics.ts` projects the URL, never echoes it); credentials are held off-instance in a `WeakMap` and never logged, returned, or persisted.

## Confirmed defects

### P1-1 Unbounded automated credential re-submission across failing requests

- **Where:** `facebook-marketplace-backend.ts:245-286` and `facebook-messenger-backend.ts:427-485` (`waitForCredentialLogin` / `startCredentialLogin` / `performCredentialLogin`).
- **Defect:** There is exactly one *de-duplication* of concurrent login attempts (`this.credentialRecovery ?? this.startCredentialLogin()`), but `startCredentialLogin`'s `finally` clears `credentialRecovery` as soon as an attempt settles (`:283`, `:465`). There is no failure counter, no cooldown, and no circuit breaker. Every subsequent tool call whose probe classifies `LOGIN_REQUIRED` starts a **fresh** `FacebookCredentialLogin.attempt`, which re-navigates to the login form and re-types the username and password at human cadence, then polls for up to `FACEBOOK_LOGIN_WAIT_SECONDS` (default 180 s).
- **Failure sequence:** wrong/stale credentials (or a login that never obtains mobile approval) → search fails `LOGIN_REQUIRED` → the next scheduled search (Miso polls searches) probes `LOGIN_REQUIRED` again → new attempt types the password again → repeat indefinitely. Because both scopes read the same `FACEBOOK_USERNAME`/`FACEBOOK_PASSWORD`, a marketplace search and a messenger listing failing concurrently submit credentials **in parallel from two different browser profiles on the same account** — the classic trigger for Facebook checkpoints, captcha, and account lockout. The recovery path for those challenge states is precisely the manual re-auth flow, so the loop converts a stale-password incident into a hard-locked account plus a blocked surface.
- **Validation:** purpose-built simulation against a real headless Chromium (`tests` worktree scratch, synthetic loopback server whose login form always re-serves itself): two consecutive failing `backend.search()` calls produced exactly **two** credential form submissions with no backoff — `credentialSubmissions === 2`, second attempt started immediately after the first settled. (Simulation deleted after the run.)
- **Aggravating context:** the operator explicitly instructed in issue #95 to "refrain from repeated automated credential attempts"; the code cannot comply.
- **Minimal fix:** keep a per-backend failure counter + monotonic cooldown (e.g., exponential from 1 min to the lease max, reset only on a probe that classifies `session_usable` without login), and reuse the cooldown across the marketplace and messenger scopes since they share one account. Attempting credentials while a re-auth lease is active should also be refused outright.

### P2-1 Manual re-auth lease acquisition is blocked by an in-flight credential login

- **Where:** `browser.ts:169-243` (`runExclusive` holds the single work queue for the whole task; `beginInteractive` awaits the queue tail at `:225-227`), combined with the login attempt running as one `runExclusive` task for its entire wait window (`facebook-login.ts:164-181` — the fill *and* the up-to-180 s approval wait share one acquisition).
- **Defect:** the credential-login attempt holds the serialized browser queue for up to `waitMs + navigation + typing` (~183 s default). `POST /reauth/start` → `ReauthManager.startSession()` → `beginInteractive()` cannot resolve until that task settles, so the operator's manual recovery — the designated escape hatch for captcha/checkpoint, i.e., exactly the state a failed login leaves behind — hangs for up to the full login window. The admin HTTP handler awaits `reauth.start()`, so the operator's request appears hung (it will eventually answer; `server.requestTimeout` only bounds receiving the request). This applies independently to both the marketplace and messenger re-auth loops.
- **Failure sequence:** probe reports `LOGIN_REQUIRED` → an automated search starts a 180 s login wait → operator sees `LOGIN_REQUIRED`/`CAPTCHA_REQUIRED` and opens the re-auth console → `POST /reauth/start` blocks behind the login task → operator retries or assumes the service is broken; the lease finally begins up to 3 minutes later.
- **Validation:** simulation with a real `BrowserSessionManager`: an exclusive task held for ~1.2 s; `beginInteractive()` called mid-task had not resolved after 300 ms and resolved only after the task released the queue. Generalizing the hold to the 180 s login wait is direct from `facebook-login.ts` sharing one acquisition for fill+wait.
- **Minimal fix:** split `FacebookCredentialLogin.attempt` so the approval wait does not occupy the exclusive slot (poll via short re-acquisitions, or check `interactive` between polls and abort the attempt when a lease is requested), or have `beginInteractive` abort the backend `loginController` before waiting on the queue. Either way, `/reauth/start` should win priority over an automated login attempt.

### P2-2 Messenger thread reads return an unmarked bounded window; send reconciliation false-negatives on long threads

- **Where:** `facebook-messenger-extract.ts:1-9, 187-222` — `extractMessengerThreadPage` scans `[role="row"]` in document order and stops at `maxMessages = 50` (scan ceiling 120); `domain.ts:86` (`ConversationThreadMessages` has **no** truncation/coverage field, unlike `ThreadsPostPage.truncated` / `ThreadsReplyPage.truncated`); `tools.ts:648-669` — `reconcileSentThread` decides `sent` vs `unknown` by scanning exactly that bounded message array for `[token]`.
- **Defect:** for any thread rendering more than 50 attributed rows, `messenger_thread_read` returns the first 50 rows of the rendered list with no signal that the window is partial. Depending on Facebook's rendering (full render → oldest 50; virtualized bottom window → an arbitrary recent window), consumers receive a partial history presented as the thread. The direct downstream consequence: a **successfully delivered** send whose token row falls outside the window reconciles as `status: 'unknown'`, so on exactly the busy threads that matter, the send contract degrades to permanently-unknown (never resent — safe, but the caller can never confirm delivery), and each retry requires a fresh grant.
- **Validation:** the repository's own test pins the behavior — `tests/facebook-messenger-extract.test.ts` "does not mistake a bounded old message window for the latest reply token" asserts that with 50 earlier rows plus a newest row containing the token, extraction returns 50 messages and the token message is **absent**. The authors know the window is front-capped; the defect is that the contract (schema and reconciliation) does not account for it.
- **Minimal fix:** capture the *last* `maxMessages` rows instead of the first (reverse the scan, preserving chronological order in output), or scroll-to-bottom before extraction, and add a `truncated: boolean` to `ConversationThreadMessages`. Reconciliation should read the tail window regardless.

### P2-3 `marketplace_status` session reporting is scope-blind and can go stale

- **Where:** `service.ts:461` — the only session assessment wired into tools is `toProviderSessionAssessment(browser.getInfo())` of the **marketplace** browser; `facebook-marketplace-backend.ts:181-184` — when `interpretMarketplacePage` returns `LOGIN_REQUIRED`/`CAPTCHA_REQUIRED`/`SESSION_INVALID` for the actual results page, `browser.assessSession()` is not updated.
- **Defect (two facets):**
  1. With `MARKETPLACE_MESSENGER=1`, `facebook_session.status` in `marketplace_status` still reports only the marketplace scope. The messenger scope's browser/probe/assessment (`messengerBrowser`, `messengerProbe`) exists but is surfaced nowhere in the tool contract (the `capabilities` array names backends, not session states). A deployment can report `session_usable` while every messenger tool fails `LOGIN_REQUIRED` — which is, in fact, the current deployed state per issue #95.
  2. The assessment is only written by probes and the login. If the session breaks between the usable probe and the search navigation (expiry, per-page gating, redirect to login), the search correctly fails `LOGIN_REQUIRED`, but the stored assessment stays `session_usable` and `marketplace_status` keeps reporting usable until some later probe runs. A caller polling status to decide whether to retry sees green while every search fails red.
- **Minimal fix:** downgrade the assessment (or at least `session_unknown`) whenever a search/fetch/list/read interpretation yields an auth-class error, and extend `statusOutputSchema` with per-surface session states (e.g., `sessions: {marketplace: …, messenger: …}`) before the messenger surface is relied upon.

### P3-1 Marketplace-surface captcha classification is still text- and hidden-element-sensitive

- **Where:** `facebook.ts:173-179` — for `surface === 'marketplace'`, any `mentionsCaptcha` text match (`getByText(/captcha|…/i)` over the whole page, `facebook.ts:246-248`) or `hasCaptchaFrame` match (`[id*="captcha" i]` matches hidden nodes) yields `CAPTCHA_REQUIRED` / `session_needs_reauth`; the visibility check (`hasVisibleCaptcha`, `facebook.ts:310`) is applied **only** on the messenger branch.
- **Failure sequence:** the Marketplace home page (the probe URL) carries a feed of real listings; a listing title/description or feed text containing "captcha" (e.g., someone selling a captcha-solving gadget, or a seller writing it) makes a perfectly usable session classify as `CAPTCHA_REQUIRED`. Fail-closed, so safe, but it wedges search + status until the text scrolls out of the feed — and the false code points the operator at the wrong recovery (manual captcha clearance) for what is a text-heuristic false positive. Issue #95's diagnostics exist precisely because this class of false positive was suspected on Messenger; the marketplace branch kept the legacy verdict by design (`facebook.ts:175` comment) and never got the same treatment.
- **Minimal fix:** apply the same visibility observation to the marketplace surface (demote hidden-only captcha signals to `session_unknown`), or restrict `mentionsCaptcha` to non-feed containers the way `extractMarketplacePage` already excludes card text from its signals.

### P3-2 A hung context close can orphan Chromium and wedge the persistent profile

- **Where:** `browser.ts:480-512` (`closePersistentContext`) — if `context.close()` does not settle within `settleTimeoutMs`, it falls back to `browser.close()` bounded by `min(settleTimeoutMs, 1 s)`; if that also fails to settle, it only logs ("Persistent browser did not close within the configured timeout"). There is no `browser.process()?.kill()` last resort.
- **Failure sequence:** renderer hung mid-close (known Playwright failure mode) → both closes hang → Chromium process stays alive holding the persistent profile's singleton lock → next `ensureContext` launch on the same profile fails with Chromium's profile-lock error → `lastFailure` set, every tool call returns `UPSTREAM_ERROR: The browser session is not available` until the pod/process restarts. On the PVC-backed deployment, the wedged profile lock is only cleared by process death. Bounded impact (fail-closed, restart recovers), which is why this is P3.
- **Minimal fix:** after the `browser.close()` grace, hard-kill `browser.process()` (SIGKILL) before giving up; `Playwright`'s `Browser` exposes `process()` for `launchPersistentContext`.

### P3-3 `NOT_FOUND` is unreachable for live Messenger reads and prepares

- **Where:** `facebook-messenger-backend.ts:281-284` — `readThread` returns `{thread_id, messages}` or throws; `interpretMessengerThreadPage` (`facebook-messenger-parse.ts:116-161`) has no "unavailable" outcome, so `null` is never returned on the live path. `tools.ts:430-432, 442-445` map `null` to `NOT_FOUND`; `prepareDraft` similarly only returns `null` when `readThread` does.
- **Consequence:** a nonexistent, expired, or malformed thread id surfaces as `UPSTREAM_ERROR` ("the thread page was not reached at the requested thread" / "layout was not recognized") rather than `NOT_FOUND`. The `NOT_FOUND` branch is exercised only by the fixture backend, so tests green-light a contract the live backend cannot produce. Callers cannot distinguish "bad thread id" (permanent, stop retrying) from "page parse failed" (transient/layout, maybe retry) — the exact distinction the error taxonomy exists to preserve.
- **Minimal fix:** classify the known Facebook "thread unavailable" states as an `unavailable` outcome (as the marketplace item path already does for listings) and map it to `NOT_FOUND`.

### P3-4 Thread listing silently caps at 20 with no truncation marker

- **Where:** `facebook-messenger-inbox-graphql.ts:320-329` — `snapshot()` stops collecting at `maxThreads` (20) without marking the observation incomplete; `domain.ts:491` caps the output array at 20; `threadsListInputSchema.limit` ≤ 20.
- **Consequence:** a complete cursor chain over a 35-thread inbox returns 20 threads indistinguishable from a 20-thread inbox. The pagination fail-closed work (#97) verifies the observed chain, but the deliberate cap is silent. The Threads surface returns `truncated`; the Messenger surface has no equivalent, so a consumer cannot know to page or to treat the list as bounded-recent.
- **Minimal fix:** set `incomplete` (or a dedicated `truncated`) when collection stopped at `maxThreads` while the chain had more pages, or document the bound in the tool description and schema.

### P3-5 The profile-collision guard is string-based and misses aliased paths

- **Where:** `service.ts:216-221` — the messenger/marketplace isolation check compares `resolve()`d path strings. `resolve()` does not collapse symlinks or (on case-insensitive filesystems) case differences, so `MESSENGER_PROFILE_DIR` pointing at a symlink (or differently-cased path) to the marketplace profile passes the check and both scopes open the same Chromium profile — shared cookies, shared session, cross-scope contamination: exactly what the boundary document (`docs/provider-action-boundaries.md`, "Account and session isolation") forbids.
- **Minimal fix:** compare `realpathSync` results (creating parent dirs as needed), or additionally assert on a lock file inside each profile directory.

### P3-6 Flaky assertion in the GraphQL flush-deadline test

- **Where:** `tests/facebook-messenger-backend.test.ts:401` — `expect(stalledResponses.size).toBeGreaterThan(0)` asserts background body reads are still in flight at the moment the operation returns; the fixture server clears its tracking set as soon as the stalled connections tear down (which page close triggers immediately after the flush).
- **Validation:** full-suite run failed exactly here (`expected 0 to be greater than 0`); the same test passes in isolation (2.7 s). The production behavior the test protects (bounded flush, correct typed error, elapsed < 15 s) passed in both runs.
- **Minimal fix:** assert on monotonic counters (reads dispatched / completions observed) instead of a point-in-time set size.

## Notes and hypotheses (not confirmed defects)

- **`submitTriggered` is set before `press('Enter')`** (`facebook-messenger-backend.ts:362-363`): an abort between the flag and the keypress reports the send as possibly-in-flight when it was not sent. This errs toward the mandated conservative direction (unknown, never auto-resend); noted for completeness.
- **Interaction between the search deadline and the login wait is correct by design** (issue #64-era fix): the single in-flight attempt is service-scoped and survives the caller's budget via `waitForRequestBudget`; each caller waits only within its own budget. The cost is that during a 180 s login wait, *concurrent* searches on the same scope queue behind the login and time out at `BACKEND_TIMEOUT_MS` — inherent to the one-serialized-browser design, availability-impacting only while login is pending.
- **`messenger_send` on threads whose messages never render attributed rows** (e.g., the article layout) fails before typing with `UPSTREAM_ERROR` — correct fail-closed behavior, but it means the send path has never been proven end-to-end on the deployed DOM (#77 records that thread-page message extraction is unvalidated); #95 keeps the whole surface `status/blocked`. Messenger must be treated as not production-ready, which the audit confirms is justified.
- **`closeInteractive` contains a tautological self-comparison** (`browser.ts:324-325`: `pendingLaunch` is compared against the field it was just read from). Harmless today (single-threaded sync section); worth simplifying if touched.
- **Two browser sessions double resource usage** (one Chromium per scope once Messenger is enabled). Deliberate isolation trade-off per the boundary document; noted for capacity planning.

## Related existing issues

- #95 (open, P1, blocked) — deployed Messenger blocked at authentication; records the CAPTCHA-vs-dormant-markup question, the operator's "no repeated automated credential attempts" instruction (violated by P1-1), and the deployed profile/PVC layout. P1-1 and P2-1 are directly actionable follow-ups to it.
- #43 (open, umbrella) / #79 (open, blocked) — seller messaging and bounded personal-message search; P2-2, P3-3, P3-4 are contract-level blockers to file under it before any Messenger go-live.
- #64 (closed) / #97 (merged) — passive GraphQL inbox listing and pagination fail-closed; the collector itself audited sound here; P3-4 is its remaining silent bound.
- #88 (closed) — probe-only `SURFACE_DISABLED` semantics; verified correct.
- #80/#42 (open/blocked) — deployed search-layout resilience; P3-1's text-sensitive captcha classification is in this family.

## Validation record

- Full suite at `9af629e`: **813/814 pass** (`npm test`, Node 24.21, real Chromium); the single failure is the flaky assertion in P3-6, which passes in isolation.
- Purpose-built simulations (real `BrowserSessionManager` + headless Chromium + synthetic loopback servers, in a disposable worktree, since deleted): P1-1 (two credential submissions across two failing searches, no cooldown) and P2-1 (`beginInteractive` blocked for the duration of a long exclusive task).
- P2-2 validated against the repository's own pinned behavior in `tests/facebook-messenger-extract.test.ts`.
- All other findings are confirmed by direct code trace with the cited lines; each was checked against the current `origin/main`, not the stale local checkout.
