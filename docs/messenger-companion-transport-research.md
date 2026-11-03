# Messenger Companion transport: clean-room reconstruction feasibility (#188)

Parent: #38 (capability map). Sibling records: [`messenger-consumer-research.md`](messenger-consumer-research.md) (consumer access-path decision), [`messenger-consumer-inbox-research.md`](messenger-consumer-inbox-research.md) (#78 ordinary-inbox discovery no-go), [`messenger-personal-search-design.md`](messenger-personal-search-design.md) (#79; #186 shipped `consumer_threads_list`/`consumer_threads_search` over the verified header menu). Status: **decision record, two separate questions.** (A) Reconstructing Muse's `messenger_companion` protocol — **NO-GO** on current evidence. (B) A self-hosted Messenger capability independent of the Companion protocol — **evaluated by #193 (2026-11-03): technically feasible via `mautrix-meta`; GO as an experimental, disabled-by-default, explicit opt-in provider under the operator's bounded exception (#193, 2026-11-02), with #195 as the implementation/proof issue. Browser-backed Messenger remains the default and fallback**; see [`mautrix-meta-transport-evaluation.md`](mautrix-meta-transport-evaluation.md). This document builds nothing, adds no dependency, and changes no tool surface. External evidence captured 2026-11-02 from the cited public repositories at the pinned revisions and from the cited web sources. *Revision note (2026-11-02, post-review): the first version over-generalized the Companion NO-GO into the capability question; §5 now covers `mautrix-meta` directly from current source, §7 separates the two decisions, and the earlier "no maintained open-source implementation" claim is retracted.*

## 1. The question

The 2026-10-31 Muse contract audit found Muse's full personal-Messenger feature set is **not** built on the browser path this repo uses. Muse exposes a `messenger_read` connector backed by a companion auth mode, a 30-minute retained-data sync, contacts/threads/messages/search/call-history reads, and send/edit/unsend/react/group/poll writes, fronted by `hatch_messenger_cli`. The question #188 asks is not "how do we scrape more Messenger DOM?" but:

> Can the underlying Messenger Companion/provider transport be reconstructed independently and run locally, without Muse infrastructure?

The scope is clean-room and static: inventory the public evidence, separate the transport layers, decide which layer holds E2EE/device state, and give a GO/NO-GO for a self-hosted implementation.

## 2. Sources inventoried

