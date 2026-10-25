import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, errors } from 'playwright';
import type { Page } from 'playwright';
import { BrowserSessionManager } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { threadsListInputSchema, threadReadInputSchema, threadSendInputSchema } from '../src/domain.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

const fixtureDir = new URL('./fixtures/facebook-messenger/', import.meta.url);
const fixtures = new Map([
  'inbox-normal.html', 'inbox-empty.html', 'inbox-login.html', 'inbox-checkpoint.html', 'inbox-layout-changed.html',
  'inbox-buttons-graphql.html', 'inbox-buttons-graphql-delayed.html', 'inbox-buttons-graphql-paginated.html', 'inbox-buttons-graphql-stalled.html',
  'inbox-graphql-error-dom.html',
  'thread-normal.html', 'thread-layout-changed.html', 'thread-articles-unattributed.html', 'thread-empty.html', 'thread-token-bounds.html',
  'thread-composer.html', 'thread-no-composer.html', 'thread-two-composers.html'
].map((name) => [name, readFileSync(new URL(name, fixtureDir), 'utf8')]));

let server: Server;
let origin: string;
let inboxFixture = 'inbox-normal.html';
let threadFixture = 'thread-normal.html';
let hangInbox = false;
let hangThread = false;
let graphqlPayload: unknown = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } };
let graphqlContentType = 'application/json; charset=utf-8';
let graphqlPayloads: unknown[] | undefined;
let graphqlResponseIndex = 0;
const stalledResponses = new Set<ServerResponse<IncomingMessage>>();
let inboxRedirectTarget: string | undefined;
let threadRedirectTarget: string | undefined;
const requests: string[] = [];
const managers: BrowserSessionManager[] = [];
const profileDirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(request.url ?? pathname);
    if (pathname === '/api/graphql/inbox') {
      const responsePayload = graphqlPayloads?.[graphqlResponseIndex++] ?? graphqlPayload;
      const body = JSON.stringify(responsePayload);
      response.writeHead(200, { 'content-type': graphqlContentType, 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (pathname === '/api/graphql/inbox-stall') {
      // Send headers but never end the body: each request stalls until the test closes the
      // response. The body's read must race against the per-read 2s timeout.
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked' });
      response.write(':');
      stalledResponses.add(response);
      response.on('close', () => { stalledResponses.delete(response); });
      return;
    }
    if (pathname === '/api/graphql/other') {
      // A same-origin response for a different operation that still embeds the inbox connection
      // name: operation validation, not shape alone, must reject it.
      const body = JSON.stringify({ data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [
        { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '99999999' }, id: 'message_thread:99999999' } }
      ] } } } });
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (hangInbox && pathname === '/marketplace/inbox/') return;
    if (hangThread && /^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) return;
    // Redirect hooks simulate Facebook canonicalizing or moving an address; the redirect target
    // is served by the ordinary route table so only the URL assertion can tell the difference.
    if (inboxRedirectTarget && pathname === '/marketplace/inbox/') {
      response.writeHead(302, { location: inboxRedirectTarget });
      response.end();
      return;
    }
    if (threadRedirectTarget && pathname !== threadRedirectTarget && /^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) {
      response.writeHead(302, { location: threadRedirectTarget });
      response.end();
      return;
    }
    let name: string | undefined;
    if (pathname === '/marketplace/inbox/' || pathname === '/messages/') name = inboxFixture;
    else if (/^\/messages\/t\/[A-Za-z0-9._-]+\/$/.test(pathname)) name = threadFixture;
    const html = name ? fixtures.get(name) : undefined;
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
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
});

afterEach(async () => {
  expect(requests.every((request) => /^\/(?:api\/graphql\/[^?]*|messages\/|marketplace\/inbox\/|messages\/t\/[A-Za-z0-9._-]+\/)$/.test(request))).toBe(true);
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  for (const stalled of Array.from(stalledResponses)) {
    stalled.end();
    stalledResponses.delete(stalled);
  }
  requests.length = 0;
  inboxFixture = 'inbox-normal.html';
  threadFixture = 'thread-normal.html';
  hangInbox = false;
  hangThread = false;
  inboxRedirectTarget = undefined;
  threadRedirectTarget = undefined;
  graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } };
  graphqlContentType = 'application/json; charset=utf-8';
  graphqlPayloads = undefined;
  graphqlResponseIndex = 0;
});

