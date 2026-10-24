import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { BrowserSessionManager as BrowserManager, BrowserUnavailableError, type BrowserSessionOptions } from '../src/browser.js';
import { ProviderError } from '../src/backend.js';
import { runBackendOperation } from '../src/tools.js';
import {
  classifyFacebookSession,
  FACEBOOK_ORIGIN,
  FacebookSessionProbe,
  readFacebookPage,
  type FacebookCaptchaSignals,
  type FacebookPageSnapshot,
  type FacebookSessionProbeOptions
} from '../src/facebook.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

type SyntheticMode = 'authenticated' | 'logged-out-shell' | 'login' | 'login-page' | 'checkpoint' | 'captcha' | 'ambiguous' | 'slow';

type SyntheticServer = {
  server: Server;
  origin: string;
  requests: string[];
  setMode(mode: SyntheticMode): void;
  close(): Promise<void>;
};

let synthetic: SyntheticServer;
const profileDirs: string[] = [];
const managers: BrowserManager[] = [];

beforeAll(async () => {
  synthetic = await startSyntheticServer();
});

afterAll(async () => {
  await synthetic?.close();
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
  synthetic.setMode('authenticated');
});

const baseSnapshot = (overrides: Partial<FacebookPageSnapshot> = {}): FacebookPageSnapshot => ({
  url: 'http://127.0.0.1:3210/marketplace/',
  hasPasswordInput: false,
  hasLoginForm: false,
  hasCheckpointForm: false,
  hasCaptchaFrame: false,
  hasMainLandmark: true,
  hasMarketplaceLink: true,
  hasAuthenticatedMarker: true,
  hasLoginPrompt: false,
  mentionsCheckpoint: false,
  mentionsCaptcha: false,
  ...overrides
});

const noCaptchaSignals: FacebookCaptchaSignals = {
  iframeMatched: false, iframeVisible: false, idMatched: false, idVisible: false,
  testIdMatched: false, testIdVisible: false, textMatched: false, textVisible: false,
  captchaWordMatched: false, captchaWordVisible: false, notRobotMatched: false, notRobotVisible: false,
  verifyHumanMatched: false, verifyHumanVisible: false,
  authenticatedMarkerMatched: true, authenticatedMarkerVisible: true,
  mainLandmarkMatched: true, mainLandmarkVisible: true
};

describe('Messenger CAPTCHA visibility classification', () => {
  it('blocks hidden-only CAPTCHA markup even with authenticated markers or a login form', () => {
    for (const hasLoginForm of [false, true]) {
      const snapshot = baseSnapshot({ hasLoginForm, hasCaptchaFrame: true,
        captchaSignals: { ...noCaptchaSignals, idMatched: true } });
      expect(classifyFacebookSession(snapshot, synthetic.origin, 'messenger'))
        .toEqual({ status: 'session_unknown', outcome: 'ambiguous' });
    }
  });

  it.each(['iframe', 'id', 'testId', 'text'] as const)('keeps a visible %s CAPTCHA signal blocked despite auth markers', (signal) => {
    const snapshot = baseSnapshot({ hasCaptchaFrame: true, captchaSignals: {
      ...noCaptchaSignals, [`${signal}Matched`]: true, [`${signal}Visible`]: true
    } });
    expect(classifyFacebookSession(snapshot, synthetic.origin, 'messenger'))
      .toEqual({ status: 'session_needs_reauth', outcome: 'captcha', code: 'CAPTCHA_REQUIRED' });
  });

  it('logs only structural booleans and classifier enums, excluding URL and provider text', async () => {
    const manager = createManager();
    const logger = { error: vi.fn() };
    const probe = createProbe(manager, { surface: 'messenger', logger });
    vi.spyOn(probe as unknown as { loadSnapshot(): Promise<FacebookPageSnapshot> }, 'loadSnapshot')
      .mockResolvedValue(baseSnapshot({ url: `${synthetic.origin}/marketplace/inbox/?private=URL_SENTINEL`,
        hasCaptchaFrame: true, captchaSignals: { ...noCaptchaSignals, idMatched: true } }));
    vi.spyOn(manager, 'runExclusive').mockImplementation(async (_signal, task) => task({} as never, _signal));
    await probe.probeSession(new AbortController().signal);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [label, diagnostics] = logger.error.mock.calls[0]!;
    expect(label).toBe('Facebook Messenger probe diagnostics:');
    expect(diagnostics).toMatchObject({ idMatched: true, idVisible: false,
      hiddenOnlyCaptchaSignal: true, authenticatedMarkerMatched: true, sessionUsable: false });
    const safeEnums = new Set([
      'ambiguous', 'checkpoint', 'captcha', 'login_required', 'login_redirect',
      'marketplace_authenticated', 'messages_authenticated', 'session_unknown', 'session_usable', 'session_needs_reauth'
    ]);
    expect(Object.values(diagnostics).every((value) => typeof value === 'boolean' || safeEnums.has(String(value)))).toBe(true);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('URL_SENTINEL');
    expect(synthetic.requests).toEqual([]);
  });
});