| Source | What it is | Layer reach |
|---|---|---|
| [sneakers-the-rat/muse-skills](https://github.com/sneakers-the-rat/muse-skills) @ `03bbf91` | Automated hourly snapshot of a running Muse image's skills, prompts, and strings, plus files extracted from the `hatch` binary, with a per-file provenance manifest (`binary-map.json`). This is the "Muse runtime export" material for this research. | Client-facing connector surface (skills, connector manifests, product-doc mirrors) and **identifier-level** traces of the VM-internal machinery. No wire protocol. |
| [nikships/muse-cli](https://github.com/nikships/muse-cli) @ `2e42aec` | MIT-licensed Python CLI (86★) that speaks the muse.ai gateway protocol directly, derived from the web client bundle and verified live. Ships [`docs/PROTOCOL.md`](https://github.com/nikships/muse-cli/blob/2e42aeccbef71437f4ccd4faa626414f2461be7b/docs/PROTOCOL.md) and a 258-method [`routes.json`](https://github.com/nikships/muse-cli/blob/2e42aeccbef71437f4ccd4faa626414f2461be7b/src/muse_cli/routes.json). | **Muse gateway only** (layer 2 below), fully. Requires a real Muse account: it authenticates with the user's own `hatch_sess` cookies and reaches a personal VM. It is not a Messenger transport. |
| Meta public protocol material | Signal-protocol basis of Messenger E2EE ([Signal, 2016](https://signal.org/blog/facebook-messenger/)), default E2EE for personal Messenger ([Meta, Dec 2023](https://about.fb.com/news/2023/12/default-end-to-end-encryption-on-messenger/)), and a "Messenger End-to-End Encryption Overview" technical report (cited in academic literature; descriptive, not an implementable client contract). | Protocol *description* of the E2EE layer. No device-registration, pairing, or client wire contract. |
| [mautrix/meta](https://github.com/mautrix/meta) ("mautrix-meta") @ `9c4954a7` | AGPL-3.0 Go bridge (active; head dated 2026-11-02) connecting Facebook Messenger and Instagram DMs to Matrix. Substantial current-source Messenger support: native iOS/Android login, E2EE device registration, secure-history PIN recovery, history backfill, sends/edits/unsends/reactions/read receipts, membership ops, Marketplace threads. | **Layer 4, independently of Muse** — an open-source implementation of a provider-facing Messenger transport (see §5). |
| Independent wrappers | [m008v/fbchat-v2](https://github.com/m008v/fbchat-v2) (139★, Apache-2.0, active) wraps `mautrix-meta` as a git submodule behind a Python API and its Go E2EE bridge; [HerokeyVN/FB-Messenger-E2EE](https://github.com/HerokeyVN/FB-Messenger-E2EE) (13★, AGPL-3.0, early-stage) is an independent Noise/Signal toolkit. Both authenticate with the **user's own Facebook session** (cookies/`appState`); fbchat-v2 additionally offers native flows only through the vendored bridge. | Fragments of layer 4; fbchat-v2 adds nothing over its upstream transport. |

Method note: #188 forbids inferring a provider API merely because Muse exposes a command, and forbids recording anything not supported by public evidence. Everything below is quoted or sha-pinned to the listed sources; binary-string findings are labeled as such — they are identifier-level traces extracted from the Muse image, not observed wire traffic.

## 3. Layer separation (source-backed)

```
 Muse client (web / iOS / Android / Mac)                muse-cli (independent RE client)
      │  HTTPS muse.ai; browser cookies (hatch_sess)          │  same chain, own cookies
      │  POST /api/auth/check → access_token                   │
      │  POST /api/hatch/token {vmAddress, vmName}             │
      │  GET  /api/session → assigned VM id                    │
      ▼                                                        ▼
 wss://hatch.metaaivm.com/v1/noise?vm_id=..&auth_token=..   ← LAYER 2: Muse/Hatch gateway
 │  Noise_XX_25519_AESGCM_SHA256; protobuf ServiceRequest/Response        (fully RE'd by muse-cli)
 │  services: daemon 0, sentinel 1, vault 2, authd 3
 ▼
 Personal VM (Meta-hosted, hatch runtime) ─────────────────────────────────────────────────
 │  CLIENT-FACING daemon routes (from muse-cli routes.json + muse-skills daemon strings):
 │    GET  /connectors/{id}/connect/info      connector connect URL (companion connect flow)
 │    GET  /api/messenger_companion/pin-status "Checks whether Messenger companion can
 │                                            provide a PIN for unlocking" (daemon string)
 │    POST /api/messenger_companion/unlock    "Unlock Messenger companion encryption keys"
 │                                            (daemon string); /messenger-read/unlock is the
 │                                            documented-deprecated variant
 │    GET  /api/messenger/fb-check
 │    /channels/{status,link,unlink}          side chat: separate polling channel via
 │                                            agent.meta.ai/connect/channel (poll_interval_ms,
 │                                            default 3000, 1–60000)
 │    muse.exec → /opt/hatch/bin/hatch_messenger_cli   the connector's CLI runs IN the VM;
 │                                            the skill forbids reading local storage directly
 ▼
 messenger worker (in-VM, proprietary)  ← LAYER 3 | LAYER 4 boundary
 │  LAYER 3 — retained store & sync: retained snapshot of contacts/threads/messages/call-logs
 │            with `_cache.*` bookkeeping (`_cache.self_user_id`, `_cache.gaps`,
 │            `_cache.oldest_cached_ts`, `_cache.cached_thread_count`); sync fetch kind
 │            `connector_sync_messenger`, cadence 1800 s; `repair` "refreshes keys once,
 │            retries retained ciphertext"; per-row `(decrypt failed)` / `(no thread key)`
 │            states; internal hatch paths incl. `/hatch/fb/messenger-cli/e2ee/pin-status`
 │            (binary-string evidence)
 ▼
 LAYER 4 — Muse's provider-facing Messenger transport: NO PUBLIC EVIDENCE for Muse's own
           implementation. (The layer class itself has an independent open-source
           implementation — `mautrix-meta`, §5; what is private is Muse's.) The unlock
           error surface shows Meta-facing handshake behavior: `two_factor_required`,
           `write_connect_failed`, "Messenger returned an incomplete unlock response",
           "Messenger returned an invalid unlock response", "Messenger could not decrypt…"
           (binary-string evidence). No endpoint, payload, key-handling, or sync-fetch
           contract of Muse's appears in any public source.
```

Layer ownership and the E2EE/device-state answer:

1. **Layer 1 — client/account-link UI and PIN/session bootstrap.** The Muse client obtains the connect URL through the gateway (`connectors.connect_info`); the companion connect flow rides Meta's connector/OAuth surface — binary strings show `auth.meta.com` and `accountscenter.meta.com/connectors/` path shapes (`/connect/…`, `service`, `response_type`, `client_id`, `return_uri`, `auth_intent`). The PIN is verified through the VM's `pin-status`/`unlock` routes; the daemon's own description strings say unlock **unlocks "Messenger companion encryption keys"**. The connector manifest declares `auth.provider: messenger_companion`, `auth.connect: companion`, and `availability.confidential_vm: true` — the companion keys are custody inside the Meta-hosted VM, PIN-gated, consistent with the product docs' confidential-VM "Encryption (recovery PIN)" settings surface.
2. **Layer 2 — Muse/Hatch gateway.** Fully reverse-engineered and documented by muse-cli: HTTPS auth chain, Noise-XX WebSocket, protobuf envelopes, 258 methods, framing quirks. The gateway exposes **no dedicated Messenger message-data route** in `routes.json`, although the Messenger connector's own lifecycle routes (connect info, PIN status/unlock, `fb-check`) do; Messenger content is obtained indirectly through `muse.exec` running `hatch_messenger_cli` *inside the VM*, whose output traverses the gateway as exec results.
3. **Layer 3 — retained store and sync.** VM-internal. The connector skill describes an incrementally-synced retained snapshot (`sync both` "is incremental and fills gaps"; `--since-days` widens reach), gap bookkeeping, and a local key-repair path for retained ciphertext. The sync is a server-side (`workers: [messenger]`) 30-minute cadence — the agent surface never initiates fetches.
4. **Layer 4 — the actual provider-facing Messenger transport.** Proprietary, in-VM, and absent from every public source. muse-skills is skill/prompt/string text, not wire capture; muse-cli never touches this layer; Meta's public material describes E2EE *design*, not a client contract; the independent reconstructions below reach only a fragment of it.

## 4. What the public evidence does and does not give

**Given (sha-pinned):** the full connector agent contract (`CONNECTOR.md`), its manifest (identifier shapes `cid.c.<viewer>:<contact>`, `cid.g.<id>`, `mid.$…`, `otid`, `is_e2ee`, `_cache.*` fields; full CLI subcommand list including `unlock`; per-action permission methods `messages.read/compose/edit`, `contacts.read`, `calls.read`, `participants.manage`, `thread_admins.manage` with `fresh_consent_only` approval policy), the gateway protocol and 258-method route table, the daemon's client-facing Messenger/connector routes, the side-chat polling channel, and product-doc descriptions of the settings/consent surfaces.

**Not given (the missing private dependencies):**

- The **companion pairing/unlock handshake** between the VM's messenger worker and Meta: what the PIN unlocks in protocol terms, how `two_factor_required` is resolved, what "write connection setup" performs after a successful unlock, and what `messenger_companion` registration entails on Meta's side. Only route names, one-line daemon descriptions, and error strings are public.
- The **sync fetch protocol** behind `connector_sync_messenger` (how a sync session is established against Meta, pagination, key distribution to the retained store).
- The **device/E2EE client implementation** with current default-E2EE semantics as Muse deploys it: Meta's technical report describes the design and no official client contract exists, but an independent open-source implementation of the transport class does (§5, `mautrix-meta`) — what remains private is the *companion* pairing/sync layer above it.

## 5. Independent implementations of the provider transport: `mautrix-meta`

The first version of this section surveyed only fbchat-lineage wrappers and wrongly concluded that no maintained open-source implementation of the provider transport exists. That was wrong, and it mattered: **the goal is not to reproduce Muse Companion byte-for-byte — it is to reproduce Muse-like Messenger capabilities locally.** If an independent, maintained provider transport already exists, the missing Companion protocol may be irrelevant. [mautrix/meta](https://github.com/mautrix/meta) ("mautrix-meta") is exactly that, verified in current source (head `9c4954a7`, dated 2026-11-02 — the repo receives same-day commits):

**Verified in current source:**

- **Auth modes.** `pkg/connector/login.go` `CreateLogin()` exposes four flows: `facebook` and `messenger` (cookie login) plus `messenger-lite` (native iOS) and `messenger-lite-android` (native Android), the latter two returning a `MetaNativeLogin` that performs **native username/password authentication** with a device-bound session (`NativeSession` carrying access token, app ID, device/family device IDs). The claim that all usable open-source transports require exported browser session cookies is **false**.
- **E2EE and device state.** `pkg/messagix/e2ee-client.go` and `e2ee-register.go` implement E2EE device registration and the encrypted pipeline; the ROADMAP records "Messenger encryption" as supported in both directions, on top of the unencrypted surface (text/media/replies/formatting both ways, edits, reactions, unsend, read receipts, typing, membership add/remove/leave, chat metadata, and **message history** inbound).
- **Secure-history PIN recovery.** `pkg/messagix/securehistory/` implements Messenger's secure-history protocol independently: enrollment, epochs, OPAQUE-based PIN verification and `RecoverPIN` against the recovery server (`vesta.go`, with its own `vesta.proto`), i.e. the same capability class as Muse's PIN-gated key unlock, reconstructed in the open.
- **History backfill and Marketplace.** `syncManager.go` manages sync groups with per-group key stores (`socket.KeyStoreData`); `table/enums.go` carries `MARKETPLACE` thread types (`MARKETPLACE_SEND_MESSAGE = 1245186`), and the connector config exposes a `marketplace_space` option — Marketplace chats are part of the surface.
- **Maintenance and provenance.** AGPL-3.0 (with exceptions granted only to Beeper and Element), part of the maintained mautrix family, with a published authentication guide (docs.mau.fi). `fbchat-v2`'s Go E2EE bridge is not an independent transport: its README lists `meta/` as a **git submodule of mautrix-meta** — fbchat-v2 is a Python wrapper over mautrix-meta's transport, so quality claims for the underlying transport route to upstream.

**What `mautrix-meta` does not give, and open feasibility questions** (bounded as issue #193):

1. **Package boundary.** The low-level client `pkg/messagix` is Matrix-free for its transport/crypto/sync core (socket, e2ee, securehistory, table, syncManager), and the repo itself ships a non-Matrix driver (`cmd/lscli`). A small set of files leaks `bridgev2` login-UX shapes (`LoginStep`/`RespError`): at the reviewed head `9c4954a7`, `grep -rl bridgev2 pkg/messagix` matches five files, of which four carry real type dependencies (`messengerlite.go`, `loginerrors/errors.go`, `bloks/selenium.go`, `bloks/selenium_platform.go`) and one matches only in a comment (`bloks/cmd/main.go`, itself a standalone debug command outside the library surface). The shim is accordingly small, but the set drifts with upstream — enumerate at your own pinned SHA (`grep -rl bridgev2 pkg/messagix`) rather than trusting this count. #193 quantifies the shim and also assesses a non-Matrix host for `pkg/connector`'s `MetaConnector`.
2. **Native-login durability.** Whether native `messenger-lite` sessions survive checkpoint/2FA events and token invalidation in practice is a live-validation question, not answerable from source alone.
3. **ToS/account risk.** Native login does **not** remove the Meta ToS §3.2(3) "automated means" exposure — it removes only the credential-export aggravator of the cookie path. The standing rejection of "unofficial protocol libraries" (`messenger-consumer-research.md` §2) covers this class and only the operator can change that boundary decision; the evaluation must weigh it explicitly rather than inherit it silently.
4. **License.** AGPL-3.0 has different consequences for embedding/modifying inside Musebridge (license adoption; modified source must be published) versus running it as a separate unmodified service (aggregation) versus a modified separate service (AGPL §13 source offer). Musebridge currently carries no license field; the boundary must be decided before any code lands.
5. **State.** The bridge persists sync-group key stores, a socket database, and bridge DB state — content-bearing local persistence that this repo's no-index rule currently forbids. A stateless design or a deliberate operator exception must be chosen, not defaulted. *Correction (2026-11-03, from #193's source reading): this overstated the persistence — `socket.KeyStoreData` holds thread-range pagination keys, not crypto keys, `pkg/messagix` itself writes no database or files, and the bridge-side stores hold mappings and cursors, not message text (`mautrix-meta-transport-evaluation.md` §5). A read-only use can satisfy the no-content rule without an exception; the session-shape and key-material handling still need an explicit contract.*

**Net:** `mautrix-meta` is a serious, maintained, independent implementation of the layer-4 transport class this research was told was missing. It does not make the Companion protocol reconstructable (§7 decision A stands), but it means a self-hosted Messenger capability does not depend on the Companion protocol at all.

## 6. Comparison against Musebridge's existing contract

The shipped header-menu tools (#186) and the Companion transport are not substitutes; the comparison records exactly what a GO would be buying and at what cost:

| Property | `consumer_threads_list` / `consumer_threads_search` (shipped) | Muse Companion transport (this research) |
|---|---|---|
| Source | One authenticated header-menu load, verified non-opening across two loads (#79 evidence record) | In-VM worker's retained snapshot, 30-min background sync |
| Coverage | Recent window; `complete: false` is a permanent, disclosed state; no pagination | Full retained history incl. contacts, call logs, polls; `_cache.gaps`-driven backfill |
| Side effects | None observed beyond the caller's own unread badge (disclosed) | PIN unlock, 2FA-capable handshake, background sync, receipt-capable writes |
| Writes | None (read-only; drafts/send remain #62/#63 territory) | send/edit/unsend/react/poll/participants/admins |
| E2EE handling | Route provenance only (`route: 'e2ee'`, never rewritten) | Key custody in the VM; PIN-gated unlock; local repair of retained ciphertext |
| Persistence | Stateless per call; no index | Retained store on Meta-hosted VM |
| Dependencies | Operator's own browser session | Muse subscription + hosted VM + private Meta companion backend |

The Companion surface's differentiators are capability classes this repo currently keeps out — full-history retention is the privacy regression `messenger-consumer-research.md` §4 rejects ("Musebridge holds no index and must not build one"), and unattended sends are deny-all pending #63's verifier. After the review revision these are **design inputs for the feasibility evaluation** (#193: a stateless design, or a deliberate operator exception for a stateful transport), not grounds for closing the capability question — an independent transport changes what is buildable, and the boundary decisions can be taken per capability with the operator.

## 7. Decision

### Decision A — reconstructing the Muse `messenger_companion` protocol: **NO-GO**

Reproducing Muse's specific companion pairing/sync protocol is a NO-GO on current evidence, and #188's Companion-protocol question closes here.

Grounds, in order of independence:

1. **Missing private dependency (dispositive).** The companion auth/pairing/unlock handshake and the `connector_sync_messenger` fetch protocol are private to Meta and Muse. The public record gives their identifiers and one-line descriptions, not their semantics. A clean-room implementation has nothing to implement against; #188 forbids inferring a provider API from the existence of a command.
2. **No need.** With `mautrix-meta` independently implementing the provider transport (§5), reproducing the Companion protocol byte-for-byte buys nothing for the actual goal of Muse-like capabilities on OpenClaw/MCP.

**Reconsideration triggers for A:** Meta documents or sanctions a companion/connector protocol for personal Messenger accounts reachable without a Muse VM, or the missing handshake semantics otherwise become public.

### Decision B — a self-hosted Messenger capability independent of Muse: **evaluated by #193; GO as an experimental, opt-in `mautrix-meta` provider (#195)**

**Update (2026-11-03): #193 concluded the transport is technically feasible, and the operator's decision of 2026-11-02 (#193) grants a narrow bounded exception: GO for an experimental, disabled-by-default, explicit opt-in `mautrix-meta` provider, requiring explicit provider selection and explicit operator acknowledgement of the Meta account-risk boundary. Browser-backed Messenger remains the default and fallback; the first implementation is read-only, with writes still separately gated; #195 is the implementation/proof issue. See [`mautrix-meta-transport-evaluation.md`](mautrix-meta-transport-evaluation.md) §9. This is not blanket approval for arbitrary unofficial or private Meta APIs; the standing rejection in `messenger-consumer-research.md` §2 stays the default policy.** The paragraphs below are the question as this document opened it, kept for the record.

The capability question is explicitly **not closed by this document**, and #188 must not be read as deciding it. `mautrix-meta` (§5) is an actively maintained, AGPL-3.0, open-source implementation of the provider-facing transport — including native username/password login, E2EE device registration, secure-history PIN recovery, encrypted history backfill, and Marketplace threads — i.e., the layer this research originally reported as missing.

Whether to adopt it is a bounded feasibility evaluation, opened as **#193**, which must answer at least:

- Can `mautrix-meta`'s lower-level Messenger packages be consumed without running a Matrix bridge (shim size for the `bridgev2`-leaking files, re-enumerated at the pinned upstream SHA; or a non-Matrix host for `MetaConnector`)?
- Which auth modes work today, especially native `messenger-lite`/`messenger-lite-android`?
- What read/history/search capabilities can be exposed cleanly through bounded MCP tools with this repo's coverage-truthfulness contracts?
- What local state and key material it persists, and whether that means a stateless design or a deliberate operator exception to the no-content-persistence rule.
- What ToS/account risk remains with native login (the automated-means exposure does not vanish; the standing unofficial-library rejection is a boundary-contract decision that only the operator can change).
- AGPL-3.0 implications for embedding/modifying versus running it as a separate service.
- Whether direct use beats borrowing `fbchat-v2`'s wrapper (which merely vendors mautrix-meta).

#193 carries the synthetic-first gate and the hard boundaries (no credential export, no challenge automation, no Muse dependency). Its GO outcome opens one bounded implementation/proof issue with an explicit auth/session/data contract and synthetic tests before any live validation; its NO-GO outcome documents the blockers, leaving the shipped header-menu tools as the only personal-Messenger surface.

## 8. Verified vs assumed

**Verified (public sources, captured 2026-11-02):** every route, manifest field, daemon description string, and CLI contract quoted above, at the pinned revisions; muse-cli's gateway protocol description as published; `mautrix-meta`'s login flows, E2EE/secure-history/Marketplace surface, package layout, license, and maintenance currency, read directly from source at head `9c4954a7` (including that `fbchat-v2` vendors it as a git submodule); the Signal-protocol basis and default-E2EE status of Messenger; #186's shipment of `consumer_threads_list`/`consumer_threads_search` (git `cb768c5`).

**Assumed / unverified (must not be treated as fact):** the *semantics* behind the Muse PIN/unlock routes and error strings (which side issues the PIN — the daemon string reads "checks whether Messenger companion **can provide** a PIN", leaving client-entered vs companion-issued open — is unresolved here); whether the messenger worker's Meta-facing transport is MQTT-, push-, or poll-based; whether Muse's retained-store identifier shapes (`cid.*`, `mid.$…`) match what the transport actually carries; how durable `mautrix-meta`'s native-login sessions are against checkpoint/2FA/invalidation in practice (source shows the flows, not their live behavior — a #193 live-validation item); whether `mautrix-meta`'s behavior holds on Meta's next internal change (unversioned provider API); and whether Muse's connector surface will change (muse-skills is a moving snapshot; muse-cli's README warns the API is unversioned).

**Deliberate gaps:** no live probing of Muse, Meta, `mautrix-meta`, or any third-party project (static/clean-room only, per #188); no credentials, cookies, keys, message content, or account identifiers were extracted or published; the audit's exact wire-level claims were not independently reproduced — this document cites the public artifacts rather than re-deriving them.

## 9. Cross-links

[`messenger-consumer-research.md`](messenger-consumer-research.md) (consumer access-path decision and API/E2EE record) · [`messenger-consumer-inbox-research.md`](messenger-consumer-inbox-research.md) (#78 no-go) · [`messenger-personal-search-design.md`](messenger-personal-search-design.md) (#79 contract; #186 implementation) · [`capability-inventory.md`](capability-inventory.md) (#39 evidence legend) · [`provider-action-boundaries.md`](provider-action-boundaries.md) (normative risk classes) · parent #38.
