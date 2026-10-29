/**
 * Credential destination restriction shared by the direct HTTP provider clients: each
 * client's credential (Basic-encoded OAuth secret, query-parameter API key, bearer
 * token) travels with its requests, so the client must not be pointable at arbitrary
 * origins. Only the provider's production host(s) over HTTPS are allowed at runtime;
 * loopback HTTP(S) exists solely as an explicit test seam. There is deliberately no
 * environment variable or option that can move a credential destination elsewhere.
 *
 * Returns the base URL with one trailing slash stripped, preserving the callers'
 * existing normalization of the raw string.
 */
export function resolveCredentialBaseUrl(
  baseUrl: string,
  allowedHttpsHosts: readonly string[],
  allowedMessage: string
): string {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be a valid URL'); }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const isProviderHost = parsed.protocol === 'https:' && allowedHttpsHosts.includes(host);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (!isProviderHost && !(isLoopback && ['http:', 'https:'].includes(parsed.protocol)))) {
    throw new TypeError(allowedMessage);
  }
  return baseUrl.replace(/\/$/, '');
}
