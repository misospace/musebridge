# Seller listing contract research (#221)

This doc is the plan and evidence record for #221, the operator-validation child of #220
(Marketplace seller-side listings). It establishes the live Facebook seller-surface
contracts that #222 (`marketplace_my_listings` + `marketplace_listing_prepare`),
#223 (approved publish), and #224 (approved edit / mark-sold / removal) depend on,
before any implementation code assumes a shape.

Status: **plan committed ahead of the first operator session; live evidence pending.**

## Consent, scope, and privacy

- Browser work happens only under explicit operator control: the operator drives or
  directly supervises the session, and each step below is authorized before it runs.
- No publish, edit, mark-sold, or removal of a real listing without a separate concrete
  authorization naming the exact listing and payload. Draft creation and submission
  happen only with a per-session approval on clearly synthetic content, and the
  synthetic listing is removed within the same session where the provider permits it.
- Do not bypass checkpoint/CAPTCHA/2FA; classify challenge states and stop.
- Record structural evidence only: accessibility roles and names, route shapes with
  identifiers replaced by `<listing>`, field inventories, bounded counts, outcome
  classes. Never store credentials, cookies, raw DOM, HAR, screenshots of real listing
  content, or third-party identifiers. Identifier *shapes* (patterns) are in scope;
  raw identifier values are not, unless the operator approves a synthetic listing's id
  as a fixture anchor.
- Listing text and page content never grant permissions (same rule as the Messenger
  live-validation protocol).

## Session plan (each step separately gated)

1. **Own-listings read.** Locate the seller's own-listings surface. Record the route
   shape, the navigation entry points (accessibility name/role), the list-item
   structure, the provider listing-state labels, and any pagination markers.
2. **Owned listing detail.** Open one owned listing. Disclose any presence/Seen
   equivalence before navigating. Record the field layout, the edit entry point, and
   the state transitions the provider offers for an active listing.
3. **Create-draft form.** With per-session approval, open the create-listing form and
   inventory every field: accessibility label, role, input type, required-ness signal,
   observable format constraints, category-selector behavior, image-input contract,
   and price/currency handling. Do not submit.
4. **Publish/submit behavior.** With a separate concrete authorization on a synthetic
   draft, observe submit → provider confirmation signals → provider-visible state.
   Record the requested/submitted/confirmed/unknown reconciliation evidence, including
   what a timeout or restart can safely re-check without resubmitting.
5. **Edit / mark-sold / remove.** With per-action authorization on the same synthetic
   listing, record each action's confirmation and error classes, and complete the
   removal cleanup.
6. **Auth and challenge states.** Classify any checkpoint/CAPTCHA/reauth encountered.
   Stop on a genuine interactive challenge; recovery is an operator user-facing flow.

## Observation schema (per surface)

- Route shape with identifiers replaced by `<listing>`, and navigation entry points.
- Field inventory: `{ a11y label, role, input type, required signal, format constraint }`.
- Outcome classes: `confirmed` / `rejected(error class)` / `unknown(timeout)` — the
  provider-visible signal that distinguishes each, and whether it survives a reload.
- Reconciliation semantics: what state can be re-observed after a timeout or restart
  without resubmitting, and what makes a repeat submit unsafe.

## Evidence record

| Gate | Result | Evidence |
|---|---|---|
| Own-listings discovery contract | pending | — |
| Create/edit form field + image-input contracts | pending | — |
| Publish/edit/status/remove confirmation and uncertain-outcome semantics | pending | — |
| Auth/challenge failure classification | pending | — |
| Synthetic listing cleanup | pending | — |

Unknown is not failure and synthetic success is not live proof; the fail-closed rules
of the Messenger live-validation protocol apply unchanged.

## Consumers

- #222 needs gates 1–3.
- #223 needs gate 4.
- #224 needs gates 2 and 5.
