# Provider architecture and compatibility strategy (#40)

Parent: #38 (verticals). Issue: #40. Status: architecture and compatibility strategy documented; eBay shopping is the second capability shipped against it, proving #40's "done when" — a second provider added without copying Marketplace's runtime.

This document is the reference for the provider/module layout of `services/marketplace/` and for the compatibility rules that keep existing consumers working. It is descriptive of the code as it exists (plus the schema `1.6.0` contract: the `1.4.0` capability-discovery change added the `social` surface and `threads_backend`, `1.5.0` added the `messenger_prepare` output contract, and `1.6.0` adds the `messenger_thread_read` `coverage` field); recommendations and not-yet-implemented items are marked as follow-ups. For the enforcement contract on sessions, actions, and grants, see [`provider-action-boundaries.md`](provider-action-boundaries.md); for the shopping research behind the second provider, see [`shopping-provider-research.md`](shopping-provider-research.md).

## Purpose and non-goals

Musebridge is a narrow **capability bridge**. It connects Miso/OpenClaw to external provider surfaces and returns typed facts; it does not decide, schedule, reason, or approve. Execution, scheduling, negotiation, ranking, and approval stay in Miso — via OpenClaw. The repository contains exactly one service package, `marketplace-mcp` under `services/marketplace/`, with one MCP tool registry and one process.

Explicit non-goals for this wave:

- **No second agent runtime.** Adding a provider adds a backend and typed tools, not an execution loop.
- **No plugin framework.** There is no dynamic provider loader, no manifest, no plugin lifecycle.
- **No shared package extraction.** The provider code lives inside `marketplace-mcp`; there is no `packages/providers` yet.
- **No config-driven provider table.** Surfaces and backends are declared in TypeScript, not in a data file.
- **No generalization ahead of evidence.** Per #40, only infrastructure actually shared by two capabilities is generalized.

## Capability model

A **capability surface** is the tuple:

```
(provider, account, surface)  +  a backend interface  +  registered tools  +  typed domain contracts
```

The scope triple is defined by the action-boundary contract (`provider-action-boundaries.md`): `provider` is the external service identity, `account` is one login identity (today always `default`), and `surface` is one product area on that provider. Each scope owns its own session assessment, browser profile (when browser-backed), and failure posture. A tool declares exactly one scope and one risk class; dispatch enforces it.

Today's five surfaces:

| Surface | Provider | Backend interface (`backend.ts`) | Tools (`tools.ts`) | Session kind |
|---|---|---|---|---|
| `marketplace` | `facebook` | `MarketplaceBackend` | `marketplace_search`, `marketplace_fetch`, `marketplace_status` | Browser session scope |
| `shopping` | `ebay` | `ShoppingBackend` | `shopping_search`, `shopping_fetch` | API token, no browser |
| `messenger` | `facebook` | `ConversationBackend` | `messenger_threads_list`, `messenger_thread_read`, `messenger_prepare`, `messenger_send` | Separate browser session scope |
| `events` | `ticketmaster` | `EventsBackend` | `events_search`, `events_fetch` | API token, no browser |
| `social` | `threads` | `ThreadsBackend` | `threads_posts_list`, `threads_replies_list` | API token, no browser |

Backends are selected by kind and expose a bounded `name` (`fixture`, `facebook`, `ebay`, `ticketmaster`, or `threads`). The backend interface is the only thing core dispatch knows about a provider; the domain contract is the only shape a provider must fill.

## Module layout and cohesive namespaces

Files under `services/marketplace/src/` are grouped by cohesion rather than by tool:

**Core / service-level modules** — the provider-agnostic spine:

