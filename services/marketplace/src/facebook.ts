import type { Locator, Page } from 'playwright';
import { ProviderError } from './backend.js';
import { BrowserSessionManager, BrowserUnavailableError, type BrowserSessionInfo, type ProviderSessionAssessment } from './browser.js';
import type { ProviderErrorCode } from './domain.js';
import { validateTimeout } from './timeout.js';

export const FACEBOOK_ORIGIN = 'https://www.facebook.com';
export const FACEBOOK_MARKETPLACE_PATH = '/marketplace/';
export const FACEBOOK_MESSENGER_PATH = '/messages/';
export const FACEBOOK_MESSENGER_INBOX_PATH = '/marketplace/inbox/';

export const FACEBOOK_PROBE_OUTCOMES = ['marketplace_authenticated', 'messages_authenticated', 'login_required', 'login_redirect', 'checkpoint', 'captcha', 'ambiguous'] as const;
export type FacebookProbeOutcome = typeof FACEBOOK_PROBE_OUTCOMES[number];

export type FacebookProbeCode = Extract<ProviderErrorCode, 'LOGIN_REQUIRED' | 'CAPTCHA_REQUIRED' | 'SESSION_INVALID'>;

/**
 * Whether a provider error code is an auth-class failure observed from page content: a login
 * requirement, a captcha, or a checkpoint. Such an observation proves the session this profile
 * holds is no longer usable, even when the last probe assessed it usable (#147).
 */
export function isFacebookAuthClassCode(code: ProviderErrorCode): code is FacebookProbeCode {
  return code === 'LOGIN_REQUIRED' || code === 'CAPTCHA_REQUIRED' || code === 'SESSION_INVALID';
}

export interface FacebookSessionProbeResult {
  status: ProviderSessionAssessment;
  outcome: FacebookProbeOutcome;
  code?: FacebookProbeCode;
}

export interface FacebookPageSnapshot {
  url: string;
  hasPasswordInput: boolean;
  hasLoginForm: boolean;
  hasCheckpointForm: boolean;
  hasCaptchaFrame: boolean;
  hasMainLandmark: boolean;
  hasMarketplaceLink: boolean;
  hasAuthenticatedMarker: boolean;
  hasLoginPrompt: boolean;
  mentionsCheckpoint: boolean;
  mentionsCaptcha: boolean;
  captchaSignals?: FacebookCaptchaSignals;
}

/** Only structural booleans: never include text, attributes, URLs, or identifiers. */
export interface FacebookCaptchaSignals {
  iframeMatched: boolean;
  iframeVisible: boolean;
  idMatched: boolean;
  idVisible: boolean;
  testIdMatched: boolean;
  testIdVisible: boolean;
  textMatched: boolean;
  textVisible: boolean;
  captchaWordMatched: boolean;
  captchaWordVisible: boolean;
  notRobotMatched: boolean;
  notRobotVisible: boolean;
  verifyHumanMatched: boolean;
  verifyHumanVisible: boolean;
  authenticatedMarkerMatched: boolean;
  authenticatedMarkerVisible: boolean;
  mainLandmarkMatched: boolean;
  mainLandmarkVisible: boolean;
}

export interface FacebookMessengerSessionDiagnostics extends FacebookCaptchaSignals {
  captchaSignalMatched: boolean;
  visibleCaptchaSignal: boolean;
  hiddenOnlyCaptchaSignal: boolean;
  hasLoginSignal: boolean;
  loginRedirect: boolean;
  hasCheckpointSignal: boolean;
  checkpointRoute: boolean;
  expectedInboxUrl: boolean;
  sessionUsable: boolean;
  classification: FacebookProbeOutcome;
  sessionStatus: ProviderSessionAssessment;
}

