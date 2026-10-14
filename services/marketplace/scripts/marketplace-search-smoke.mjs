import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A deliberate public fixture. Never print tool content or provider error messages.
const client = new Client({ name: 'marketplace-search-smoke', version: '1.0.0' });
const startedAt = Date.now();
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8080/mcp')));
  const result = await client.callTool({ name: 'marketplace_search', arguments: { query: 'Jetson AGX', location: 'Calgary', limit: 5 } });
  const response = result.structuredContent;
  const codes = new Set(['UPSTREAM_ERROR', 'TIMEOUT', 'LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'SESSION_INVALID', 'RATE_LIMITED']);
  const errorCode = codes.has(response?.error?.code) ? response.error.code : 'UNKNOWN';
  const count = Array.isArray(response?.listings) ? response.listings.length : null;
  const confirmedEmpty = response?.ok === true && count === 0;
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, ok: response?.ok === true, count, confirmedEmpty, ...(response?.ok !== true ? { errorCode } : {}) }));
  if (process.argv.includes('--expect-empty') && !confirmedEmpty) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, transportFailed: true }));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