describe.skipIf(!browserAvailable)('CAPTCHA structural extraction', () => {
  it.each([
    ['iframe', '<iframe src="about:blank#captcha"></iframe>', 'iframeMatched', 'iframeVisible'],
    ['id', '<div id="captcha-widget">Widget</div>', 'idMatched', 'idVisible'],
    ['test ID', '<div data-testid="captcha-widget">Widget</div>', 'testIdMatched', 'testIdVisible'],
    ['CAPTCHA word', '<p>CAPTCHA</p>', 'captchaWordMatched', 'captchaWordVisible'],
    ['robot text', "<p>I'm not a robot</p>", 'notRobotMatched', 'notRobotVisible'],
    ['human text', '<p>Verify you are a human</p>', 'verifyHumanMatched', 'verifyHumanVisible']
  ] as const)('identifies an isolated %s signal without returning provider content', async (_name, markup, matched, visible) => {
    const snapshot = await createManager().runExclusive(new AbortController().signal, async (page) => {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(markup);
      return readFacebookPage(page);
    });
    expect(snapshot.captchaSignals![matched]).toBe(true);
    expect(snapshot.captchaSignals![visible]).toBe(true);
    const sources = ['iframeMatched', 'idMatched', 'testIdMatched', 'captchaWordMatched', 'notRobotMatched', 'verifyHumanMatched'] as const;
    expect(sources.filter((key) => snapshot.captchaSignals![key])).toEqual([matched]);
  });

  it('waits for hidden markup to render within the settle budget', async () => {
    const manager = createManager();
    const probe = createProbe(manager, { surface: 'messenger', settleTimeoutMs: 1_000 });
    const snapshot = await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<main><div aria-label="Your account">Account</div><div id="captcha-widget" style="display:none">Widget</div></main>');
      vi.spyOn(page, 'goto').mockResolvedValue(null);
      await page.evaluate(() => { setTimeout(() => {
        document.getElementById('captcha-widget')!.style.display = 'block';
      }, 100); });
      return probe['loadSnapshot'](page, new AbortController().signal);
    });
    expect(snapshot.captchaSignals).toMatchObject({ idMatched: true, idVisible: true });
    expect(classifyFacebookSession(snapshot, synthetic.origin, 'messenger')).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
  });

  it.each(['', 'display:none', 'visibility:hidden', 'opacity:0'])(
    'separates matched signals from visibility under %s', async (style) => {
      const manager = createManager();
      const snapshot = await manager.runExclusive(new AbortController().signal, async (page) => {
        await page.route('**/*', (route) => route.abort());
        await page.setContent(`<main><a aria-label="Your account">PRIVATE_NAME_SENTINEL</a>
          <section style="${style}"><iframe src="about:blank#captcha"></iframe>
          <div id="captcha-sentinel">Widget</div><div data-testid="captcha-sentinel">Widget</div>
          <p>Verify you are a human</p></section></main>`);
        return readFacebookPage(page);
      });
      const visible = style === '';
      expect(snapshot.captchaSignals).toEqual({
        iframeMatched: true, iframeVisible: visible, idMatched: true, idVisible: visible,
        testIdMatched: true, testIdVisible: visible, textMatched: true, textVisible: visible,
        captchaWordMatched: false, captchaWordVisible: false, notRobotMatched: false, notRobotVisible: false,
        verifyHumanMatched: true, verifyHumanVisible: visible,
        authenticatedMarkerMatched: true, authenticatedMarkerVisible: true,
        mainLandmarkMatched: true, mainLandmarkVisible: true
      });
      expect(Object.values(snapshot.captchaSignals!).every((value) => typeof value === 'boolean')).toBe(true);
      expect(JSON.stringify(snapshot.captchaSignals)).not.toContain('PRIVATE_NAME_SENTINEL');
    });
});