export interface FacebookSessionProbeOptions {
  browser: BrowserSessionManager;
  baseUrl?: string;
  surface?: 'marketplace' | 'messenger';
  probePath?: string;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookSessionProbe {
  readonly baseUrl: string;
  readonly probeUrl: string;
  private readonly browser: BrowserSessionManager;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly surface: 'marketplace' | 'messenger';
  private readonly logger: Pick<Console, 'error'>;

  constructor(options: FacebookSessionProbeOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    if (!(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }

    this.browser = options.browser;
    this.baseUrl = normalizeFacebookBaseUrl(options.baseUrl ?? FACEBOOK_ORIGIN);
    this.surface = options.surface ?? 'marketplace';
    if (this.surface !== 'marketplace' && this.surface !== 'messenger') throw new TypeError('surface must be marketplace or messenger');
    const probePath = options.probePath ?? (this.surface === 'messenger' ? FACEBOOK_MESSENGER_INBOX_PATH : FACEBOOK_MARKETPLACE_PATH);
    if (typeof probePath !== 'string' || !probePath.startsWith('/')) throw new TypeError('probePath must start with /');
    const probeUrl = new URL(probePath, this.baseUrl);
    if (probeUrl.origin !== this.baseUrl) throw new TypeError('probePath must resolve to the same origin as baseUrl');
    this.probeUrl = probeUrl.href;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 15_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.logger = options.logger ?? console;

    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
  }

  async probeSession(signal: AbortSignal): Promise<FacebookSessionProbeResult> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));

    this.browser.assessSession('session_unknown');

    let snapshot: FacebookPageSnapshot;
    try {
      snapshot = await this.browser.runExclusive(signal, (page) => this.loadSnapshot(page, signal));
    } catch (error) {
      if (error instanceof BrowserUnavailableError || signal.aborted) throw error;
      const surfaceName = this.surface === 'messenger' ? 'Messenger' : 'Marketplace';
      this.logger.error(
        `Facebook session probe failed to load the ${surfaceName} page:`,
        error instanceof Error ? error.name : 'UnknownError'
      );
      throw new ProviderError('UPSTREAM_ERROR', `The Facebook ${surfaceName} page could not be loaded for the session probe.`);
    }

    const result = classifyFacebookSession(snapshot, this.baseUrl, this.surface);
    if (this.surface === 'messenger') {
      const diagnostics = facebookMessengerSessionDiagnostics(snapshot, result, this.probeUrl);
      if (diagnostics) this.logger.error('Facebook Messenger probe diagnostics:', diagnostics);
    }
    this.browser.assessSession(result.status);
    return result;
  }

  private async loadSnapshot(page: Page, signal: AbortSignal): Promise<FacebookPageSnapshot> {
    await page.goto(this.probeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
      signal
    });

    let snapshot = await readFacebookPage(page);
    const deadline = Date.now() + this.settleTimeoutMs;
    while (!hasDecisiveSignal(snapshot, this.baseUrl, this.surface) && Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      try {
        snapshot = await readFacebookPage(page);
      } catch {
        break;
      }
    }

    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    return snapshot;
  }
}

export function classifyFacebookSession(
  snapshot: FacebookPageSnapshot,
  baseUrl: string,
  surface: 'marketplace' | 'messenger' = 'marketplace'
): FacebookSessionProbeResult {
  if (snapshot.hasCaptchaFrame || snapshot.mentionsCaptcha) {
    // Dormant markup is not proof of a visible challenge, nor permission to log in or read.
    // Legacy snapshots without visibility observations keep the existing conservative verdict.
    if (surface === 'messenger' && snapshot.captchaSignals && !hasVisibleCaptcha(snapshot.captchaSignals)) {
      return { status: 'session_unknown', outcome: 'ambiguous' };
    }
    return { status: 'session_needs_reauth', outcome: 'captcha', code: 'CAPTCHA_REQUIRED' };
  }
  if (isCheckpointUrl(snapshot.url) || snapshot.hasCheckpointForm || snapshot.mentionsCheckpoint) {
    return { status: 'session_needs_reauth', outcome: 'checkpoint', code: 'SESSION_INVALID' };
  }
  if (isLoginUrl(snapshot.url) || snapshot.hasPasswordInput || snapshot.hasLoginForm) {
    return {
      status: 'session_needs_reauth',
      outcome: isLoginUrl(snapshot.url) ? 'login_redirect' : 'login_required',
      code: 'LOGIN_REQUIRED'
    };
  }
  if (surface === 'messenger' && isMessengerUrl(snapshot.url, baseUrl) && snapshot.hasMainLandmark && snapshot.hasAuthenticatedMarker && !snapshot.hasLoginPrompt) {
    return { status: 'session_usable', outcome: 'messages_authenticated' };
  }
  if (surface === 'marketplace' && isMarketplaceUrl(snapshot.url, baseUrl) && snapshot.hasMainLandmark && snapshot.hasMarketplaceLink && snapshot.hasAuthenticatedMarker) {
    return { status: 'session_usable', outcome: 'marketplace_authenticated' };
  }
  if (snapshot.hasLoginPrompt) {
    return { status: 'session_needs_reauth', outcome: 'login_required', code: 'LOGIN_REQUIRED' };
  }
  return { status: 'session_unknown', outcome: 'ambiguous' };
}