function configure(nextInbox = 'inbox-normal.html', nextThread = 'thread-normal.html', nextHangInbox = false, nextHangThread = false): void {
  inboxFixture = nextInbox;
  threadFixture = nextThread;
  hangInbox = nextHangInbox;
  hangThread = nextHangThread;
  graphqlPayloads = undefined;
  graphqlResponseIndex = 0;
  requests.length = 0;
}

function createBackend(options: { settleTimeoutMs?: number; maxThreads?: number } = {}): FacebookMessengerBackend {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-messenger-test-'));
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
    settleTimeoutMs: options.settleTimeoutMs ?? 50,
    ...(options.maxThreads !== undefined ? { maxThreads: options.maxThreads } : {}),
    logger: { error: () => undefined }
  });
}

const listInput = (overrides: Record<string, unknown> = {}) => threadsListInputSchema.parse({ limit: 10, ...overrides });
const readInput = (threadId = '1684432532') => threadReadInputSchema.parse({ thread_id: threadId });
function expectProviderError(promise: Promise<unknown>, code: ProviderError['code'], message?: string) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderError', code, ...(message ? { message } : {}) });
}
const sendInput = (overrides: Record<string, unknown> = {}) =>
  threadSendInputSchema.parse({
    thread_id: '1684432532',
    message: 'Is the blue desk still available?',
    idempotency_token: 'tok-abc123def456ghij',
    ...overrides
  });

// The serialized send task receives its page through the browser's runExclusive seam. Driving
// that seam with a controlled page rejects one page operation in isolation — the composer
// contract check (pre-Enter) or the Enter press (post-Enter) — without launching a real browser,
// so these cases run even when Chromium is unavailable.
function controlledMessengerPage(options: { composerCount: number; rejectPress?: unknown }): Record<string, unknown> {
  const url = 'http://127.0.0.1/messages/t/1684432532/';
  const threadPage = {
    url,
    signals: {
      hasPasswordInput: false, hasLoginForm: false, hasCheckpointForm: false, hasCaptchaFrame: false,
      hasMainLandmark: true, hasAuthenticatedMarker: true, hasLoginPrompt: false,
      mentionsCheckpoint: false, mentionsCaptcha: false
    },
    messages: [{ sender: 'other', senderName: 'Synthetic Seller', text: 'Hello' }]
  };
  return {
    goto: async () => undefined,
    evaluate: async (_fn: unknown, arg: unknown) => {
      const a = (arg ?? {}) as { selector?: unknown };
      return a.selector !== undefined ? { url, composerCount: options.composerCount } : threadPage;
    },
    locator: () => ({ focus: async () => undefined }),
    keyboard: {
      type: async () => undefined,
      press: async () => { if (options.rejectPress !== undefined) throw options.rejectPress; }
    }
  };
}

function driveSendWithPage(backend: FacebookMessengerBackend, page: Record<string, unknown>): void {
  const manager = backend['browser'];
  const implementation = (async (
    signal: AbortSignal,
    task: (page: Page, signal: AbortSignal) => Promise<never>
  ) => task(page as unknown as Page, signal)) as unknown as typeof manager['runExclusive'];
  vi.spyOn(manager, 'runExclusive').mockImplementation(implementation);
}

