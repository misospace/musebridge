# Messenger live validation (#77)

This protocol gates production thread reads, sends (#63 / PR #75), and timeout reconciliation. Inbox identity discovery (#64, implemented in PR #81) does not validate thread navigation or message extraction. No production send enablement is justified until the read gates below pass in the backend's actual browser path, with separately approved provider-observed send evidence where needed.

## Consent and privacy

Before navigating to any thread, identify the operator-approved account/session and conversation. Disclose that navigation may mark messages **Seen** and expose presence, including if Facebook redirects to another conversation. Obtain explicit read approval; record only the approval scope and date, never the account, participant, or thread key. Prefer a dedicated conversation with synthetic content. If the operator approves an existing conversation, retain structural evidence only.

Read approval does not authorize typing in the composer, Enter, clicking Send, reactions, attachments, creating a conversation, or changing account settings. Any send requires a separate concrete approval for the exact destination and delivered payload, after all read gates pass. This ticket adds no sending tool.

Do not export screenshots of conversations, accessibility trees, HTML, message text, names, raw URLs/IDs, GraphQL bodies, request payloads, cookies, headers, or storage. Project observations before returning tool output. Private values may be compared transiently in memory; do not persist them, including hashes that can correlate identities. Disable traces, videos, HAR capture, and content/debug logs for the investigation. Never copy an authenticated profile to create fixtures.

## Read gates

1. **Session and authoritative key.** Use the approved authenticated browser. Observe inbox metadata through #64's validated path, without opening threads. Keep the selected key in memory. A button's position, preview, participant name, or DOM order is not an authoritative mapping. If the approved conversation cannot be bound to a validated key, stop; do not choose a key by index. A separately operator-approved known test thread can substitute for inbox discovery.
2. **Navigation and identity.** Rebuild the URL from the configured Facebook origin and authoritative key. Record route shapes with keys replaced by `<thread>`, plus same-origin and requested-key equality booleans. Record redirect behavior without raw addresses. Check the final route and an independent rendered thread identity signal where available before exposing any content. An unchanged URL alone does not prove the rendered conversation matches. Unknown, mismatched, or ambiguous identity stops the read. Do not follow a redirect into another conversation to investigate it. A post-navigation guard prevents attribution, not a Seen receipt already emitted by navigation.
3. **Structure and direction.** Inspect bounded rendered message containers. Report roles, attribute names, generic orientation patterns with names/text replaced by placeholders, direction counts, timestamp presence/format, and attachment-container presence only. Establish sender orientation from explicit accessibility signals; alignment, color, names, and row order are insufficient. Distinguish message content from sender/status labels and controls. Unattributed rows are not messages. Account for virtualized windows and report whether the newest messages are actually included; do not call a loaded window complete history.
4. **Actual extraction path.** Compare the structural observations to `extractMessengerThreadPage` and `interpretMessengerThreadPage`. The current extractor scans the first 120 role rows, returns at most 50 messages, truncates each text to 2,000 characters, and recognizes sender-oriented row labels plus `time[datetime]`. Check whether these bounds include the latest outgoing message and its trailing token. A browser DOM observation alone does not verify the isolated service profile, backend navigation, settle loop, parser, or read result. Run that real path only in the approved session scope; return aggregate results, never its private message output. If the session/tooling cannot support this safely, mark this gate pending.
5. **Token detection.** Use synthetic fixtures to check the exact bracketed token form, own-message attribution, token at a text boundary, truncation, stale/virtualized windows, attachment-only rows, and wrong-thread rejection. A seller quoting the token must not confirm the operator's send. Live token detection needs an existing operator-approved synthetic token or a separately approved send; never send merely to manufacture evidence. Record match booleans only. If no suitable token exists, live detection remains unverified.
6. **Edge cases and regressions.** Cover valid, explicit empty, shifted layout, unknown sender, attachments, wrong origin, and misdirected thread using synthetic fixtures. Only label fixtures as based on live observations when that structure was actually observed. An unobserved empty/attachment case stays unverified. Unrecognized layouts and ambiguous identity must yield a typed error, never false empty success or fabricated attribution.

## Send-confirmation gate

Inspect available delivery-state accessibility signals without touching the composer. Distinguish an optimistic/local outgoing bubble, provider acknowledgement, and delivered/read status. A successful Enter keypress, resolved send call, or bracketed token in arbitrary thread text is insufficient evidence of provider acceptance. Establish whether the own outgoing message and its acknowledgement can be correlated reliably through the real backend read path. If that cannot be demonstrated, keep the result `unknown` and production sends blocked.

Any later live send needs separate approval naming the one conversation and exact synthetic payload including its token. Use the approved host authorization flow, submit once, observe without resending, and require confirmed thread identity plus own-message/token and provider acknowledgement. A timeout never authorizes a retry. #77's read approval is not a host grant and must never be converted into one.

## Evidence record and completion

Record the date, tested code revision, browser/session category (no profile path or account name), consent scope, route patterns, identity-check booleans, bounded role/direction counts, generic timestamp format, attachment/empty classification, token-match boolean, and provider-acknowledgement classification. Mark every gate **observed**, **synthetic only**, **pending**, or **failed**, with a short reason. Unknown is not false and synthetic success is not live proof.

Store only sanitized findings and fixtures. Run the relevant regressions from the repository root, review the diff for private data, and verify every #77 acceptance item independently. Keep #77 open while live navigation, real extraction, or required edge-case evidence is missing. #63 / PR #75 must explicitly retain #77 as a production send blocker until that evidence is reviewed; merging fail-closed machinery is not enablement.

## Current investigation status (2026-10-11)

- Structural comparison used checkout `da7c512`; the extractor/parser source is unchanged at the draft branch's base `db226be`. Browser category: operator-authenticated in-app browser, separate from the service's isolated Messenger profile.
- Operator approved read-only inspection of existing conversations after Seen/presence disclosure; sending remains prohibited.
- Repository contains the #64 inbox implementation. This does not establish live success in this investigation.
- Chrome is not connected to the available browser inspection API. The operator authenticated the in-app browser; an authenticated main landmark and account marker were observed at `/marketplace/inbox/`.
- The loaded inbox exposed 24 main-region conversation buttons, zero `/messages/t/` anchors, and only `class`, `role`, and `tabindex` attributes on those buttons. No button-to-key mapping was inferred. The available in-app API supports DOM inspection but does not expose a passive response listener for #64's GraphQL observation.
- The operator selected an existing conversation as the known test thread. It opened inline while the route stayed `/marketplace/inbox/`: one message log, 13 article containers, zero role rows, and zero `time[datetime]` elements. Its **Chat settings → Open in Messenger** menu exposed a same-origin link with the exact `/messages/t/<thread>/` shape. That provider-supplied link bound the selected conversation to a key without mapping inbox buttons or exporting identifiers.
- Rebuilding `/messages/t/<thread>/` from that key reached the same origin and preserved the requested key, with no final route mismatch observed. This verifies one menu-derived key's canonical navigation in the operator browser, not #64's GraphQL key semantics or all intermediate redirects. Independent rendered identity and service-profile navigation remain unverified.
- After hydration the canonical page contained one message log with 15 article containers and zero message-log role rows. All 23 page-wide role rows were outside the message log and had no `aria-label`. Article containers also lacked `aria-label`; no `time[datetime]` elements were present. The parser's sender-label contract was absent. The extractor's row-based rules therefore cannot yield attributed messages from this observed structure. No heuristic attribution or selector rewrite was added.
- Further bounded inspection found nested `h3` headings and five nested buttons with an aria-label containing the generic phrase `by you`. Those are candidate attribution signals, not a verified article-wide sender contract: their full semantics, incoming counterpart, grouping, and association with message content were not established. They do not justify inferring sender from heading text or selecting all article text.
- No simple `Sent`/`Delivered`/`Seen` aria-label prefix was found among inspected article descendants. This is not proof that provider acknowledgement is unavailable; a reliable confirmation contract remains unverified. The composer was not touched.
- Live token detection, empty-thread semantics, attachment semantics, newest-message completeness, independent rendered identity, and the isolated backend's actual live read path remain pending. Synthetic fixtures cover the observed unsupported article structure; empty/attachment representations and token text in those tests are invented, not captured personal content.
- No conversation content or identifiers have been recorded; no send has been attempted.

| Gate | Result |
|---|---|
| Consent and known test-thread selection | Observed |
| Same-origin menu key → canonical final route | Observed for one thread; GraphQL-key equivalence and intermediate redirects pending |
| Reliable rendered identity | Pending |
| Current sender-oriented row contract | Failed on observed layout; synthetic regression verifies fail-closed rejection |
| Empty/attachment and token bounds | Synthetic only; live semantics pending |
| Isolated backend live read and newest-message completeness | Pending |
| Provider-observed acceptance / delivery | Pending; no send authorized or attempted |
