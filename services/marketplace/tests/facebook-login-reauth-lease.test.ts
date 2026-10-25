import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { BrowserSessionManager, BrowserUnavailableError } from '../src/browser.js';
import { FACEBOOK_ORIGIN, FacebookSessionProbe } from '../src/facebook.js';
import { FACEBOOK_LOGIN_PATH, FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookLoginCircuitBreaker } from '../src/facebook-login-circuit-breaker.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { ReauthManager } from '../src/reauth.js';
import { searchInputSchema, threadsListInputSchema } from '../src/domain.js';
import { FakeReauthRuntime } from './helpers/fake-reauth-runtime.js';

/**
 * Evidence for one claim: a manual re-auth lease owns the browser profile for its whole
 * lifetime, and no credential is submitted by an attempt that *starts* while it does. Such an
 * attempt is refused and abandoned, so it spends no retry budget. The lease is the real
 * `ReauthManager` over the real `BrowserSessionManager`; only the Chromium launch is replaced, so
 * the suite stays browser-free and makes no network request.
 *
 * The lease also preempts an attempt that was already in flight when it started: the takeover
 * ends that attempt before it submits any credential, and the attempt is abandoned, so it spends
 * no retry budget either.
 */
const USERNAME_SENTINEL = 'USER-SENTINEL-1234';
const PASSWORD_SENTINEL = 'PASS-SENTINEL-5678';
const LEASE_REFUSAL_REASON = 'Interactive reauth session owns the browser profile';

const signal = (): AbortSignal => new AbortController().signal;
const search = searchInputSchema.parse({ query: 'bike', location: 'New York City' });
const threads = threadsListInputSchema.parse({ limit: 10 });

/**
 * A locator stand-in. It answers the counting reads the session snapshot performs and records
 * the values a credential submit would type.
 */
class FakeLocator {
  constructor(private readonly page: FakePage, private readonly types: boolean) {}

  async count(): Promise<number> {
    return 0;
  }

  filter(): FakeLocator {
    return this;
  }

  async evaluateAll(): Promise<boolean> {
    return false;
  }

  or(): FakeLocator {
    return this;
  }

  first(): FakeLocator {
    return this;
  }

  async click(): Promise<void> {}

  async waitFor(): Promise<void> {}

  async pressSequentially(value: string): Promise<void> {
    if (this.types) this.page.typedValues.push(value);
  }
}

/**
 * Holds a navigation to the Facebook login path until the test releases it, so a credential
 * attempt can be observed while it is still in flight. The held navigation resolves on release,
 * so the attempt it belongs to always concludes and nothing is left pending.
 */
class LoginNavigationGate {
  private reached = false;
  private readonly reachedPromise: Promise<void>;
  private readonly releasePromise: Promise<void>;
  private markReached!: () => void;
  private release!: () => void;

  constructor() {
    this.reachedPromise = new Promise<void>((resolve) => { this.markReached = resolve; });
    this.releasePromise = new Promise<void>((resolve) => { this.release = resolve; });
  }

  /** Holds a navigation to the Facebook login path until this gate is released. */
  async hold(url: string): Promise<void> {
    if (!url.includes(FACEBOOK_LOGIN_PATH)) return;
    if (!this.reached) {
      this.reached = true;
      this.markReached();
    }
    await this.releasePromise;
  }

  /** Resolves once a navigation to the Facebook login path is held. */
  async waitForHeld(): Promise<void> {
    await this.reachedPromise;
  }

  /** Releases the held navigation so the attempt it belongs to can conclude. */
  releaseHeld(): void {
    this.release();
  }
}

/**
 * A page stand-in that records every navigation and every typed value, so "no credentials were
 * submitted" is an observation rather than an absence.
 */
class FakePage {
  readonly navigations: string[] = [];
  readonly typedValues: string[] = [];
  enterPressed = false;
  private currentUrl = 'about:blank';

  constructor(private readonly loginNavigationGate?: LoginNavigationGate) {}

  async goto(url: string): Promise<null> {
    this.navigations.push(url);
    this.currentUrl = url;
    await this.loginNavigationGate?.hold(url);
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector === 'input[name="email"]' || selector === 'input[name="pass"]');
  }

  getByRole(): FakeLocator {
    return new FakeLocator(this, false);
  }

  getByText(): FakeLocator {
    return new FakeLocator(this, false);
  }

  readonly keyboard = {
    press: async (key: string): Promise<void> => {
      if (key === 'Enter') this.enterPressed = true;
    }
  };

  async evaluate(): Promise<undefined> {
    return undefined;
  }

  async close(): Promise<void> {}
}