describe('Messenger probe-only diagnostics', () => {
  it.each(['login', 'authenticated', 'captcha', 'checkpoint', 'ambiguous'] as const)(
    'never attempts login or opens a thread after a %s probe', async (state) => {
      const backend = createBackend();
      const result = state === 'login'
        ? { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' } as const
        : state === 'captcha'
          ? { status: 'session_needs_reauth', outcome: 'captcha', code: 'CAPTCHA_REQUIRED' } as const
          : state === 'checkpoint'
            ? { status: 'session_needs_reauth', outcome: 'checkpoint', code: 'SESSION_INVALID' } as const
            : state === 'authenticated'
              ? { status: 'session_usable', outcome: 'messages_authenticated' } as const
              : { status: 'session_unknown', outcome: 'ambiguous' } as const;
      const probe = vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue(result);
      const login = new FacebookCredentialLogin({ browser: backend['browser'], username: 'synthetic-user', password: 'synthetic-password' });
      const attempt = vi.spyOn(login, 'attempt');
      const diagnosticBackend = new FacebookMessengerBackend({
        browser: backend['browser'], probe: backend['probe'], login, probeOnly: true
      });
      const sessionCode = 'code' in result ? result.code : undefined;
      if (sessionCode !== undefined) {
        // A genuinely unusable session still reports its provider session code; probe-only only
        // changes the code for a usable (or unverifiable) session, whose surface is config-disabled.
        await expectProviderError(diagnosticBackend.listThreads(listInput(), new AbortController().signal), sessionCode);
        await expectProviderError(diagnosticBackend.readThread(readInput(), new AbortController().signal), sessionCode);
      } else {
        await expect(diagnosticBackend.listThreads(listInput(), new AbortController().signal))
          .rejects.toMatchObject({ name: 'SurfaceDisabledError', code: 'SURFACE_DISABLED' });
        await expect(diagnosticBackend.readThread(readInput(), new AbortController().signal))
          .rejects.toMatchObject({ name: 'SurfaceDisabledError', code: 'SURFACE_DISABLED' });
      }
      expect(probe).toHaveBeenCalledTimes(2);
      expect(attempt).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      await diagnosticBackend.close();
    });
});

describe.skipIf(!browserAvailable)('Facebook Messenger backend', () => {
  it('lists threads from the isolated Messenger inbox and applies caller limits', async () => {
    configure();
    const backend = createBackend();
    const threads = await backend.listThreads(listInput({ limit: 2 }), new AbortController().signal);
    expect(backend.name).toBe('facebook');
    expect(threads).toEqual([
      { thread_id: '1684432532', preview: 'Synthetic Seller: Is the desk available?' },
      { thread_id: '1684432533', preview: 'Sample Buyer: Thanks for the details.Listing details', item_id: '123456789' }
    ]);
    expect(requests).toEqual(['/marketplace/inbox/', '/marketplace/inbox/']);
  });

  it('lists deduplicated ids from a passive GraphQL response on a button-only page', async () => {
    configure('inbox-buttons-graphql.html');
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [
      { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '87654321' }, id: 'message_thread:87654321', snippet: 'OPAQUE-SNIPPET-SENTINEL' } },
      { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '87654321' }, id: 'message_thread:87654321' } },
      { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '87654322' } } }
    ], page_info: { has_next_page: false, end_cursor: null } } } } };
    const backend = createBackend();
    const threads = await backend.listThreads(listInput(), new AbortController().signal);
    expect(threads).toEqual([{ thread_id: '87654321' }, { thread_id: '87654322' }]);
    const serialized = JSON.stringify(threads);
    // The unrelated same-origin operation and every unapproved field stay out of the result.
    expect(serialized).not.toContain('99999999');
    expect(serialized).not.toContain('OPAQUE-SNIPPET-SENTINEL');
    expect(serialized).not.toContain('marketplaceInboxBuyerMessageThreads');
    expect(serialized).not.toContain('thread_key');
    expect(requests).toContain('/api/graphql/inbox');
    expect(requests).toContain('/api/graphql/other');
  }, 15_000);

  it('does not fall back to DOM links when a verified inbox response has no connection', async () => {
    configure('inbox-graphql-error-dom.html');
    graphqlPayload = { errors: [{ message: 'synthetic GraphQL failure' }] };
    const backend = createBackend();
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'UPSTREAM_ERROR');
  }, 15_000);

  it('does not fall back to DOM links when a verified inbox response is not JSON', async () => {
    configure('inbox-graphql-error-dom.html');
    graphqlContentType = 'text/plain; charset=utf-8';
    const backend = createBackend();
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'UPSTREAM_ERROR');
  }, 15_000);

  it('lists bounded IDs from a fully observed two-page cursor chain', async () => {
    configure('inbox-buttons-graphql-paginated.html');
    const firstPageIds = Array.from({ length: 12 }, (_value, index) => String(10000001 + index));
    const secondPageIds = Array.from({ length: 12 }, (_value, index) => String(10000013 + index));
    const payload = (threadIds: string[], hasNextPage: boolean, endCursor: string) => ({
      data: { viewer: { marketplaceInboxBuyerMessageThreads: {
        edges: threadIds.map((threadId) => ({ node: {
          __typename: 'MessageThread', thread_key: { thread_fbid: threadId }, id: `message_thread:${threadId}`
        } })),
        page_info: { has_next_page: hasNextPage, end_cursor: endCursor }
      } } }
    });
    const firstPage = payload(firstPageIds, true, 'cursor-one');
    const secondPage = payload(secondPageIds, false, 'cursor-two');
    // Session verification performs its own inbox navigation before the listing navigation.
    graphqlPayloads = [firstPage, secondPage, firstPage, secondPage];
    const backend = createBackend({ settleTimeoutMs: 500 });
    let threads: Awaited<ReturnType<typeof backend.listThreads>> = [];
    let listingError: unknown;
    try {
      threads = await backend.listThreads(listInput({ limit: 20 }), new AbortController().signal);
    } catch (error) {
      listingError = error;
    }

    expect(graphqlResponseIndex).toBe(4);
    expect(listingError).toBeUndefined();
    expect(threads.map(({ thread_id }) => thread_id)).toEqual([...firstPageIds, ...secondPageIds.slice(0, 8)]);
  }, 15_000);

  it('captures a GraphQL response that lands after the first DOM read but within the settle budget', async () => {
    configure('inbox-buttons-graphql-delayed.html');
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [
      { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '55550000' }, id: 'message_thread:55550000' } }
    ], page_info: { has_next_page: false, end_cursor: null } } } } };
    const backend = createBackend({ settleTimeoutMs: 1_500 });
    const threads = await backend.listThreads(listInput(), new AbortController().signal);
    expect(threads).toEqual([{ thread_id: '55550000' }]);
  }, 15_000);

  it('uses a valid empty GraphQL connection and rejects absent or malformed connections', async () => {
    configure('inbox-buttons-graphql.html');
    const backend = createBackend({ settleTimeoutMs: 30 });
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } };
    await expect(backend.listThreads(listInput(), new AbortController().signal)).resolves.toEqual([]);

    configure('inbox-buttons-graphql.html');
    graphqlPayload = { data: { viewer: {} } };
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'UPSTREAM_ERROR');

    configure('inbox-buttons-graphql.html');
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [{ node: { __typename: 'MessageThread', thread_key: { thread_fbid: 'bad id' } } }], page_info: { has_next_page: false, end_cursor: null } } } } };
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'UPSTREAM_ERROR');
  }, 30_000);

  it('fails closed when the inbox connection is paginated and the current slice is empty', async () => {
    configure('inbox-buttons-graphql.html');
    const backend = createBackend({ settleTimeoutMs: 30 });
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: {
      edges: [],
      page_info: { has_next_page: true, end_cursor: 'NEXT_PAGE_TOKEN_SENTINEL' }
    } } } };
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Marketplace inbox pagination could not be verified; a complete thread list cannot be returned.'
    );
  }, 15_000);

  it('fails closed for non-empty thread ids when terminal pagination is unverified', async () => {
    configure('inbox-buttons-graphql.html');
    const backend = createBackend({ settleTimeoutMs: 30 });
    graphqlPayload = { data: { viewer: { marketplaceInboxBuyerMessageThreads: { edges: [
      { node: { __typename: 'MessageThread', thread_key: { thread_fbid: '87654321' }, id: 'message_thread:87654321' } }
    ] } } } };
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Marketplace inbox pagination could not be verified; a complete thread list cannot be returned.'
    );
  }, 15_000);

  it('bounds the total GraphQL flush deadline so multiple stalled responses cannot serialize per-body timeouts', async () => {
    configure('inbox-buttons-graphql-stalled.html');
    // The fixture sends 10 fetch calls to /api/graphql/inbox-stall whose bodies never end.
    // Each body read races against a 2s timeout; the dispatcher must run them concurrently
    // and the flush must cap the total wait so the operation finishes within the flush budget
    // (3s by default) plus the navigation/settle budgets, not 10 × 2s serialized.
    const backend = createBackend({ settleTimeoutMs: 100 });
    const start = Date.now();
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Marketplace inbox pagination could not be verified; a complete thread list cannot be returned.'
    );
    const elapsed = Date.now() - start;
    // Allow generous headroom for browser startup, navigation, and fixture load but well under
    // the old worst case of ~20s for ten serialized body reads.
    expect(elapsed).toBeLessThan(15_000);
    // The dispatched reads should still be in flight (or just settled) when the operation
    // returns; the listener cleanup must not hang waiting for the never-ending bodies.
    expect(stalledResponses.size).toBeGreaterThan(0);
  }, 30_000);

  it('returns empty only for a recognized empty inbox', async () => {
    configure('inbox-empty.html');
    const backend = createBackend();
    await expect(backend.listThreads(listInput(), new AbortController().signal)).resolves.toEqual([]);
  });

  it('fails closed when the inbox layout changes', async () => {
    configure('inbox-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Marketplace inbox page layout was not recognized.'
    );
  });

  it('requires login when the Messenger probe sees a login form and no credentials are configured', async () => {
    configure('inbox-login.html');
    const backend = createBackend();
    await expectProviderError(
      backend.listThreads(listInput(), new AbortController().signal),
      'LOGIN_REQUIRED',
      'Facebook login is required to read Marketplace conversations.'
    );
    expect(requests).toEqual(['/marketplace/inbox/']);
  });

  it('uses the shared credential recovery path after a Messenger login probe', async () => {
    configure();
    const backend = createBackend();
    let probeCount = 0;
    vi.spyOn(backend['probe'], 'probeSession').mockImplementation(async () => {
      probeCount += 1;
      if (probeCount === 1) return { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' };
      return { status: 'session_usable', outcome: 'messages_authenticated' };
    });
    const login = new FacebookCredentialLogin({ browser: backend['browser'], username: 'synthetic-user', password: 'synthetic-password' });
    const attempt = vi.spyOn(login, 'attempt').mockResolvedValue({ outcome: 'authenticated' });
    const credentialBackend = new FacebookMessengerBackend({
      browser: backend['browser'], probe: backend['probe'], login, logger: { error: () => undefined }
    });

    await expect(credentialBackend.listThreads(listInput({ limit: 1 }), new AbortController().signal)).resolves.toHaveLength(1);
    expect(probeCount).toBe(2);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reads attributed messages and echoes the requested thread id', async () => {
    configure();
    const backend = createBackend();
    const result = await backend.readThread(readInput(), new AbortController().signal);
    expect(result).toMatchObject({
      thread_id: '1684432532',
      messages: [
        { sender: 'other', sender_name: 'Synthetic Seller', text: 'Hello there.10:30' },
        { sender: 'you', text: 'Is the desk available?' },
        { sender: 'other', sender_name: 'Synthetic Seller', text: 'Yes, it is available.10:30' },
        { sender: 'other', sender_name: 'Example Buyer', text: 'Could I pick it up tomorrow?' }
      ],
      // The six synthetic rows all fit the bounded window (two are not attributed messages),
      // so the read proves an untruncated tail-anchored scan.
      coverage: { window: 'tail', scanned_rows: 6, truncated: false }
    });
    expect(requests).toEqual(['/marketplace/inbox/', '/messages/t/1684432532/']);
  });

  it.each([
    ['thread-layout-changed.html', 'The Facebook Messenger thread page layout was not recognized.'],
    ['thread-articles-unattributed.html', 'The Facebook Messenger article message layout is unsupported; sender attribution was not verified.'],
    ['thread-empty.html', 'The Facebook Messenger empty thread layout could not be verified.']
  ])('fails closed for unrecognized thread fixture %s', async (fixture, message) => {
    configure('inbox-normal.html', fixture);
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.readThread(readInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      message
    );
  });

  it('reads bounded attributed token text through the backend without inventing delivery confirmation', async () => {
    configure('inbox-normal.html', 'thread-token-bounds.html');
    const result = await createBackend().readThread(readInput(), new AbortController().signal);
    expect(result?.messages.map((message) => ({ sender: message.sender, containsToken: message.text.includes('[synthetic-reply-token]') })))
      .toEqual([
        { sender: 'you', containsToken: true },
        { sender: 'other', containsToken: true },
        { sender: 'you', containsToken: false }
      ]);
    expect(result?.messages[0]?.text).toHaveLength(2000);
    expect(result).not.toHaveProperty('status');
  });

  it('honors cancellation promptly with the exact abort reason', async () => {
    configure();
    const backend = createBackend();
    const controller = new AbortController();
    const reason = new Error('cancel Messenger read');
    const operation = backend.listThreads(listInput(), controller.signal);
    const deadline = Date.now() + 5_000;
    while (!requests.includes('/marketplace/inbox/') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
  });

  it('maps a hanging inbox navigation to TIMEOUT', async () => {
    configure('inbox-normal.html', 'thread-normal.html', true);
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    await expectProviderError(backend.listThreads(listInput(), new AbortController().signal), 'TIMEOUT');
  }, 10_000);

  it('does not trust inbox content served from a redirected address', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // The redirect target serves the same inbox content; only the final URL can tell the
    // difference, and trusting it would mean reading whatever page Facebook redirected to.
    inboxRedirectTarget = '/messages/';
    await expect(backend.listThreads(listInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Marketplace inbox page was not reached at the expected address.'
    });
    await backend.close();
  }, 15_000);

  it('does not return another conversation for a redirected thread id', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    threadRedirectTarget = '/messages/t/99999/';
    await expect(backend.readThread(readInput(), new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'The Facebook Messenger thread page was not reached at the requested thread.'
    });
    await backend.close();
  }, 15_000);

  it('validates constructor bounds', () => {
    const backend = createBackend();
    expect(backend.name).toBe('facebook');
    expect(() => new FacebookMessengerBackend({ browser: {} as BrowserSessionManager, probe: {} as FacebookSessionProbe })).toThrow(TypeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), maxThreads: 0 })).toThrow(RangeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), inboxPath: '//elsewhere.invalid/' })).toThrow(TypeError);
    // setTimeout coerces delays above 2^31-1 ms to 1, so construction must reject them instead.
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), navigationTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), settleTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), graphqlFlushTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(new FacebookMessengerBackend({ browser: managers.at(-1)!, probe: new FacebookSessionProbe({ browser: managers.at(-1)!, baseUrl: origin }), navigationTimeoutMs: 2_147_483_647, settleTimeoutMs: 2_147_483_647, graphqlFlushTimeoutMs: 2_147_483_647 }).name)
      .toBe('facebook');
  });
});

