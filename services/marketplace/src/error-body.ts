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
    // Stream the body through a sink that discards each chunk as it arrives, so an unexpected
    // large upstream error body is never accumulated in memory: a 429/5xx storm hits this path
    // on every failed request, and buffering there would add memory pressure exactly when the
    // service is already under load. Reading to completion (rather than `cancel()`) is what
    // returns the kept-alive socket to the pool for reuse instead of destroying it.
    await response.body?.pipeTo(new WritableStream({ write() {} }));
  } catch {
    // Already-consumed, locked, or stream-erroring body: still a failed response, and the
    // caller throws its typed error regardless.
  }
}
