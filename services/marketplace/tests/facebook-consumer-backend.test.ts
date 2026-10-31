import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError, SurfaceDisabledError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { consumerThreadsListInputSchema, consumerThreadsSearchInputSchema } from '../src/domain.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

// The homepage shell mounts the menu variant only after a real click on the Messenger control,
// exactly the runtime shape the backend must drive: navigation to the root, trusted click,
// region-scoped extraction. Zero requests escape the loopback server.
const homeShell = (variant: 'normal' | 'conflicting' | 'no-control' | 'auto-open'): string => {
  const control = variant === 'no-control'
    ? '<div style="width:40px;height:40px"></div>'
    : '<div role="button" aria-label="Messenger" style="width:40px;height:40px" id="messenger-menu"></div>';
  const handler = variant === 'auto-open'
    ? `window.location.href = '/messages/t/999999999999999/';`
    : `document.getElementById('menu-root').innerHTML = ${JSON.stringify(menuMarkup(variant))};`;
  return `<!doctype html><html><head><title>Synthetic Facebook</title></head><body>
<div role="banner">${control}</div>
<main><p>Synthetic feed content.</p></main>
<a href="/logout">Log out</a>
<div id="menu-root"></div>
<script>
  var control = document.getElementById('messenger-menu');
  if (control) control.addEventListener('click', function () { ${handler} });
</script>
</body></html>`;
};

function menuMarkup(variant: 'normal' | 'conflicting' | 'no-control' | 'auto-open'): string {
  const row = (key: string, e2ee: boolean, name: string, text: string) =>
    `<div role="row"><a href="/messages/${e2ee ? 'e2ee/' : ''}t/${key}/"><span>${name}</span><span>${text}</span></a></div>`;
  if (variant === 'conflicting') {
    // One row carrying two distinct conversation keys: the association is ambiguous, so the
    // whole observation must fail closed rather than pick a key.
    return `<div role="grid" aria-label="Chats"><div role="row"><a href="/messages/t/111111111111111/"><span>Synthetic Alpha</span><span>Is the fixture bike available?</span></a><a href="/messages/t/222222222222222/"><span>Synthetic Beta</span><span>Which key is mine?</span></a></div>${row('333333333333333', false, 'Synthetic Gamma', 'Pickup works.')}</div>`;
  }
  return `<div role="grid" aria-label="Chats">${row('111111111111111', false, 'Synthetic Alpha', 'Is the fixture bike available?')}${row('222222222222222', true, 'Synthetic Beta', 'The E2EE route keeps its provenance.')}${row('333333333333333', false, 'Synthetic Gamma', 'Pickup works tomorrow.')}</div>`;
}

let server: Server;
let origin: string;
let variant: 'normal' | 'conflicting' | 'no-control' | 'auto-open' = 'normal';
const requests: string[] = [];
const managers: BrowserSessionManager[] = [];
const profileDirs: string[] = [];

const inboxFixture = readFileSync(new URL('./fixtures/facebook-messenger/inbox-normal.html', import.meta.url), 'utf8');
const threadFixture = readFileSync(new URL('./fixtures/facebook-messenger/thread-normal.html', import.meta.url), 'utf8');

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    let html: string | undefined;
    if (pathname === '/') html = homeShell(variant);
    else if (pathname === '/marketplace/inbox/') html = inboxFixture;
    else if (/^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) html = threadFixture;
    response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html ?? 'missing synthetic route');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
});

afterEach(async () => {
  expect(requests.every((request) => /^\/$|^\/marketplace\/inbox\/$|^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(request))).toBe(true);
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  variant = 'normal';
  requests.length = 0;
});

function createBackend(options: { probeOnly?: boolean } = {}): FacebookMessengerBackend {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-consumer-test-'));
  profileDirs.push(parent);
  const browser = new BrowserSessionManager({
    profileDir: join(parent, 'profile'),
    launchArgs: ['--host-resolver-rules=MAP * 127.0.0.1', '--disable-background-networking'],
    launchTimeoutMs: 10_000,
    settleTimeoutMs: 1_000,
    logger: { error: () => undefined }
  });
  managers.push(browser);
  const probe = new FacebookSessionProbe({ browser, baseUrl: origin, surface: 'messenger', navigationTimeoutMs: 5_000, settleTimeoutMs: 100 });
  return new FacebookMessengerBackend({
    browser,
    probe,
    navigationTimeoutMs: 5_000,
    settleTimeoutMs: 1_500,
    logger: { error: () => undefined },
    ...(options.probeOnly ? { probeOnly: true } : {})
  });
}