describe.skipIf(!browserAvailable)('Facebook Messenger backend send', () => {
  it('sends into the recognized composer and the typed text is observable on the page', async () => {
    configure(undefined, 'thread-composer.html');
    const backend = createBackend();
    await backend.sendThread(sendInput(), new AbortController().signal);
    // Re-navigate with the same persistent profile; the fixture mirrors the last sent text
    // into a hidden input from persistent storage. That hidden value is the page-side signal
    // that the typed text reached the page (no content is read out of the send itself).
    const manager = backend['browser'];
    const lastSent = await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${origin}/messages/t/1684432532/`, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => (document.getElementById('last-sent') as HTMLInputElement | null)?.value ?? '');
    });
    expect(lastSent).toBe('Is the blue desk still available? [tok-abc123def456ghij]');
  });

  it('fails closed with the composer error when no contract composer is present', async () => {
    configure(undefined, 'thread-no-composer.html');
    const backend = createBackend();
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger message composer was not recognized.'
    );
  });

  it('fails closed with the composer error when two composers make it ambiguous', async () => {
    configure(undefined, 'thread-two-composers.html');
    const backend = createBackend();
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger message composer was not recognized.'
    );
  });

  it('fails closed before typing when the thread page is not a recognized thread page', async () => {
    configure(undefined, 'thread-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    await expectProviderError(
      backend.sendThread(sendInput(), new AbortController().signal),
      'UPSTREAM_ERROR',
      'The Facebook Messenger thread could not be verified before sending.'
    );
  });

  it('maps a hanging thread navigation to TIMEOUT', async () => {
    configure(undefined, 'thread-composer.html', false, true);
    const backend = createBackend();
    await expectProviderError(backend.sendThread(sendInput(), new AbortController().signal), 'TIMEOUT');
  }, 10_000);

  it('rejects with the exact abort reason when aborted during a send', async () => {
    // The unknown layout keeps the pre-send settle loop running, giving the abort a reliable
    // window to land while the serialized browser operation is still in flight.
    configure(undefined, 'thread-layout-changed.html');
    const backend = createBackend({ settleTimeoutMs: 200 });
    const controller = new AbortController();
    const reason = new Error('cancel Messenger send');
    const operation = backend.sendThread(sendInput(), controller.signal);
    const deadline = Date.now() + 5_000;
    while (!requests.includes('/messages/t/1684432532/') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
  });
});

// These cases drive the send task through the runExclusive page-seam with a controlled page, so
// they need no real browser and run regardless of whether Chromium is available.
describe('Facebook Messenger backend send submit-triggered metadata', () => {
  it('tags a post-Enter failure with submit_triggered and maps its code to TIMEOUT', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // A present composer carries the task through the focus/type steps to the Enter press, which
    // is rejected after submitTriggered has been set. The rejection is a Playwright timeout, so it
    // must map to TIMEOUT and carry submit_triggered (never reported as a clean unsent failure).
    driveSendWithPage(backend, controlledMessengerPage({
      composerCount: 1,
      rejectPress: new errors.TimeoutError('the Enter press failed after the submit was dispatched')
    }));
    const error = (await backend.sendThread(sendInput(), new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toBe('The Messenger send did not complete in time.');
    expect(error.metadata.submit_triggered).toBe(true);
  });

  it('does not tag a pre-Enter composer classification failure with submit_triggered', async () => {
    configure();
    const backend = createBackend();
    vi.spyOn(backend['probe'], 'probeSession').mockResolvedValue({
      status: 'session_usable', outcome: 'messages_authenticated'
    });
    // An absent (count 0) composer rejects before any typing or Enter press, so the thrown error
    // is the original pre-Enter upstream error and must carry no submit_triggered metadata.
    driveSendWithPage(backend, controlledMessengerPage({ composerCount: 0 }));
    const error = (await backend.sendThread(sendInput(), new AbortController().signal).catch((e) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The Facebook Messenger message composer was not recognized.');
    expect(error.metadata).not.toHaveProperty('submit_triggered');
  });
});

describe('Facebook Messenger backend prepareDraft', () => {
  const draftInput = sendInput();

  it('names the last counterparty sender from the thread read and never sends', async () => {
    const backend = createBackend();
    const sendThread = vi.spyOn(backend, 'sendThread');
    vi.spyOn(backend, 'readThread').mockResolvedValue({
      thread_id: draftInput.thread_id,
      messages: [
        { sender: 'other' as const, sender_name: 'First Buyer', text: 'Is it available?' },
        { sender: 'you' as const, text: 'Yes it is.' },
        { sender: 'other' as const, sender_name: 'Second Buyer', text: 'Can you hold it?' }
      ]
    });

    await expect(backend.prepareDraft(draftInput, new AbortController().signal))
      .resolves.toEqual({ participant: 'Second Buyer' });
    // Drafting reads the thread for conversation context only: it must never touch the send path.
    expect(sendThread).not.toHaveBeenCalled();
  });

  it('reports a null participant rather than a fabricated handle when no counterparty is attributed', async () => {
    const backend = createBackend();
    // Extraction drops rows with an empty or over-bound sender name, so an unattributed thread is
    // ordinary and must not be reported as though the counterparty were known.
    vi.spyOn(backend, 'readThread').mockResolvedValue({
      thread_id: draftInput.thread_id,
      messages: [{ sender: 'you' as const, text: 'Yes it is.' }]
    });

    await expect(backend.prepareDraft(draftInput, new AbortController().signal))
      .resolves.toEqual({ participant: null });
  });

  it('reports an absent thread as null so the tool can answer NOT_FOUND', async () => {
    const backend = createBackend();
    vi.spyOn(backend, 'readThread').mockResolvedValue(null);

    await expect(backend.prepareDraft(draftInput, new AbortController().signal)).resolves.toBeNull();
  });
});
