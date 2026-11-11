import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A deliberate public fixture. Never print tool content or provider error messages.
// Error codes are contract enums validated by the service's output schema, so pass them
// through after a shape check; 'UNKNOWN' means absent/malformed, never a real code.
const codeOrUnknown = (failure) => {
  const code = failure?.error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_]*$/.test(code) ? code : 'UNKNOWN';
};
const client = new Client({ name: 'shopping-search-smoke', version: '1.0.0' });
const startedAt = Date.now();
const expectEmpty = process.argv.includes('--expect-empty');
const query = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'fluke 87 multimeter';
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8080/mcp')));
  const search = (await client.callTool({ name: 'shopping_search', arguments: { query, limit: 5 } })).structuredContent;
  const offers = Array.isArray(search?.offers) ? search.offers : [];
  const confirmedEmpty = search?.ok === true && offers.length === 0;
  // Fetch the first offer in memory: report contract booleans only, never the id or content.
  let fetchOk = null;
  let fetchErrorCode = null;
  if (search?.ok === true && offers.length > 0) {
    const fetched = (await client.callTool({ name: 'shopping_fetch', arguments: { id: offers[0].id } })).structuredContent;
    fetchOk = fetched?.ok === true;
    if (!fetchOk) fetchErrorCode = codeOrUnknown(fetched);
  }
  // Normal mode passes only when the search succeeds with at least one offer and that
  // offer fetch succeeds; --expect-empty passes only on a successful empty search.
  const passed = expectEmpty ? confirmedEmpty : search?.ok === true && offers.length > 0 && fetchOk === true;
  console.log(JSON.stringify({
    elapsedMs: Date.now() - startedAt,
    searchOk: search?.ok === true,
    offerCount: search?.ok === true ? offers.length : null,
    confirmedEmpty,
    fetchOk,
    ...(search?.ok !== true ? { errorCode: codeOrUnknown(search) } : {}),
    ...(fetchErrorCode !== null ? { fetchErrorCode } : {})
  }));
  if (!passed) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, transportFailed: true }));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