- `service.ts` — composition root: reads environment/config, constructs backends, wires the HTTP server and MCP sessions.
- `tools.ts` — the tool registry, validation, authorization, dispatch, cancellation, and the single `CallToolRequestSchema` handler.
- `domain.ts` — all Zod contracts and the versioned output schemas; the single source of truth for shapes.
- `backend.ts` — the `MarketplaceBackend`, `ConversationBackend`, `ShoppingBackend`, `EventsBackend`, and `ThreadsBackend` interfaces plus `ProviderError`.
- `authorization.ts` — risk classes, scopes, grant shape, `authorizeAction`, `DenyAllAuthorizer`.
- `browser.ts` — the provider-agnostic Playwright persistent-profile manager.
- `fixtures.ts` — synthetic fixture data and the `FixtureBackend` / `FixtureShoppingBackend` / `FixtureEventsBackend` / `FixtureThreadsBackend` implementations.
- `reauth.ts` / `admin.ts` — the operator re-auth lease and its loopback admin API.
- `market-config.ts` — startup loader for a mounted Facebook market map.

**Provider-specific modules** — grouped by prefix or provider name:

- `facebook-*.ts` — `facebook-marketplace-*` (URL, extract, parse, backend), `facebook-messenger-*`, `facebook-login.ts`, `facebook.ts` (probe + origin constants).
- `ebay.ts` (HTTP client) and `ebay-backend.ts` (`ShoppingBackend` implementation).
- `ticketmaster.ts` (HTTP client) and `ticketmaster-backend.ts` (`EventsBackend` implementation).
- `threads.ts` (HTTP client) and `threads-backend.ts` (`ThreadsBackend` implementation).

**Dependency rule.** Provider-specific modules are never imported by the core dispatch/contract modules. `tools.ts` imports only `backend.ts`, `domain.ts`, `authorization.ts`, and `browser.ts`; `domain.ts` and `backend.ts` import no provider module. The concrete proof is `ebay-backend.ts`, whose entire import list is:

```ts
import { ProviderError, type ShoppingBackend } from './backend.js';
import { productOfferSchema, type ProductOffer } from './domain.js';
import { EbayClient, EbayHttpError, type EbayClientOptions } from './ebay.js';
```

Zero Facebook imports. Only the composition root (`service.ts`) and the public `index.ts` re-exports reference concrete provider modules; that is the one place allowed to know all providers.

**Honest coupling note.** Three "core" files are not yet fully provider-agnostic in their imports: `reauth.ts` imports the Facebook origin/path constants from `facebook.ts`; `market-config.ts` imports the Facebook market validators from `facebook-marketplace-url.ts`; and `fixtures.ts` carries synthetic data for all five surfaces. The truly agnostic dispatch path is `tools.ts` → `backend.ts` interfaces → `domain.ts` contracts. Untangling the reauth/config edge is deferred until a second browser-backed provider exists (see non-generalizations).

## Typed tool inputs/outputs/errors

`domain.ts` is the single source of truth. Every tool input and output is a Zod schema; `tools.ts` converts them to MCP JSON Schema with `z.toJSONSchema(..., { target: 'draft-7', io })` in `toMcpObjectSchema`, so `ListTools` and dispatch share the same definitions.

- **Inputs** are strict: `.strict()` rejects unknown keys, bounds are explicit, and cross-field refinements (for example `min_price <= max_price`, or exactly one of `id`/`url`) are part of the schema. Malformed arguments are validated at dispatch and returned as a JSON-RPC `InvalidParams` (`McpError` with `ErrorCode.InvalidParams`), **not** as a tool-error envelope.
- **Outputs** are success/failure unions parsed before return (`searchOutputSchema`, `fetchOutputSchema`, `shoppingSearchOutputSchema`, `shoppingFetchOutputSchema`, `threadsListOutputSchema`, `threadReadOutputSchema`, `prepareOutputSchema`, `sendOutputSchema`, `threadsPostsListOutputSchema`, `threadsRepliesListOutputSchema`, and `statusOutputSchema`). The parsed value is returned both as serialized text and as `structuredContent`, with `isError` set when `ok === false`.
- **Provider errors vs runtime failures.** `ProviderError` + `PROVIDER_ERROR_CODES` (`AUTH_EXPIRED`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, `SESSION_INVALID`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `TIMEOUT`) describe external provider state. The runtime failure envelope adds `NOT_FOUND` and `INTERNAL_ERROR`, and the policy codes `APPROVAL_REQUIRED` / `ACTION_FORBIDDEN` / `SURFACE_DISABLED`. Policy codes are deliberately **not** in `PROVIDER_ERROR_CODES`. `SURFACE_DISABLED` (thrown as `SurfaceDisabledError`) is the one policy code a registered tool can emit today: a backend configured to disable a surface, such as Messenger probe-only mode, reports it instead of a misleading provider session code, and it is surfaced without being logged as a service failure. Only validated `ProviderError` instances are surfaced; anything else is logged and reduced to `INTERNAL_ERROR`.