export function toProviderSessionAssessment(info: BrowserSessionInfo): ProviderSessionAssessment {
  return info.status === 'session_usable' || info.status === 'session_needs_reauth'
    ? info.status
    : 'session_unknown';
}

export async function readFacebookPage(page: Page): Promise<FacebookPageSnapshot> {
  const captchaSignals = await readFacebookCaptchaSignals(page);
  const [passwordCount, loginCount, checkpointCount, mainCount, marketplaceLinkCount, authMarkerCount, logoutLinkCount, loginPromptLinkCount, loginPromptButtonCount, checkpointTextCount, url] = await Promise.all([
    page.locator('input[type="password"]').count(),
    page.locator('form[action*="/login"], input[name="pass"]').count(),
    page.locator('form[action*="checkpoint"], [data-testid*="checkpoint"]').count(),
    page.locator('main, [role="main"]').count(),
    page.locator('a[href*="/marketplace"]').count(),
    page.locator('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]').count(),
    page.getByRole('link', { name: /^\s*log ?out\s*$/i }).count(),
    page.getByRole('link', { name: /^\s*log ?in( to facebook)?\s*$/i }).count(),
    page.getByRole('button', { name: /^\s*log ?in( to facebook)?\s*$/i }).count(),
    page.getByText(/security check|confirm your identity|unusual activity/i).count(),
    page.url()
  ]);

  return {
    url,
    hasPasswordInput: passwordCount > 0,
    hasLoginForm: loginCount > 0,
    hasCheckpointForm: checkpointCount > 0,
    hasCaptchaFrame: captchaSignals.iframeMatched || captchaSignals.idMatched || captchaSignals.testIdMatched,
    hasMainLandmark: mainCount > 0,
    hasMarketplaceLink: marketplaceLinkCount > 0,
    hasAuthenticatedMarker: authMarkerCount > 0 || logoutLinkCount > 0,
    hasLoginPrompt: loginPromptLinkCount > 0 || loginPromptButtonCount > 0,
    mentionsCheckpoint: checkpointTextCount > 0,
    mentionsCaptcha: captchaSignals.textMatched,
    captchaSignals
  };
}