/**
 * A browser context stand-in. The interactive instance hands the lease its single page; the
 * headless instance hands out pages to the credential path and records every one of them.
 */
class FakeBrowserContext {
  readonly pagesCreated: FakePage[] = [];
  /** Installed by a test that needs to hold the credential attempt's login navigation. */
  loginNavigationGate: LoginNavigationGate | undefined;

  constructor(private readonly leasePage?: FakePage) {}

  pages(): Page[] {
    return this.leasePage ? [this.leasePage as unknown as Page] : [];
  }

  async newPage(): Promise<Page> {
    const page = new FakePage(this.loginNavigationGate);
    this.pagesCreated.push(page);
    return page as unknown as Page;
  }

  once(): void {}

  async close(): Promise<void> {}
}

/**
 * The real browser session manager with the Playwright launch replaced. The headless path is
 * never taken while a lease owns the profile, so `headlessLaunches` stays zero unless the lease
 * stopped blocking the credential path.
 */
class FakeChromiumBrowser extends BrowserSessionManager {
  readonly headlessContext = new FakeBrowserContext();
  headlessLaunches = 0;

  protected override async loadPlaywright(): Promise<typeof import('playwright')> {
    this.headlessLaunches += 1;
    return {
      chromium: {
        launchPersistentContext: async () => this.headlessContext as unknown as BrowserContext
      }
    } as unknown as typeof import('playwright');
  }
}