**Versioned output contract.** `SCHEMA_VERSION` in `domain.ts` is the contract version (currently `1.6.0`; `SERVICE_VERSION` is separate). Additive output changes bump the minor version; the runtime failure code `SURFACE_DISABLED` was added additively in `1.3.0`, the `social` capability surface shipped in `1.4.0`, the `messenger_prepare` output contract ships in `1.5.0`, and the `messenger_thread_read` `coverage` field ships in `1.6.0`. `listing` (Facebook) and `productOffer` (shopping) are **siblings, not replacements**: `productOffer` preserves `listing` field names where they overlap so a later comparison layer can union them without remapping, while `listing` stays exactly as deployed for the Facebook tools.

## Tool registry and single dispatch choke point

`TOOLS` in `tools.ts` is the registry. Each entry declares `name`, `description`, `inputSchema`, `outputSchema`, and `definition: { riskClass, scope }`; a tool that needs a conversation backend method also declares it on the same entry as `requires: { method }`, so the gate reads the requirement off the entry instead of restating tool names in a separate list. From the registry the module derives `TOOL_DEFINITIONS` and one registration entry per active tool, which carries the name, both schemas, and the action definition; the `ListTools` response and the `CallTool` lookup both read that entry, so a tool that is not registered has no schema at all rather than an undefined one.

There is exactly one `CallToolRequestSchema` handler. It:

1. Resolves the input schema and rejects unknown tools with `InvalidParams`.
2. Validates arguments (`InvalidParams` on failure).
3. Builds an `ActionRequest` (`scope` + `action` + `subjectDigest`) and calls `authorizeAction`.
4. On success, runs the backend through `runBackendOperation` and parses the output against the selected output schema.
5. On refusal or failure, returns the uniform `runtimeFailureSchema` shape with `isError: true`.

`assertWritableToolsHaveAuthorizer([...registry.values()], options.authorizer)` runs at registration and throws before the tool is served if any registered `send` or `high_consequence` tool has no authorizer. The registry holds `TOOLS` after capability gating, so its size varies with the wired backends: the registry declares thirteen tools, eleven of them `read`; `messenger_prepare` is `prepare`-class and autonomous by design, so it consults no approval-grant seam. The sole write-class tool, `messenger_send`, requires an authorizer, so when none is configured a `DenyAllAuthorizer` is installed and consulted for that tool (every send fails closed).

One caveat for new capabilities: the **output-schema selection is an explicit per-tool branch** (a nested ternary in the handler), as is the backend invocation branch. Adding a tool means touching both branches. The name-to-schema pairing itself is not a second thing to keep in step: the registry entry carries the tool's own input and output schema, and the handler reads the output schema from that same entry. This is the concrete place a new capability must edit core dispatch.

## Explicit provider-specific session dependencies

Session scope is declared per tool, not inferred. Browser-backed scopes each own their own persistent profile, session probe, and (where applicable) reauth/credential-login stack:

- `marketplace` uses `BROWSER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile`), `FacebookSessionProbe`, `FacebookCredentialLogin`, and the reauth console.
- `messenger` uses a distinct `MESSENGER_PROFILE_DIR` (default `$HOME/.marketplace/browser-profile-messenger`), its own probe, and its own credential-login instance; sharing the marketplace profile directory is a startup error. It has no interactive reauth target yet.
- `shopping` has **no browser session**: the eBay token is application-scoped (`EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`, read at call time, never logged). The "session" dimension is simply whether the API is configured.

