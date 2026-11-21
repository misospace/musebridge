// Shared error-body drain for the HTTP provider clients that do not map a typed error body.
// An undici-backed keep-alive `Response` whose body is never consumed keeps its socket from
// being reused until GC finalizes it, so a sustained provider error condition (429 storms,
// 5x outages) would pin one connection per failed request in a long-running service
// (#258). Reading the body to completion releases the connection back to the pool;
// `body.cancel()` releases the pin too but tears the socket down instead of reusing it.
// The content is discarded, never logged or attached to the error: provider error text is
// untrusted and must not reach output (same rule as the mautrix-meta client, which consumes
// the body by parsing its typed error schema instead). A body read that fails must never mask
// the caller's typed HTTP error, so every rejection here resolves; a body that stalls stays
// bounded by whatever deadline the call site already enforces on the request itself
// (caller signal, backend deadline, or the eBay token-exchange deadline the error race covers).
export async function drainErrorBody(response: Response): Promise<void> {
  try {
    // Read-to-completion buffers the whole body before discarding it. That matches the
    // success-path `json()` exposure these clients already accept, and any size cap would
    // need `cancel()` — which releases the pin but destroys the socket instead of reusing it.
    await response.text();
  } catch {
    // Already-consumed, locked, or stream-erroring body: still a failed response, and the
    // caller throws its typed error regardless.
  }
}
