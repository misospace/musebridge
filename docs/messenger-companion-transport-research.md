# Messenger Companion transport: clean-room reconstruction feasibility (#188)

Parent: #38 (capability map). Sibling records: [`messenger-consumer-research.md`](messenger-consumer-research.md) (consumer access-path decision), [`messenger-consumer-inbox-research.md`](messenger-consumer-inbox-research.md) (#78 ordinary-inbox discovery no-go), [`messenger-personal-search-design.md`](messenger-personal-search-design.md) (#79; #186 shipped `consumer_threads_list`/`consumer_threads_search` over the verified header menu). Status: **decision record — evidence-based NO-GO.** This document builds nothing, adds no dependency, and changes no tool surface. External evidence captured 2026-11-02 from the cited public repositories at the pinned revisions and from the cited web sources.

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
| Independent transport reconstructions | [m008v/fbchat-v2](https://github.com/m008v/fbchat-v2) (139★, Apache-2.0, active; Python MQTT listener plus a Go JSON-RPC bridge claiming E2EE "Secret Conversations" receipt/decryption) and [HerokeyVN/FB-Messenger-E2EE](https://github.com/HerokeyVN/FB-Messenger-E2EE) (13★, AGPL-3.0, early-stage; TypeScript Noise/Signal toolkit with device store and prekey maintenance). Both authenticate by exporting the **user's own Facebook session** (cookies / `appState`). | Partial reconstruction of the *raw client transport's* receive path — explicitly not the companion pairing. Unofficial; both warn of breakage on Meta changes. |

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
 LAYER 4 — provider-facing Messenger transport: NO PUBLIC EVIDENCE. The unlock error surface
           alone shows Meta-facing handshake behavior: `two_factor_required`,
           `write_connect_failed`, "Messenger returned an incomplete unlock response",
           "Messenger returned an invalid unlock response", "Messenger could not decrypt…"
           (binary-string evidence). No endpoint, payload, key-handling, or sync-fetch
           contract appears in any public source.
```

Layer ownership and the E2EE/device-state answer:

1. **Layer 1 — client/account-link UI and PIN/session bootstrap.** The Muse client obtains the connect URL through the gateway (`connectors.connect_info`); the companion connect flow rides Meta's connector/OAuth surface — binary strings show `auth.meta.com` and `accountscenter.meta.com/connectors/` path shapes (`/connect/…`, `service`, `response_type`, `client_id`, `return_uri`, `auth_intent`). The PIN is verified through the VM's `pin-status`/`unlock` routes; the daemon's own description strings say unlock **unlocks "Messenger companion encryption keys"**. The connector manifest declares `auth.provider: messenger_companion`, `auth.connect: companion`, and `availability.confidential_vm: true` — the companion keys are custody inside the Meta-hosted VM, PIN-gated, consistent with the product docs' confidential-VM "Encryption (recovery PIN)" settings surface.
2. **Layer 2 — Muse/Hatch gateway.** Fully reverse-engineered and documented by muse-cli: HTTPS auth chain, Noise-XX WebSocket, protobuf envelopes, 258 methods, framing quirks. Nothing Messenger-specific crosses it: no message-data route exists in `routes.json`. Message content reaches the client only through `muse.exec` running `hatch_messenger_cli` *inside the VM*, or not at all.
3. **Layer 3 — retained store and sync.** VM-internal. The connector skill describes an incrementally-synced retained snapshot (`sync both` "is incremental and fills gaps"; `--since-days` widens reach), gap bookkeeping, and a local key-repair path for retained ciphertext. The sync is a server-side (`workers: [messenger]`) 30-minute cadence — the agent surface never initiates fetches.
4. **Layer 4 — the actual provider-facing Messenger transport.** Proprietary, in-VM, and absent from every public source. muse-skills is skill/prompt/string text, not wire capture; muse-cli never touches this layer; Meta's public material describes E2EE *design*, not a client contract; the independent reconstructions below reach only a fragment of it.

## 4. What the public evidence does and does not give

**Given (sha-pinned):** the full connector agent contract (`CONNECTOR.md`), its manifest (identifier shapes `cid.c.<viewer>:<contact>`, `cid.g.<id>`, `mid.$…`, `otid`, `is_e2ee`, `_cache.*` fields; full CLI subcommand list including `unlock`; per-action permission methods `messages.read/compose/edit`, `contacts.read`, `calls.read`, `participants.manage`, `thread_admins.manage` with `fresh_consent_only` approval policy), the gateway protocol and 258-method route table, the daemon's client-facing Messenger/connector routes, the side-chat polling channel, and product-doc descriptions of the settings/consent surfaces.

**Not given (the missing private dependencies):**

- The **companion pairing/unlock handshake** between the VM's messenger worker and Meta: what the PIN unlocks in protocol terms, how `two_factor_required` is resolved, what "write connection setup" performs after a successful unlock, and what `messenger_companion` registration entails on Meta's side. Only route names, one-line daemon descriptions, and error strings are public.
- The **sync fetch protocol** behind `connector_sync_messenger` (how a sync session is established against Meta, pagination, key distribution to the retained store).
- The **device/E2EE client implementation** with current default-E2EE semantics: Meta's technical report describes the design; no official client contract or maintained open-source implementation exists.

## 5. Independently published transport reconstructions — why they do not change the answer

Two public projects partially reconstruct the raw transport's receive path, and #188 requires taking them seriously rather than assuming absence:

- [m008v/fbchat-v2](https://github.com/m008v/fbchat-v2) is the maintained fbchat lineage: MQTT listener plus a Go bridge claiming E2EE ("Secret Conversations") message receipt/decryption, Apache-2.0, actively patched. It is unofficial, requires the user's own session cookies, and warns features "may break when Facebook changes things".
- [HerokeyVN/FB-Messenger-E2EE](https://github.com/HerokeyVN/FB-Messenger-E2EE) implements Noise/Signal session machinery (prekeys, sender keys, device store) bootstrapped from Facebook `appState` cookies. Early-stage (13★), AGPL-3.0, real-account testing by design.

Why this is still **not** an implementable provider protocol for Musebridge:

1. **Both are session-credential automation.** They authenticate by exporting the operator's own Facebook session (cookies/`appState`) into a programmatic client. That is the exact path this repo's standing decision record already rejects — `messenger-consumer-research.md` §2: "Unofficial protocol libraries / scrapers … **Rejected** — ToS violation and ban risk" (Meta ToS §3.2(3), Developer Policies §8.2(a)) — and it fails #188's own hard boundaries (no credential automation, no speculative live-account scraping).
2. **Neither implements the companion layer.** There is no public reconstruction of `messenger_companion` pairing, PIN unlock, or the connector-sync registration; these projects are plain clients for one's own account, not connector-protocol peers. Muse's differentiators (retained full-history sync including contacts and call logs, write operations) live behind that private layer.
3. **Maturity is thin.** Two small projects, one of them explicitly early-stage, against a provider that changes internals without notice (muse-cli's own README carries the same warning for the *Muse* API). A Musebridge dependency on either would inherit unversioned breakage with no sanction.

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

The Companion surface's gains are exactly the capability classes this repo keeps out on standing decisions: full-history message/contacts/calls retention is the privacy regression `messenger-consumer-research.md` §4 rejects ("Musebridge holds no index and must not build one"), and unattended sends are deny-all pending #63's verifier.

## 7. Decision: NO-GO

**A self-hosted implementation of the Messenger Companion transport independent of Muse is a NO-GO on current evidence.** The GO branch of #188 is not triggered; no implementation issue is opened.

Grounds, in order of independence:

1. **Missing private dependency (dispositive).** The companion auth/pairing/unlock contract and the `connector_sync_messenger` fetch protocol are private to Meta and Muse. The public record gives their identifiers and one-line descriptions, not their semantics. A clean-room implementation has nothing to implement against; #188 forbids inferring a provider API from the existence of a command.
2. **The only open-source path to the raw transport is the path already rejected.** The functioning public reconstructions of Messenger's client transport (including its E2EE receive path) all run on exported session credentials of the operator's own account — the "Unofficial protocol libraries / scrapers" class `messenger-consumer-research.md` rejects on ToS/ban grounds, and a hard-boundary violation for #188 regardless.
3. **Capability/risk asymmetry.** What the transport would add over the shipped header-menu surface is precisely full-history retention and unattended writes — both excluded by standing decisions. The narrow, proven, non-opening browser capabilities remain the operator-sanctioned surface.

**Consequences, per the issue's NO-GO branch:** full-history Messenger/contacts/call-history stays out of Musebridge; no connector-surface expansion; the personal-Messenger Playwright surface stays as bounded in #79/#186; no Muse dependency is introduced.

**Reconsideration triggers** (what would flip this to GO, each independently sufficient only with an operator risk acknowledgment for protocol-level account automation):

- Meta documents or sanctions a companion/connector protocol for personal Messenger accounts reachable without a Muse VM (e.g., a third-party connector program with a real contract).
- A maintained, independently auditable open-source implementation of the companion auth + provider transport exists that does not require exporting user session credentials, and the missing handshake semantics above become public.
- Musebridge's standing ToS/risk position on unofficial protocol clients changes by explicit operator decision — a boundary-contract change, not a connector change, and it cannot be smuggled in under a research ticket.

## 8. Verified vs assumed

**Verified (public sources, captured 2026-11-02):** every route, manifest field, daemon description string, and CLI contract quoted above, at the pinned revisions; muse-cli's gateway protocol description as published; the existence and claims of the two independent reconstruction projects; the Signal-protocol basis and default-E2EE status of Messenger; #186's shipment of `consumer_threads_list`/`consumer_threads_search` (git `cb768c5`).

**Assumed / unverified (must not be treated as fact):** the *semantics* behind the PIN/unlock routes and error strings (which side issues the PIN — the daemon string reads "checks whether Messenger companion **can provide** a PIN", leaving client-entered vs companion-issued open — is unresolved here); whether the messenger worker's Meta-facing transport is MQTT-, push-, or poll-based; whether Muse's retained-store identifier shapes (`cid.*`, `mid.$…`) match what the transport actually carries; the current maintenance truth of the third-party reconstructions beyond their repos' own claims; and whether Muse's connector surface will change (muse-skills is a moving snapshot; muse-cli's README warns the API is unversioned).

**Deliberate gaps:** no live probing of Muse, Meta, or the third-party projects (static/clean-room only, per #188); no credentials, cookies, keys, message content, or account identifiers were extracted or published; the audit's exact wire-level claims were not independently reproduced — this document cites the public artifacts rather than re-deriving them.

## 9. Cross-links

[`messenger-consumer-research.md`](messenger-consumer-research.md) (consumer access-path decision and API/E2EE record) · [`messenger-consumer-inbox-research.md`](messenger-consumer-inbox-research.md) (#78 no-go) · [`messenger-personal-search-design.md`](messenger-personal-search-design.md) (#79 contract; #186 implementation) · [`capability-inventory.md`](capability-inventory.md) (#39 evidence legend) · [`provider-action-boundaries.md`](provider-action-boundaries.md) (normative risk classes) · parent #38.
