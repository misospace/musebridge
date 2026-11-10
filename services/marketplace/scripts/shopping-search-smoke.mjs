import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A deliberate public fixture. Never print tool content or provider error messages.
const client = new Client({ name: 'shopping-search-smoke', version: '1.0.0' });
const startedAt = Date.now();
const query = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'fluke 87 multimeter';
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8080/mcp')));
  const search = (await client.callTool({ name: 'shopping_search', arguments: { query, limit: 5 } })).structuredContent;
  const codes = new Set(['UPSTREAM_ERROR', 'TIMEOUT', 'NOT_FOUND', 'RATE_LIMITED', 'INTERNAL_ERROR']);
  const errorCode = codes.has(search?.error?.code) ? search.error.code : 'UNKNOWN';
  const offers = Array.isArray(search?.offers) ? search.offers : [];
  // Fetch the first offer in memory: report contract booleans only, never the id or content.
  let fetchOk = null;
  if (search?.ok === true && offers.length > 0) {
    const fetched = (await client.callTool({ name: 'shopping_fetch', arguments: { id: offers[0].id } })).structuredContent;
    fetchOk = fetched?.ok === true;
  }
  console.log(JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    searchOk: search?.ok === true,
    offerCount: search?.ok === true ? offers.length : null,
    confirmedEmpty: search?.ok === true && offers.length === 0,
    fetchOk,
    ...(search?.ok !== true ? { errorCode } : {})
  }));
  if (process.argv.includes('--expect-empty') && !(search?.ok === true && offers.length === 0)) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, transportFailed: true }));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