describe('Facebook session classification', () => {
  it('uses the Messenger decisive condition only for the Messenger surface', () => {
    const messengerSnapshot = baseSnapshot({
      url: 'http://127.0.0.1:3210/messages/t/thread-1',
      hasMarketplaceLink: false
    });

    expect(classifyFacebookSession(messengerSnapshot, 'http://127.0.0.1:3210', 'messenger'))
      .toEqual({ status: 'session_usable', outcome: 'messages_authenticated' });
    expect(classifyFacebookSession(messengerSnapshot, 'http://127.0.0.1:3210'))
      .toEqual({ status: 'session_unknown', outcome: 'ambiguous' });
    expect(classifyFacebookSession({ ...messengerSnapshot, hasLoginPrompt: true }, 'http://127.0.0.1:3210', 'messenger'))
      .toEqual({ status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' });
    expect(classifyFacebookSession({ ...messengerSnapshot, url: 'https://elsewhere.example/messages/' }, 'http://127.0.0.1:3210', 'messenger'))
      .toEqual({ status: 'session_unknown', outcome: 'ambiguous' });
    expect(classifyFacebookSession({ ...messengerSnapshot, url: 'http://127.0.0.1:3210/marketplace/inbox/' }, 'http://127.0.0.1:3210', 'messenger'))
      .toEqual({ status: 'session_usable', outcome: 'messages_authenticated' });
    expect(classifyFacebookSession({ ...messengerSnapshot, url: 'https://elsewhere.example/marketplace/inbox/' }, 'http://127.0.0.1:3210', 'messenger'))
      .toEqual({ status: 'session_unknown', outcome: 'ambiguous' });
  });

  it.each([
    ['authenticated Marketplace page', baseSnapshot(), 'session_usable', 'marketplace_authenticated', undefined],
    ['Marketplace chrome without authentication marker', baseSnapshot({ hasAuthenticatedMarker: false }), 'session_unknown', 'ambiguous', undefined],
    ['Marketplace chrome with login prompt but no auth marker', baseSnapshot({ hasAuthenticatedMarker: false, hasLoginPrompt: true }), 'session_needs_reauth', 'login_required', 'LOGIN_REQUIRED'],
    ['authentication marker wins over login prompt', baseSnapshot({ hasLoginPrompt: true }), 'session_usable', 'marketplace_authenticated', undefined],
    ['login prompt on a non-Marketplace path', baseSnapshot({ url: 'http://127.0.0.1:3210/something-else', hasLoginPrompt: true }), 'session_needs_reauth', 'login_required', 'LOGIN_REQUIRED'],
    ['password input', baseSnapshot({ hasPasswordInput: true }), 'session_needs_reauth', 'login_required', 'LOGIN_REQUIRED'],
    ['login form', baseSnapshot({ hasLoginForm: true }), 'session_needs_reauth', 'login_required', 'LOGIN_REQUIRED'],
    ['login redirect URL', baseSnapshot({ url: 'http://127.0.0.1:3210/login/' }), 'session_needs_reauth', 'login_redirect', 'LOGIN_REQUIRED'],
    ['checkpoint URL', baseSnapshot({ url: 'http://127.0.0.1:3210/checkpoint/' }), 'session_needs_reauth', 'checkpoint', 'SESSION_INVALID'],
    ['checkpoint form', baseSnapshot({ hasCheckpointForm: true }), 'session_needs_reauth', 'checkpoint', 'SESSION_INVALID'],
    ['checkpoint copy', baseSnapshot({ mentionsCheckpoint: true }), 'session_needs_reauth', 'checkpoint', 'SESSION_INVALID'],
    ['captcha frame', baseSnapshot({ hasCaptchaFrame: true }), 'session_needs_reauth', 'captcha', 'CAPTCHA_REQUIRED'],
    ['captcha copy', baseSnapshot({ mentionsCaptcha: true }), 'session_needs_reauth', 'captcha', 'CAPTCHA_REQUIRED'],
    ['captcha before checkpoint', baseSnapshot({ hasCaptchaFrame: true, hasCheckpointForm: true }), 'session_needs_reauth', 'captcha', 'CAPTCHA_REQUIRED'],
    ['cross-origin Marketplace URL', baseSnapshot({ url: 'https://elsewhere.example/marketplace/' }), 'session_unknown', 'ambiguous', undefined],
    ['missing main landmark', baseSnapshot({ hasMainLandmark: false }), 'session_unknown', 'ambiguous', undefined],
    ['missing Marketplace link', baseSnapshot({ hasMarketplaceLink: false }), 'session_unknown', 'ambiguous', undefined],
    ['unrelated path', baseSnapshot({ url: 'http://127.0.0.1:3210/something-else' }), 'session_unknown', 'ambiguous', undefined],
    ['unparseable URL', baseSnapshot({ url: 'not a URL' }), 'session_unknown', 'ambiguous', undefined]
  ] as const)('classifies %s', (_label, snapshot, status, outcome, code) => {
    expect(classifyFacebookSession(snapshot, 'http://127.0.0.1:3210')).toEqual({
      status,
      outcome,
      ...(code ? { code } : {})
    });
  });
});

describe('Facebook session probe construction', () => {
  it('keeps Facebook as the default without starting a browser or creating a profile', () => {
    const manager = createManager();
    const profileDir = manager.profileDir;
    const probe = new FacebookSessionProbe({ browser: manager });

    expect(FACEBOOK_ORIGIN).toBe('https://www.facebook.com');
    expect(probe.probeUrl).toBe('https://www.facebook.com/marketplace/');
    expect(new FacebookSessionProbe({ browser: manager, surface: 'messenger' }).probeUrl).toBe('https://www.facebook.com/marketplace/inbox/');
    expect(() => new FacebookSessionProbe({ browser: manager, probePath: 'https://elsewhere.example/messages/' })).toThrow(TypeError);
    expect(() => new FacebookSessionProbe({ browser: manager, probePath: '//elsewhere.example/messages/' })).toThrow(TypeError);
    expect(manager.getInfo().browserStarted).toBe(false);
    expect(existsSync(profileDir)).toBe(false);
    expect(synthetic.requests).toEqual([]);
  });

  it('validates the injected origin and timeouts', () => {
    const manager = createManager();
    for (const baseUrl of [
      'http://example.com',
      'https://www.facebook.com/path',
      'https://www.facebook.com/?query=1',
      'https://www.facebook.com/#fragment',
      'https://user:pass@www.facebook.com',
      'file:///tmp/facebook',
      'https://www.facebook.com.evil.example',
      'https://evil.example',
      'https://m.facebook.com'
    ]) {
      expect(() => new FacebookSessionProbe({ browser: manager, baseUrl })).toThrow(TypeError);
    }

    expect(new FacebookSessionProbe({ browser: manager, baseUrl: 'http://127.0.0.1:1234' }).baseUrl)
      .toBe('http://127.0.0.1:1234');
    expect(new FacebookSessionProbe({ browser: manager, baseUrl: 'https://www.facebook.com' }).baseUrl)
      .toBe('https://www.facebook.com');
    expect(new FacebookSessionProbe({ browser: manager, baseUrl: 'http://localhost:3000' }).baseUrl)
      .toBe('http://localhost:3000');
    expect(() => new FacebookSessionProbe({ browser: manager, navigationTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookSessionProbe({ browser: manager, settleTimeoutMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError);
    // setTimeout coerces delays above 2^31-1 ms to 1, so construction must reject them instead.
    expect(() => new FacebookSessionProbe({ browser: manager, navigationTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => new FacebookSessionProbe({ browser: manager, settleTimeoutMs: 2_147_483_648 })).toThrow(RangeError);
    expect(new FacebookSessionProbe({ browser: manager, navigationTimeoutMs: 2_147_483_647, settleTimeoutMs: 2_147_483_647 }).baseUrl)
      .toBe('https://www.facebook.com');
    expect(() => new FacebookSessionProbe(null as unknown as FacebookSessionProbeOptions)).toThrow(TypeError);
    expect(() => new FacebookSessionProbe({ browser: {} as BrowserManager })).toThrow(TypeError);
  });
});

describe.skipIf(!browserAvailable)('Facebook session probe', () => {
  it('marks a Marketplace page with the expected content as authenticated', async () => {
    synthetic.setMode('authenticated');
    const manager = createManager();
    const result = await createProbe(manager).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_usable', outcome: 'marketplace_authenticated' });
    expect(manager.getInfo().status).toBe('session_usable');
  });

  it('leaves the previous assessment untouched when the probe never starts', async () => {
    const manager = createManager();
    const probe = createProbe(manager);
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });
    expect(manager.getInfo().status).toBe('session_usable');

    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await expect(probe.probeSession(controller.signal)).rejects.toThrow('pre-aborted');
    expect(manager.getInfo().status).toBe('session_usable');
  });

  it('classifies a login redirect and updates the browser assessment', async () => {
    synthetic.setMode('login');
    const manager = createManager();
    const result = await createProbe(manager).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_needs_reauth', outcome: 'login_redirect', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_needs_reauth');
  });

  it('classifies a login form without a redirect', async () => {
    synthetic.setMode('login-page');
    const result = await createProbe(createManager()).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' });
  });

  it('classifies a logged-out Marketplace shell as requiring login', async () => {
    synthetic.setMode('logged-out-shell');
    const manager = createManager();
    const result = await createProbe(manager).probeSession(new AbortController().signal);

    expect(result).not.toMatchObject({ status: 'session_usable' });
    expect(result).toEqual({ status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' });
    expect(manager.getInfo().status).toBe('session_needs_reauth');
  });

  it('classifies a checkpoint redirect', async () => {
    synthetic.setMode('checkpoint');
    const result = await createProbe(createManager()).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_needs_reauth', outcome: 'checkpoint', code: 'SESSION_INVALID' });
  });

  it('classifies a captcha challenge', async () => {
    synthetic.setMode('captcha');
    const result = await createProbe(createManager()).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_needs_reauth', outcome: 'captcha', code: 'CAPTCHA_REQUIRED' });
  });

  it('keeps an ambiguous page unknown instead of treating it as usable', async () => {
    synthetic.setMode('ambiguous');
    const manager = createManager();
    const result = await createProbe(manager).probeSession(new AbortController().signal);

    expect(result).toEqual({ status: 'session_unknown', outcome: 'ambiguous' });
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('clears a stale usable assessment before each probe, including mid-flight', async () => {
    const manager = createManager();
    const probe = createProbe(manager);
    await expect(probe.probeSession(new AbortController().signal)).resolves.toEqual({
      status: 'session_usable',
      outcome: 'marketplace_authenticated'
    });

    synthetic.setMode('login');
    const loginResult = await probe.probeSession(new AbortController().signal);
    expect(loginResult.status).toBe('session_needs_reauth');
    expect(manager.getInfo().status).not.toBe('session_usable');

    synthetic.requests.length = 0;
    synthetic.setMode('slow');
    const controller = new AbortController();
    const operation = probe.probeSession(controller.signal);
    await waitForRequest('/marketplace/');
    expect(manager.getInfo().status).toBe('session_unknown');
    controller.abort(new Error('test cancellation'));
    await expect(operation).rejects.toThrow('test cancellation');
  });

  it('rejects a slow page probe with the supplied cancellation reason', async () => {
    synthetic.requests.length = 0;
    synthetic.setMode('slow');
    const manager = createManager();
    const controller = new AbortController();
    const reason = new Error('test cancellation');
    const operation = createProbe(manager).probeSession(controller.signal);
    await waitForRequest('/marketplace/');
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(manager.getInfo().status).not.toBe('session_usable');
  });

  it('makes no external requests during a synthetic probe', async () => {
    synthetic.setMode('authenticated');
    const manager = createManager();
    const routed: string[] = [];
    const external: string[] = [];
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.context().route('**/*', async (route) => {
        const url = route.request().url();
        routed.push(url);
        if (!url.startsWith(synthetic.origin)) {
          external.push(url);
          await route.abort();
          return;
        }
        await route.continue();
      });
      await page.goto(`${synthetic.origin}/marketplace/`);
    });

    const result = await createProbe(manager).probeSession(new AbortController().signal);
    expect(result.status).toBe('session_usable');
    expect(routed.some((url) => url.startsWith(`${synthetic.origin}/marketplace/`))).toBe(true);
    expect(external).toEqual([]);
  });

  it('turns a failed Marketplace load into an upstream provider failure', async () => {
    const manager = createManager();
    const probe = new FacebookSessionProbe({
      browser: manager,
      baseUrl: 'http://127.0.0.1:1',
      navigationTimeoutMs: 2_000,
      settleTimeoutMs: 150,
      logger: { error: () => undefined }
    });

    const failure = await probe.probeSession(new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('obeys the backend deadline and recovers for the next probe', async () => {
    const manager = createManager();
    const probe = createProbe(manager);
    await probe.probeSession(new AbortController().signal);

    synthetic.setMode('slow');
    synthetic.requests.length = 0;
    const operation = runBackendOperation((signal) => probe.probeSession(signal), 300, new AbortController().signal);
    await waitForRequest('/marketplace/');
    await expect(operation).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(manager.getInfo().status).not.toBe('session_usable');

    synthetic.setMode('authenticated');
    await expect(probe.probeSession(new AbortController().signal)).resolves.toMatchObject({ status: 'session_usable' });
    expect(manager.getInfo().status).toBe('session_usable');
  });

  it('rethrows BrowserUnavailableError when the manager is closed', async () => {
    const manager = createManager();
    await manager.close();

    await expect(createProbe(manager).probeSession(new AbortController().signal))
      .rejects.toBeInstanceOf(BrowserUnavailableError);
  });
});

function createManager(options: BrowserSessionOptions = {}): BrowserManager {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-facebook-test-'));
  profileDirs.push(parent);
  const manager = new BrowserManager({ ...options, profileDir: join(parent, 'profile'), logger: { error: () => undefined } });
  managers.push(manager);
  return manager;
}

function createProbe(browser: BrowserManager, options: Partial<Omit<FacebookSessionProbeOptions, 'browser'>> = {}): FacebookSessionProbe {
  return new FacebookSessionProbe({
    browser,
    baseUrl: synthetic.origin,
    navigationTimeoutMs: 2_000,
    settleTimeoutMs: 150,
    ...options
  });
}

async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  let mode: SyntheticMode = 'authenticated';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/slow' || (pathname === '/marketplace/' && mode === 'slow')) return;
    if (pathname === '/captcha/challenge') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('');
      return;
    }
    if (pathname === '/marketplace/' && mode === 'login') {
      response.writeHead(302, { location: '/login/?next=%2Fmarketplace%2F' });
      response.end();
      return;
    }
    if (pathname === '/marketplace/' && mode === 'checkpoint') {
      response.writeHead(302, { location: '/checkpoint/?next=%2Fmarketplace%2F' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/login/') {
      response.end(loginPage());
      return;
    }
    if (pathname === '/checkpoint/') {
      response.end('<!doctype html><html><body><form action="/checkpoint/"></form><p>We detected unusual activity. Please confirm your identity.</p></body></html>');
      return;
    }
    if (pathname === '/marketplace/' && mode === 'login-page') {
      response.end(loginPage());
      return;
    }
    if (pathname === '/marketplace/' && mode === 'captcha') {
      response.end('<!doctype html><html><body><iframe src="/captcha/challenge"></iframe><p>Please complete the captcha to continue.</p></body></html>');
      return;
    }
    if (pathname === '/marketplace/' && mode === 'ambiguous') {
      response.end('<!doctype html><html><body><div>Loading</div></body></html>');
      return;
    }
    if (pathname === '/marketplace/' && mode === 'logged-out-shell') {
      response.end('<!doctype html><html><body><header><button>Log In</button></header><main><h1>Marketplace</h1><a href="/marketplace/category/1">Cars</a><p>Log in to continue</p></main></body></html>');
      return;
    }
    response.end('<!doctype html><html><body><header><div aria-label="Your account"></div></header><main><h1>Marketplace</h1><a href="/marketplace/category/1">Cars</a></main></body></html>');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setMode: (nextMode) => { mode = nextMode; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function loginPage(): string {
  return '<!doctype html><html><body><form action="/login/"><input type="password" name="pass"></form></body></html>';
}

function waitForRequest(pathname: string): Promise<void> {
  if (synthetic.requests.includes(pathname)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for request ${pathname} after 5000 ms`));
    }, 5_000);
    const poll = setInterval(() => {
      if (synthetic.requests.includes(pathname)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}