const browsers: FakeChromiumBrowser[] = [];
const reauths: ReauthManager[] = [];
const runtimes: FakeReauthRuntime[] = [];
const profileDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(reauths.splice(0).map((reauth) => reauth.stop()));
  await Promise.allSettled(browsers.splice(0).map((browser) => browser.close()));
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stopAll()));
  for (const dir of profileDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createBrowser(label: string): FakeChromiumBrowser {
  const dir = mkdtempSync(join(tmpdir(), `marketplace-reauth-lease-${label}-`));
  profileDirs.push(dir);
  const browser = new FakeChromiumBrowser({
    profileDir: join(dir, 'profile'),
    logger: { error: () => undefined }
  });
  browsers.push(browser);
  return browser;
}

/**
 * Starts a real lease over the real browser manager. The Chromium launch is stubbed with a fake
 * context so the lease lifecycle -- start, active, stop -- runs for real without a browser.
 */
async function startLease(browser: FakeChromiumBrowser): Promise<{ reauth: ReauthManager; leasePage: FakePage }> {
  const runtime = new FakeReauthRuntime();
  runtimes.push(runtime);
  const leasePage = new FakePage();
  const interactive = new FakeBrowserContext(leasePage);
  vi.spyOn(browser, 'openInteractive').mockImplementation(async () => interactive as unknown as BrowserContext);
  const reauth = new ReauthManager({
    browser,
    runtime,
    leaseMs: 60_000,
    logger: { error: () => undefined, info: () => undefined }
  });
  reauths.push(reauth);
  await reauth.start();
  return { reauth, leasePage };
}

/** Timing overrides so a credential attempt that is (wrongly) permitted concludes quickly. */
const credentialTimings = {
  waitMs: 1_000,
  pollIntervalMs: 50,
  navigationTimeoutMs: 1_000,
  typingDelayMs: 1,
  consentTimeoutMs: 50,
  consentSettleMs: 50
};

function setupMarketplace(gate = new FacebookLoginCircuitBreaker()): {
  browser: FakeChromiumBrowser;
  login: FacebookCredentialLogin;
  backend: FacebookMarketplaceBackend;
  gate: FacebookLoginCircuitBreaker;
} {
  const browser = createBrowser('marketplace');
  const probe = new FacebookSessionProbe({ browser, baseUrl: FACEBOOK_ORIGIN });
  const login = new FacebookCredentialLogin({
    browser,
    username: USERNAME_SENTINEL,
    password: PASSWORD_SENTINEL,
    ...credentialTimings,
    logger: { error: () => undefined }
  });
  const backend = new FacebookMarketplaceBackend({
    browser,
    probe,
    login,
    loginGate: gate,
    logger: { error: () => undefined }
  });
  vi.spyOn(probe, 'probeSession').mockResolvedValue({
    status: 'session_needs_reauth',
    outcome: 'login_required',
    code: 'LOGIN_REQUIRED'
  });
  return { browser, login, backend, gate };
}

function setupMessenger(gate = new FacebookLoginCircuitBreaker()): {
  browser: FakeChromiumBrowser;
  login: FacebookCredentialLogin;
  backend: FacebookMessengerBackend;
  gate: FacebookLoginCircuitBreaker;
} {
  const browser = createBrowser('messenger');
  const probe = new FacebookSessionProbe({ browser, baseUrl: FACEBOOK_ORIGIN, surface: 'messenger' });
  const login = new FacebookCredentialLogin({
    browser,
    username: USERNAME_SENTINEL,
    password: PASSWORD_SENTINEL,
    surface: 'messenger',
    ...credentialTimings,
    logger: { error: () => undefined }
  });
  const backend = new FacebookMessengerBackend({
    browser,
    probe,
    login,
    loginGate: gate,
    logger: { error: () => undefined }
  });
  vi.spyOn(probe, 'probeSession').mockResolvedValue({
    status: 'session_needs_reauth',
    outcome: 'login_required',
    code: 'LOGIN_REQUIRED'
  });
  return { browser, login, backend, gate };
}

/** Every navigation any page of this scope saw, the lease page and the headless pages alike. */
function navigations(scope: { leasePage?: FakePage; browser: FakeChromiumBrowser }): string[] {
  return [
    ...(scope.leasePage?.navigations ?? []),
    ...scope.browser.headlessContext.pagesCreated.flatMap((page) => page.navigations)
  ];
}

/** Every value a credential submit would have typed, and whether the form was submitted. */
function credentialActivity(browser: FakeChromiumBrowser): { typed: string[]; submitted: boolean } {
  const pages = browser.headlessContext.pagesCreated;
  return {
    typed: pages.flatMap((page) => page.typedValues),
    submitted: pages.some((page) => page.enterPressed)
  };
}

/**
 * Flattens an observed value into text for the leak check. Errors are read through their name and
 * message, because `JSON.stringify` drops both and would make the check vacuous.
 */
function serializeForLeakCheck(value: unknown): string {
  if (value === undefined || value === null) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(serializeForLeakCheck).join('|');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${serializeForLeakCheck(item)}`)
      .join('&');
  }
  return String(value);
}

function expectNoCredentials(value: unknown): void {
  const serialized = serializeForLeakCheck(value);
  expect(serialized).not.toContain(USERNAME_SENTINEL);
  expect(serialized).not.toContain(PASSWORD_SENTINEL);
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

/**
 * Waits until the credential attempt's login navigation is held, and fails fast when the request
 * ends before it gets there: a request that never reached the login form was not an attempt in
 * flight, so the takeover it is meant to observe never happened.
 */
async function awaitHeldNavigation(gate: LoginNavigationGate, request: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    gate.waitForHeld().then(() => 'held' as const),
    failureOf(request).then(() => 'ended' as const)
  ]);
  if (outcome !== 'held') {
    throw new Error('the request ended before the credential attempt reached the login form');
  }
}

describe('manual re-auth lease blocks credential submission', () => {
  it('refuses a credential attempt that starts while the lease owns the profile', async () => {
    const scope = setupMarketplace();
    const lease = await startLease(scope.browser);
    expect(lease.reauth.status().phase).toBe('active');
    expect(scope.browser.getInfo().interactive).toBe(true);

    // This attempt starts while the lease owns the profile.
    const failure = await failureOf(scope.login.attempt(signal()));

    expect(failure).toBeInstanceOf(BrowserUnavailableError);
    expect((failure as BrowserUnavailableError).reason).toBe(LEASE_REFUSAL_REASON);
    // The refusal lands before any browser work: no headless context was launched, so no page
    // and therefore no login form ever existed.
    expect(scope.browser.headlessLaunches).toBe(0);
    expect(scope.browser.headlessContext.pagesCreated).toHaveLength(0);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(false);
    expectNoCredentials(failure);
    expectNoCredentials(lease.reauth.status());
  });

  it('keeps refusing credential attempts that start during the whole lease', async () => {
    const scope = setupMarketplace();
    const lease = await startLease(scope.browser);

    const first = await failureOf(scope.login.attempt(signal()));
    // A second request in the same lease must be refused the same way: the refusal is not a
    // one-off moment of the lease's first second.
    const firstRequest = await failureOf(scope.backend.search(search, signal()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondRequest = await failureOf(scope.backend.search(search, signal()));

    expect(first).toBeInstanceOf(BrowserUnavailableError);
    expect((first as BrowserUnavailableError).reason).toBe(LEASE_REFUSAL_REASON);
    for (const failure of [firstRequest, secondRequest]) {
      expect(failure).toMatchObject({
        name: 'ProviderError',
        code: 'UPSTREAM_ERROR',
        message: 'The browser session is not available.'
      });
    }
    // The lease is still the owner while it refuses: the refusal is not a one-off moment.
    expect(lease.reauth.status().phase).toBe('active');
    expect(scope.browser.getInfo().interactive).toBe(true);
    expect(scope.browser.headlessLaunches).toBe(0);
    expect(scope.browser.headlessContext.pagesCreated).toHaveLength(0);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(false);
    // Two refused requests, and neither of them spent the retry budget.
    expect(scope.gate.snapshot()).toEqual({ status: 'closed' });
    expectNoCredentials([first, firstRequest, secondRequest]);
  });

  it('fails a Marketplace request that starts during the lease without submitting credentials', async () => {
    const scope = setupMarketplace();
    const lease = await startLease(scope.browser);

    const failure = await failureOf(scope.backend.search(search, signal()));

    expect(failure).toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR',
      message: 'The browser session is not available.'
    });
    expect(scope.browser.headlessLaunches).toBe(0);
    expect(scope.browser.headlessContext.pagesCreated).toHaveLength(0);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(false);
    expectNoCredentials(failure);
  });

  it('does not spend the retry budget on an attempt that starts during a human lease', async () => {
    const scope = setupMarketplace();
    await startLease(scope.browser);

    await expect(scope.backend.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR'
    });

    // The attempt was abandoned, not failed: no cooldown, no failure count, so the lease costs
    // the account no retry budget.
    expect(scope.gate.snapshot()).toEqual({ status: 'closed' });
    expectNoCredentials(scope.gate.snapshot());
  });

  it('releases the browser ownership when the lease ends', async () => {
    const scope = setupMarketplace();
    const lease = await startLease(scope.browser);
    expect(scope.browser.getInfo().interactive).toBe(true);

    await lease.reauth.stop();

    // The manager reports the interactive flag only while the ownership is held, so an absent
    // flag is the released state.
    expect(scope.browser.getInfo().interactive ?? false).toBe(false);
    expect(lease.reauth.status().phase).toBe('idle');
  });

  it('refuses a Messenger request that starts during a Messenger lease', async () => {
    const scope = setupMessenger();
    const lease = await startLease(scope.browser);

    const failure = await failureOf(scope.backend.listThreads(threads, signal()));

    expect(failure).toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR',
      message: 'The browser session is not available.'
    });
    // The Messenger scope drives its own profile, so its own lease is what blocks it.
    expect(scope.browser.getInfo().interactive).toBe(true);
    expect(scope.browser.headlessLaunches).toBe(0);
    expect(scope.browser.headlessContext.pagesCreated).toHaveLength(0);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(false);
    expectNoCredentials(failure);
  });

  it('preempts a Marketplace credential attempt that was in flight when the lease started', async () => {
    const scope = setupMarketplace();
    const held = new LoginNavigationGate();
    scope.browser.headlessContext.loginNavigationGate = held;

    // The request goes in flight and its credential attempt reaches the login form.
    const request = scope.backend.search(search, signal());
    await awaitHeldNavigation(held, request);

    // The lease takes the profile over while that attempt is still on the login form. The lease
    // reaches its active phase without waiting for the attempt it preempted.
    const lease = await startLease(scope.browser);
    expect(lease.reauth.status().phase).toBe('active');
    held.releaseHeld();

    const failure = await failureOf(request);

    // The contract is the one an attempt that starts during a lease already gets.
    expect(failure).toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR',
      message: 'The browser session is not available.'
    });
    // The attempt really was on the login form, and it submitted nothing: no credential value was
    // ever typed and the form was never submitted.
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(true);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expectNoCredentials(failure);
    // The attempt was abandoned, so the human lease costs the account no retry budget, and the
    // takeover did not hard-open the gate.
    expect(scope.gate.snapshot()).toEqual({ status: 'closed' });
  });

  it('preempts a Messenger credential attempt that was in flight when the lease started', async () => {
    const scope = setupMessenger();
    const held = new LoginNavigationGate();
    scope.browser.headlessContext.loginNavigationGate = held;

    const request = scope.backend.listThreads(threads, signal());
    await awaitHeldNavigation(held, request);

    const lease = await startLease(scope.browser);
    expect(lease.reauth.status().phase).toBe('active');
    held.releaseHeld();

    const failure = await failureOf(request);

    expect(failure).toMatchObject({
      name: 'ProviderError',
      code: 'UPSTREAM_ERROR',
      message: 'The browser session is not available.'
    });
    expect(navigations({ leasePage: lease.leasePage, browser: scope.browser }).some((url) => url.includes(FACEBOOK_LOGIN_PATH))).toBe(true);
    expect(credentialActivity(scope.browser)).toEqual({ typed: [], submitted: false });
    expectNoCredentials(failure);
    // The takeover is not a challenge: the attempt is abandoned, so the account spends no retry
    // budget on it and the gate stays closed.
    expect(scope.gate.snapshot()).toEqual({ status: 'closed' });
  });
});
