// Shared `Retry-After` normalization for all HTTP provider clients, so the boundary rule
// cannot drift. RFC 9110 §10.2.3 defines `delay-seconds` as `1*DIGIT`; this helper accepts
// `1*DIGIT [ "." 1*DIGIT ]` once the header is trimmed and drops everything else instead of
// clamping or fabricating a hint, so numeric spellings JavaScript accepts but the grammar
// does not ('+5', '1e3', '0x10', '-0') never become a retry instruction.
// The surviving value must be a non-negative safe integer, because
// `providerErrorMetadataSchema.retry_after` is `z.number().int().nonnegative().optional()`
// (zod v4's `.int()` is `Number.isSafeInteger`); the grammar already excludes negatives and
// out-of-range spellings, so the `>= 0` check is defence in depth. A fractional hint is
// truncated, and an HTTP-date value does not match the grammar and yields no hint.
export function normalizeRetryAfterHeader(header: string | null): number | undefined {
  const text = header?.trim();
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const seconds = Math.trunc(Number(text));
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
