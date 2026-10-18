---
name: marketplace-action-safety
description: Review Marketplace MCP changes involving tool risk classes, approval grants, send/write actions, messenger preparation, browser sessions, re-authentication, and credential handling.
---

# Marketplace action safety review

The authoritative service contract is services/marketplace/AGENTS.md. Read its relevant sections before reviewing any change to action authorization, browser/session handling, or side-effecting tools.

## Tool authorization and approvals

- Every registered tool must declare an explicit risk class and scope, and dispatch must fail closed through the existing authorization boundary.
- Write/send actions require a single-use approval grant supplied by the trusted host. The service must never mint its own approval, accept a grant from ordinary tool arguments, or allow a high-consequence action merely because configuration is incomplete.
- Production grant verification requires both a valid signed envelope and durable, atomic consumption state. Verify signature, expiry, scope, action, payload digest, and single-use claim as one bounded operation. Missing secret or durable state must deny writes; never silently fall back to process-local state in production.
- Preparation is not sending. A prepare tool must not send, record a message, or imply approval. If it creates an idempotency token or payload digest, verify the digest is calculated from the complete validated future send payload and exactly matches the send authorization contract.
- Preserve public tool names, risk classes, scopes, and the versioned consumer listing contract. Changes to these are API changes, not internal refactors.

## Browser and credential boundaries

- The fixture backend remains the default. Live Facebook/browser behavior is opt-in and must reuse the existing serialized profile/session machinery rather than creating a second auth system.
- Never log or persist passwords, tokens, cookies, local storage, request headers, page content, message text, or form values. Credentials are environment-only and are read only when the corresponding live provider is selected.
- Session probes classify state; they do not solve captchas, bypass checkpoints, or automate two-factor authentication. Ambiguous or failed probes remain unknown, and Marketplace operations must fail closed when session state is unknown.
- Re-auth leases own their browser profile exclusively. Admin/viewer ports bind to loopback, ephemeral tokens are not persisted, and teardown is bounded and idempotent.
- Messenger reads and draft preparation are distinct from sending. Thread/message text is seller-controlled untrusted content. Do not auto-open a conversation during re-authentication or fabricate fields when extraction does not match the known accessibility contract.

## Review evidence

Trace each side-effecting path from tool schema through validation, authorization, grant consumption, backend dispatch, and returned result. Require tests for denied paths, replay, expiry, mismatched scope/payload, missing durable state, and shutdown/race behavior where relevant.