Optional surfaces fail closed. `messenger_threads_list` / `messenger_thread_read` throw a typed `ProviderError('UPSTREAM_ERROR', 'The messenger surface is not configured...')` when no `ConversationBackend` is wired; `shopping_*` does the same when no `ShoppingBackend` is wired. The draft/send conversation tools are additionally gated per method — `messenger_prepare` is advertised only where the conversation backend implements `prepareDraft` and `messenger_send` only where it implements `sendThread` — so a backend that serves conversation reads without them is never advertised as capable of drafting or sending. That requirement is the `requires` field of the tool's own registry entry (a conversation backend method, the only surface gated per method today), so a newly gated tool cannot be forgotten by the gate. `marketplace_status` reports the assessment without doing browser work (`browser.getInfo()`), so status never launches a browser.

Isolation invariants — including the Messenger "Seen" read exception — are normative in `provider-action-boundaries.md` and are not restated here.

## Cancellation and bounded operations

`runBackendOperation` in `tools.ts` is the shared bounded-operation helper. It races the backend call against:

- a **per-call deadline** (`backendTimeoutMs`, default 30,000 ms, configurable via `BACKEND_TIMEOUT_MS`), producing a `ProviderError('TIMEOUT', ...)`;
- the **MCP request signal** (`extra.signal`, cancellation/disconnect);
- the **service shutdown signal** (an `AbortController` aborted by `service.close()`).

It creates one internal `AbortController` and forwards its signal to the backend, so a single abort source reaches the operation. Because arbitrary promises cannot be force-cancelled, the contract is that backends **must honor the signal**; the helper stops awaiting non-cooperative work but cannot stop the work itself. If the request or shutdown signal aborted, the handler rethrows instead of masking the cancellation as a provider failure.

**Honest gap.** `EbayShoppingBackend` layers its own `withDeadline()` (default `requestTimeoutMs` 15,000 ms) inside the shared helper rather than relying solely on `runBackendOperation`. The tool layer still wraps every backend call — including eBay — in `runBackendOperation` (default 30,000 ms), but eBay's inner 15,000 ms `withDeadline` default is the stricter of the two, so the inner deadline binds first in practice. The two mechanisms are not converged, and consistency should not be overstated. Converging them is a follow-up.

## Capability discovery

Shipped in schema `1.4.0`: `marketplace_status` returns `service_version`, `schema_version`, `backend`, optional `shopping_backend`, optional `events_backend`, optional `threads_backend`, optional `facebook_session`, and a **required** `capabilities` array. Each entry is `{ surface, provider, backend }`:

- `surface` is one of `marketplace`, `shopping`, `messenger`, `events`, `social` (closed enum in `capabilitySchema`).
- `provider` is the declared session-scope provider (`facebook` for marketplace/messenger, `ebay` for shopping, `ticketmaster` for events, `threads` for social).
- `backend` is the backend implementation name actually wired for that surface (`fixture` / `facebook` / `ebay` / `ticketmaster` / `threads`), or `null` when no backend serves it.

The array is non-empty and ordered marketplace, shopping, messenger, events, social. Today, `messenger` and `events` are the surfaces that can be `null` (Facebook backend selected but `MARKETPLACE_MESSENGER` off, or `EVENTS_BACKEND` left unset); `marketplace`, `shopping`, and `social` are always wired by the service (fixture default). The existing fields `backend`, `shopping_backend`, `events_backend`, and `facebook_session` are unchanged, and `threads_backend` is added alongside them.

Why this is additive and non-breaking: the `social` surface and the optional `threads_backend` field were added additively in `SCHEMA_VERSION` `1.4.0` (the capability-discovery field itself shipped in `1.2.0`); no tool name, input, or existing field changes. A new surface extends the array with one more entry rather than reshaping the response. Because `ListTools` lists every registered tool regardless of surface configuration (a fixture deployment still advertises `shopping_*`, `events_*`, `threads_*`, and the `messenger_*` read tools; the capability-gated draft and send tools stay unadvertised until the conversation backend implements their method), the capabilities array is what distinguishes **configured backends** without probing a session or calling a tool.