export async function readFacebookCaptchaSignals(page: Page): Promise<FacebookCaptchaSignals> {
  const [iframe, id, testId, captchaWord, notRobot, verifyHuman, authenticated, main] = await Promise.all([
    observeSignal(page.locator('iframe[src*="captcha" i]')),
    observeSignal(page.locator('[id*="captcha" i]')),
    observeSignal(page.locator('[data-testid*="captcha" i]')),
    observeSignal(page.getByText(/captcha/i)),
    observeSignal(page.getByText(/i'?m not a robot/i)),
    observeSignal(page.getByText(/verify you are a human/i)),
    observeSignal(page.locator('a[href*="logout" i], [aria-label*="your account" i], [aria-label*="your profile" i]').or(page.getByRole('link', { name: /^\s*log ?out\s*$/i }))),
    observeSignal(page.locator('main, [role="main"]'))
  ]);
  return {
    iframeMatched: iframe.matched, iframeVisible: iframe.visible,
    idMatched: id.matched, idVisible: id.visible,
    testIdMatched: testId.matched, testIdVisible: testId.visible,
    textMatched: captchaWord.matched || notRobot.matched || verifyHuman.matched,
    textVisible: captchaWord.visible || notRobot.visible || verifyHuman.visible,
    captchaWordMatched: captchaWord.matched, captchaWordVisible: captchaWord.visible,
    notRobotMatched: notRobot.matched, notRobotVisible: notRobot.visible,
    verifyHumanMatched: verifyHuman.matched, verifyHumanVisible: verifyHuman.visible,
    authenticatedMarkerMatched: authenticated.matched, authenticatedMarkerVisible: authenticated.visible,
    mainLandmarkMatched: main.matched, mainLandmarkVisible: main.visible
  };
}

/**
 * Return only structural booleans and fixed classifier enums for Messenger session diagnostics.
 * URLs, page text, attributes, credentials, and identifiers must never enter this object.
 */
export function facebookMessengerSessionDiagnostics(
  snapshot: FacebookPageSnapshot,
  result: FacebookSessionProbeResult,
  expectedInboxUrl: string
): FacebookMessengerSessionDiagnostics | undefined {
  const signals = snapshot.captchaSignals;
  if (!signals) return undefined;
  const captchaSignalMatched = snapshot.hasCaptchaFrame || snapshot.mentionsCaptcha;
  const visibleCaptchaSignal = hasVisibleCaptcha(signals);
  return {
    ...signals,
    captchaSignalMatched,
    visibleCaptchaSignal,
    hiddenOnlyCaptchaSignal: captchaSignalMatched && !visibleCaptchaSignal,
    hasLoginSignal: snapshot.hasPasswordInput || snapshot.hasLoginForm || snapshot.hasLoginPrompt,
    loginRedirect: isLoginUrl(snapshot.url),
    hasCheckpointSignal: isCheckpointUrl(snapshot.url) || snapshot.hasCheckpointForm || snapshot.mentionsCheckpoint,
    checkpointRoute: isCheckpointUrl(snapshot.url),
    expectedInboxUrl: snapshot.url === expectedInboxUrl,
    sessionUsable: result.status === 'session_usable',
    classification: result.outcome,
    sessionStatus: result.status
  };
}

async function observeSignal(locator: Locator): Promise<{ matched: boolean; visible: boolean }> {
  const [matched, visible] = await Promise.all([
    locator.count(),
    // Playwright considers opacity:0 visible; exclude fully transparent elements/ancestors
    // too so dormant overlays are not described as a rendered challenge.
    locator.filter({ visible: true }).evaluateAll((elements) => elements.some((element) => {
      for (let current: Element | null = element; current; current = current.parentElement) {
        if (getComputedStyle(current).opacity === '0') return false;
      }
      return true;
    }))
  ]);
  return { matched: matched > 0, visible };
}

function hasVisibleCaptcha(signals: FacebookCaptchaSignals): boolean {
  return signals.iframeVisible || signals.idVisible || signals.testIdVisible || signals.textVisible;
}

function hasDecisiveSignal(snapshot: FacebookPageSnapshot, baseUrl: string, surface: 'marketplace' | 'messenger'): boolean {
  return classifyFacebookSession(snapshot, baseUrl, surface).outcome !== 'ambiguous';
}

function isLoginUrl(value: string): boolean {
  const pathname = getPathname(value);
  return pathname === '/login' || pathname?.startsWith('/login/') === true;
}

function isCheckpointUrl(value: string): boolean {
  const pathname = getPathname(value);
  return pathname === '/checkpoint' || pathname?.startsWith('/checkpoint/') === true;
}

function isMarketplaceUrl(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.origin === base.origin && (url.pathname === '/marketplace' || url.pathname.startsWith('/marketplace/'));
  } catch {
    return false;
  }
}

function isMessengerUrl(value: string, baseUrl: string): boolean {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.origin === base.origin && (
      url.pathname === '/messages' || url.pathname.startsWith('/messages/') ||
      url.pathname === '/marketplace/inbox' || url.pathname.startsWith('/marketplace/inbox/')
    );
  } catch {
    return false;
  }
}

function getPathname(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

export function assertFacebookOrigin(value: string): string {
  if (typeof value !== 'string') throw new TypeError('URL must be a valid HTTP(S) URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('URL must be a valid HTTP(S) URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password ||
      (url.origin !== FACEBOOK_ORIGIN && !isLoopbackHost(url.hostname))) {
    throw new TypeError('URL must use the Facebook origin or a loopback origin');
  }
  return value;
}

export function normalizeFacebookBaseUrl(value: string): string {
  assertFacebookOrigin(value);
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new TypeError('baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
