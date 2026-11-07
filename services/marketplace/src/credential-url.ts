/**
 * Credential destination restriction shared by the direct HTTP provider clients: each
 * client's credential (Basic-encoded OAuth secret, query-parameter API key, bearer
 * token) travels with its requests, so the client must not be pointable at arbitrary
 * origins. Only the provider's production host(s) over HTTPS are allowed at runtime;
 * loopback HTTP(S) exists solely as an explicit test seam. There is deliberately no
 * environment variable or option that can move a credential destination elsewhere.
 *
 * The return value is normalized from the parsed URL, never from the raw string:
 * surrounding whitespace (JS trim, so Unicode forms included) is trimmed before
 * parsing, and the result is the origin plus the pathname, with one trailing slash
 * stripped (the bare `/` pathname's slash is dropped entirely). A trailing `?` or `#`
 * with no content parses to an empty search/hash, passes every guard, and disappears
 * in this normalization, so the value concatenated into a fetch target can never
 * carry it. A search or hash with content stays refused by the guards below.
 */
export function resolveCredentialBaseUrl(
  baseUrl: string,
  allowedHttpsHosts: readonly string[],
  allowedMessage: string
): string {
  let parsed: URL;
  // Trim inside the try: a value that is not a trimmable string must fail with the
  // same typed refusal as one that does not parse, not with a property-access error.
  try { parsed = new URL(baseUrl.trim()); } catch { throw new TypeError('baseUrl must be a valid URL'); }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const isProviderHost = parsed.protocol === 'https:' && allowedHttpsHosts.includes(host);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (!isProviderHost && !(isLoopback && ['http:', 'https:'].includes(parsed.protocol)))) {
    throw new TypeError(allowedMessage);
  }
  // Normalized from the parsed URL: origin plus pathname drops the empty trailing
  // `?`/`#` the guards let through, and the single trailing-slash strip keeps the
  // supported base-path behavior (a bare `/` yields the bare origin).
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}