## Compatibility strategy

Distinguish identity surfaces by their stability to consumers:

| Identity surface | Current value | Defined in | Stability |
|---|---|---|---|
| Repository / workspace name | `musebridge` | `package.json` (root) | Internal; rename is cosmetic to MCP consumers |
| Service package name | `marketplace-mcp` | `services/marketplace/package.json` | Internal build/runtime name; coordinate renames |
| Container image | `ghcr.io/misospace/marketplace-mcp` | `.github/workflows/ci.yml`, README | Host-facing; legacy `ghcr.io/misospace/marketplace` has **no alias** |
| MCP server identity | `marketplace` | `new Server({ name: 'marketplace', ... })` in `service.ts` | Consumer contract; do not rename silently |
| Public tool names | the thirteen above | `TOOLS` in `tools.ts` | **The stable consumer contract** |
| Deployment workload names | ToolHive / OpenClaw profiles | external, not in this repo | Not yet registered; hosts own them |

Rules:

- **The compatibility boundary is the public tool names and the versioned output contract.** Branding, repository, and package renames must not rename tools or the MCP server identity without an explicit, announced migration.
- **Output changes are additive** and bump the minor `SCHEMA_VERSION`. Removing a field, changing a type, or changing a success envelope is a breaking change requiring a migration plan.
- **Environment-variable renames keep a documented fallback.** `FACEBOOK_MARKETS_FILE` is the documented name; `MARKETPLACE_MARKETS_FILE` still works as a fallback in `market-config.ts` so existing deployments keep running.
- **Image renames are breaking host changes with no alias.** `ghcr.io/misospace/marketplace` is no longer published and there is no alias; hosts must update image references. Tags (`main`, SHA, semver) are unchanged.

**Consumer compatibility checklist**

- [ ] Tool names unchanged (`marketplace_search`, `marketplace_fetch`, `marketplace_status`, `shopping_search`, `shopping_fetch`, `events_search`, `events_fetch`, `messenger_threads_list`, `messenger_thread_read`, `messenger_prepare`, `messenger_send`, `threads_posts_list`, `threads_replies_list`).
- [ ] MCP server identity still `marketplace`.
- [ ] `SCHEMA_VERSION` bumped only for additive output changes; existing fields keep their names and types.
- [ ] New status fields are additive; `capabilities` entries are added, not reshaped.
- [ ] Env-var renames ship with a fallback for at least one release.
- [ ] Image/workload reference changes are called out to hosts (no alias).

## Adding a provider without copying the runtime (worked example: eBay shopping)

The recipe a new capability follows:

1. **Define the domain contract in `domain.ts`.** Add input, success, and output schemas and exported types (for shopping: `productOfferSchema`, `shoppingSearchInputSchema`, `shoppingFetchInputSchema`, and the `shopping*OutputSchema` unions).
2. **Implement a `backend.ts` interface in provider-specific modules.** For shopping, `ShoppingBackend` is implemented by `EbayShoppingBackend` in `ebay-backend.ts`, over the `EbayClient` in `ebay.ts`.
3. **Wire selection in `service.ts` behind an opt-in env var/option with fail-closed defaults.** `SHOPPING_BACKEND=fixture|ebay` (`parseShoppingBackendKind`) defaults to `fixture`; `ebay` requires `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` and otherwise throws at startup (`requiredEnv`).
4. **Declare tools in `TOOLS`** with name, description, input/output schemas, and a `definition` carrying the scope and risk class (`shoppingScope`, `read`); add `requires: { method }` on the entry when the tool only works if the wired conversation backend implements that method (the capability requirement is a conversation backend method, since that is the only surface gated per method today).
5. **Add the dispatch branch.** Add the output-schema selection and the backend invocation branch in the `CallToolRequestSchema` handler, wrapping the call in `runBackendOperation`.
6. **Add fixtures and tests.** Synthetic fixture offers (`FIXTURE_OFFERS` / `FixtureShoppingBackend` in `fixtures.ts`), recorded HTTP fixtures under `tests/fixtures/ebay/`, and unit tests (`tests/ebay-client.test.ts`, `tests/ebay-backend.test.ts`) using a local synthetic HTTP server.
7. **Extend capability discovery.** Add the `shopping` entry to the `capabilities` array (and the optional `shopping_backend` field) so hosts can see the configured backend without calling a tool.

