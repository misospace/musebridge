---
name: marketplace-provider-contracts
description: Review Marketplace MCP provider backends, Zod schemas, listing extraction, HTTP/API safety, fixture behavior, provider errors, pagination, and returned data fidelity.
---

# Marketplace provider contract review

Read services/marketplace/AGENTS.md and docs/provider-architecture.md for the full service contract. The fixture backend is the default reference; live providers are opt-in and must not change the public tool contract accidentally.

## Shared provider rules

- Validate inputs strictly with Zod and return malformed arguments as JSON-RPC InvalidParams. Keep provider failures typed and bounded; unknown layouts or schema drift are upstream errors, not empty success.
- Preserve public tool names and the versioned consumer listing contract. Additive output changes require the documented schema-version change.
- Backend calls receive an abort signal and obey configured deadlines. Report partial or unavailable data honestly; never fabricate IDs, prices, locations, timestamps, currency, or state.
- Treat fixture data as synthetic. Never fetch a caller-supplied listing URL. For fetch-by-URL, extract only the permitted item identifier, then rebuild the URL from the configured provider base rather than navigating to the supplied origin.
- Keep credentials environment-only, never log or return them, and constrain requests to the fixed provider destination. Test code must not make live-provider requests unless the dedicated opt-in validation path explicitly requires it.

## Facebook Marketplace

- Item IDs must come from valid extracted item URLs; do not synthesize IDs. Search is intentionally bounded to one page, without scrolling or pagination. Unknown layouts are typed errors, not empty results.
- Location slugs must come from configured markets, never guesses. Currency must come from an explicit price marker or a configured market grounded in the listing's own location; otherwise fail closed.
- Search-card state is not proof that an item is active. Preserve a complete listing page's removed state when the provider reports it, and reserve not-found for shells that cannot satisfy the listing contract.
- Keep browser network access blocked in fixture tests. Re-authentication must not open a conversation, and session uncertainty must not be upgraded to usable without a confirming probe.

## Threads and other read-only providers

- Threads remains read-only. Do not add publishing, DMs, booking, purchasing, cart writes, or external profile discovery as incidental provider work.
- Keep the live Threads backend behind both credential configuration and explicit live-validation acknowledgement. The bearer token must only go to the fixed Graph API host.
- Validate permalink hosts using exact HTTPS host allowlists, not suffix matches. Media CDN allowlisting is a separate contract from permalink allowlisting; unapproved media URLs are dropped, never rewritten or substituted.
- Preserve legitimate nulls for absent captions, counts, timestamps, or owner fields when the provider contract allows them. Missing required IDs, malformed items, or unparseable paging state are schema drift, not a successful empty response.
- Check bounded pagination, stable ordering, ID deduplication, and an explicit truncation/completeness signal whenever cursors remain.

## Tests

Run the owning service's build, typecheck, tests, and lint checks. Add synthetic fixtures for new provider shapes and tests for malformed payloads, unknown layouts, host rejection, abort/deadline behavior, and missing credentials. Do not claim live-site validation unless it actually occurred.