const signal = () => new AbortController().signal;
const listInput = (overrides: Record<string, unknown> = {}) => consumerThreadsListInputSchema.parse({ limit: 10, ...overrides });
const searchInput = (overrides: Record<string, unknown> = {}) => consumerThreadsSearchInputSchema.parse({ query: 'bike', ...overrides });
function expectProviderError(promise: Promise<unknown>, code: ProviderError['code'], message?: string) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderError', code, ...(message ? { message } : {}) });
}

describe.skipIf(!browserAvailable)('Facebook consumer menu discovery', () => {
  it('lists the verified menu window with route provenance and permanently partial coverage', async () => {
    const backend = createBackend();
    const page = await backend.listConsumerThreads(listInput(), signal());
    expect(page.threads.map(({ thread_id, route }) => ({ thread_id, route }))).toEqual([
      { thread_id: '111111111111111', route: 'plain' },
      { thread_id: '222222222222222', route: 'e2ee' },
      { thread_id: '333333333333333', route: 'plain' }
    ]);
    expect(page.threads[0]?.preview).toBe('Synthetic AlphaIs the fixture bike available?');
    // No pagination signal exists on this source, so the window is never proven complete.
    expect(page.coverage).toEqual({ threads_observed: 3, window: 'recent-load', complete: false });
    expect(page.truncated).toBe(false);
  });

  it('reports cap-truthful truncation when the caller limit leaves observed threads behind', async () => {
    const backend = createBackend();
    const page = await backend.listConsumerThreads(listInput({ limit: 2 }), signal());
    expect(page.threads).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(page.coverage.threads_observed).toBe(3);
  });

  it('searches the observed window in memory and names the matched fields', async () => {
    const backend = createBackend();
    const page = await backend.searchConsumerThreads(searchInput({ query: 'BIKE' }), signal());
    expect(page.matches).toHaveLength(1);
    expect(page.matches[0]).toMatchObject({ thread_id: '111111111111111', route: 'plain', matched_on: ['preview'] });
    expect(page.coverage).toEqual({
      threads_observed: 3,
      window: 'recent-load',
      complete: false,
      searchable_fields: ['preview']
    });
    expect(page.truncated).toBe(false);
  });

  it('reports an empty search as a window-scoped negative, never authoritative absence', async () => {
    const backend = createBackend();
    const page = await backend.searchConsumerThreads(searchInput({ query: 'kayak' }), signal());
    expect(page.matches).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.coverage.complete).toBe(false);
    expect(page.coverage.searchable_fields).toEqual(['preview']);
  });

  it('caps matches at the caller limit with truthful truncation', async () => {
    const backend = createBackend();
    const page = await backend.searchConsumerThreads(searchInput({ query: 'a', limit: 2 }), signal());
    expect(page.matches).toHaveLength(2);
    expect(page.truncated).toBe(true);
  });

  it('fails closed when the Messenger control is not recognized', async () => {
    variant = 'no-control';
    const backend = createBackend();
    await expectProviderError(
      backend.listConsumerThreads(listInput(), signal()),
      'UPSTREAM_ERROR',
      'The Facebook Messenger menu control was not recognized.'
    );
  });

  it('contains a load that navigated into a conversation without reading it', async () => {
    variant = 'auto-open';
    const backend = createBackend();
    await expectProviderError(
      backend.listConsumerThreads(listInput(), signal()),
      'UPSTREAM_ERROR',
      'The Facebook Messenger menu load navigated into a conversation; the read was aborted without inspecting it.'
    );
    // The navigation happened (evidence in the request log); the tool returned an error, never
    // content, and makes no claim about receipts either way.
    expect(requests).toContain('/messages/t/999999999999999/');
  });

  it('fails closed with conflicting keys in one row', async () => {
    variant = 'conflicting';
    const backend = createBackend();
    await expectProviderError(
      backend.listConsumerThreads(listInput(), signal()),
      'UPSTREAM_ERROR',
      'The Facebook Messenger menu could not be read as a verified conversation list.'
    );
  });

  it('stays a diagnostics-only surface under probe-only mode', async () => {
    const backend = createBackend({ probeOnly: true });
    await expect(backend.listConsumerThreads(listInput(), signal())).rejects.toMatchObject({ name: 'SurfaceDisabledError' });
    await expect(backend.searchConsumerThreads(searchInput(), signal())).rejects.toMatchObject({ name: 'SurfaceDisabledError' });
  });
});