**eBay case study — what it reused:**

- Typed contracts from `domain.ts` (`productOffer` as a sibling of `listing`).
- `ProviderError` and the shared provider-error code set (mapped from HTTP status in `ebay-backend.ts`).
- Deadline/abort plumbing (`withDeadline` and the outer `runBackendOperation`).
- Fixture-first testing with zero real network calls.
- The single registry and dispatch path.

**What it did not need to copy:** the browser session layer, the session probe, the reauth console, the credential-login flow, and the per-scope profile directory — none apply to an API-token surface. This asymmetry is the evidence for #40's done-when: a second provider was added by implementing one interface and one contract group, not by duplicating Marketplace's runtime.

## Deliberate non-generalizations

- **No central provider registry / plugin loader.** Providers are constructed explicitly in `service.ts`; adding one is a code change, not a data change.
- **No shared package extraction.** A second service package would duplicate the transport, registry, and authorization spine for one consumer.
- **No config-driven provider table.** The surfaces are compile-time TypeScript, which keeps the schemas and scopes type-checked.
- **The five backend interfaces stay separate by design.** `MarketplaceBackend`, `ConversationBackend`, `ShoppingBackend`, `EventsBackend`, and `ThreadsBackend` have different input/output types (`Listing` vs `ConversationThread`/`ConversationMessage` vs `ProductOffer` vs `EventAvailability` vs `ThreadsPost`/`ThreadsReply`); collapsing them into one generic interface would erase the types that make the contracts safe.
- **Generalization is deferred until a third capability justifies it**, matching #40's "generalize only infrastructure actually shared by two capabilities." A third browser-backed provider, for example, is the natural trigger to lift the reauth/market-config coupling.

## Tests and fixtures

- Provider-agnostic tests cover the registry, dispatch, validation, authorization, cancellation, and the service lifecycle.
- Per-provider synthetic fixtures live under `tests/fixtures/`: `facebook-marketplace/` (search cards, item pages, login/captcha/checkpoint/layout-change states), `facebook-messenger/` (inbox and thread pages), `ebay/` (search/item/token/error JSON), `events/` (Ticketmaster search/event/error JSON), and `threads/` (Threads posts/replies JSON); the Threads fixtures are exercised by `tests/threads-client.test.ts` and `tests/threads-backend.test.ts`.
- Browser tests are gated by `REQUIRE_BROWSER_TESTS=1`; they use a synthetic local server and make **zero** real network calls (Facebook tests block network access entirely).
- CI installs Chromium and runs `npm run test -- --fileParallelism=false` with `REQUIRE_BROWSER_TESTS=1` to serialize browser-heavy files; ordinary local `npm test` keeps default parallelism.

## Open questions / follow-ups

Not yet implemented — do not read as shipped:

- **Converge eBay's deadline handling with `runBackendOperation`** so there is one bounded-operation path rather than a nested deadline.
- **Decide when a third capability justifies a provider registry.** Two capabilities did not; the trigger and shape are undefined.
- **Surface the messenger session in status.** `facebook_session` currently reports only the marketplace scope; a messenger-scope assessment is not exposed.
- **Consider per-surface schema versioning** if surfaces start to diverge faster than one shared `SCHEMA_VERSION` can express additively.
- **Untangle the reauth/market-config Facebook coupling** at the point a second browser-backed or market-based provider is added.
