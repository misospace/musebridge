import { errors } from 'playwright';
import { marketplaceSearchDiagnostic } from './facebook-marketplace-diagnostics.js';
import { BrowserSessionManager, BrowserUnavailableError, sleepUntilAbort } from './browser.js';
import {
  fetchInputSchema,
  searchInputSchema,
  type Listing,
  type ProviderErrorCode
} from './domain.js';
import { ProviderError, type MarketplaceBackend } from './backend.js';
import {
  extractMarketplaceItem,
  extractMarketplacePage,
  MARKETPLACE_EXTRACT_LIMITS,
  MARKETPLACE_ITEM_EXTRACT_LIMITS,
  type ExtractedMarketplaceItem,
  type ExtractedMarketplacePage
} from './facebook-marketplace-extract.js';
import {
  classifyMarketplaceItem,
  classifyMarketplacePage,
  interpretMarketplaceItem,
  interpretMarketplacePage
} from './facebook-marketplace-parse.js';
import {
  DEFAULT_FACEBOOK_MARKETS,
  MARKETPLACE_ITEM_PATH,
  buildMarketplaceSearchUrl,
  resolveFacebookMarket,
  validateFacebookMarkets,
  resolveMarketplaceItemInput,
  type FacebookMarket
} from './facebook-marketplace-url.js';
import { assertFacebookOrigin, FacebookSessionProbe, isFacebookAuthClassCode, type FacebookProbeCode } from './facebook.js';
import { FacebookCredentialLogin } from './facebook-login.js';
import { FacebookLoginCircuitBreaker, type FacebookLoginAttemptPermit, type FacebookLoginScope } from './facebook-login-circuit-breaker.js';
import { validateTimeout, waitForRequestBudget } from './timeout.js';

/**
 * The scope this backend owns in the shared account-level login gate. The Marketplace profile is
 * its own browser session, so a usable session verified here only clears Marketplace's own
 * penalty; the Messenger scope keeps its own.
 */
const LOGIN_SCOPE: FacebookLoginScope = 'marketplace';

export interface FacebookMarketplaceBackendOptions {
  browser: BrowserSessionManager;
  probe: FacebookSessionProbe;
  /**
   * Optional credential login. When present and the probe reports a plain login requirement,
   * credentials are submitted and the session is re-probed before the search fails.
   */
  login?: FacebookCredentialLogin;
  loginGate?: FacebookLoginCircuitBreaker;
  markets?: readonly FacebookMarket[];
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxCards?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookMarketplaceBackend implements MarketplaceBackend {
  readonly name = 'facebook';
  private readonly browser: BrowserSessionManager;
  private readonly probe: FacebookSessionProbe;
  private readonly login: FacebookCredentialLogin | undefined;
  readonly loginGate: FacebookLoginCircuitBreaker;
  private readonly markets: readonly FacebookMarket[];
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly maxCards: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly loginController = new AbortController();
  private credentialRecovery: Promise<{ recovered: boolean; code?: FacebookProbeCode }> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: FacebookMarketplaceBackendOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    if (!(options.browser instanceof BrowserSessionManager)) {
      throw new TypeError('options.browser must be a BrowserSessionManager');
    }
    if (!(options.probe instanceof FacebookSessionProbe)) {
      throw new TypeError('options.probe must be a FacebookSessionProbe');
    }
    if (options.login !== undefined && !(options.login instanceof FacebookCredentialLogin)) {
      throw new TypeError('options.login must be a FacebookCredentialLogin');
    }
    if (options.loginGate !== undefined && !(options.loginGate instanceof FacebookLoginCircuitBreaker)) {
      throw new TypeError('options.loginGate must be a FacebookLoginCircuitBreaker');
    }

    this.browser = options.browser;
    this.probe = options.probe;
    this.login = options.login;
    this.loginGate = options.loginGate ?? new FacebookLoginCircuitBreaker();
    this.markets = options.markets ?? DEFAULT_FACEBOOK_MARKETS;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 8_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.maxCards = options.maxCards ?? MARKETPLACE_EXTRACT_LIMITS.maxCards;
    this.logger = options.logger ?? console;

    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
    if (!Number.isSafeInteger(this.maxCards) || this.maxCards < 1 || this.maxCards > MARKETPLACE_EXTRACT_LIMITS.maxCards) {
      throw new RangeError(`maxCards must be an integer from 1 to ${MARKETPLACE_EXTRACT_LIMITS.maxCards}`);
    }
    if (!Array.isArray(this.markets)) throw new TypeError('markets must be an array');
    // Validate during construction, with the same rules a configured markets file is held to, so
    // a bad map fails at startup instead of resolving ambiguously on every search.
    validateFacebookMarkets(this.markets);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.loginController.abort(new Error('Facebook backend is shutting down'));
    this.closePromise = (async () => {
      await this.credentialRecovery?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  async search(input: ReturnType<typeof searchInputSchema.parse>, signal: AbortSignal): Promise<Listing[]> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    const resolution = resolveFacebookMarket(input.location, this.markets);
    if (!resolution.ok) {
      throw new ProviderError('UPSTREAM_ERROR', 'The location is not a configured Facebook Marketplace market.');
    }
    const market = resolution.market;

    await this.ensureUsableSession(signal);

    const searchUrl = assertFacebookOrigin(buildMarketplaceSearchUrl({
      baseUrl: this.probe.baseUrl,
      market,
      query: input.query,
      ...(input.min_price !== undefined ? { minPrice: input.min_price } : {}),
      ...(input.max_price !== undefined ? { maxPrice: input.max_price } : {})
    }));

    let extracted: ExtractedMarketplacePage;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        const startedAt = Date.now();
        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });

        const navigationMs = Date.now() - startedAt;
        const extractOptions = {
          itemPath: MARKETPLACE_ITEM_PATH,
          limits: { ...MARKETPLACE_EXTRACT_LIMITS, maxCards: this.maxCards }
        };
        let result = await page.evaluate(extractMarketplacePage, extractOptions);
        const first = result;
        let samples = 1;
        const settleStartedAt = Date.now();
        const deadline = settleStartedAt + this.settleTimeoutMs;
        while (classifyMarketplacePage(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) {
            // Playwright 1.63 page.evaluate accepts no abort signal. An in-flight evaluation cannot be cancelled, but in-page work is bounded by construction and the outer deadline still rejects the caller.
            result = await page.evaluate(extractMarketplacePage, extractOptions);
            samples += 1;
          }
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        this.logger.error('Facebook Marketplace search diagnostics:', marketplaceSearchDiagnostic({
          requestedUrl: searchUrl,
          first,
          final: result,
          navigationMs,
          settleMs: Date.now() - settleStartedAt,
          settleTimeoutMs: this.settleTimeoutMs,
          samples
        }));
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new ProviderError('TIMEOUT', 'The Facebook Marketplace search page did not load in time.');
      }
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Marketplace search failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace search could not be completed.');
    }

    const outcome = interpretMarketplacePage({
      page: extracted,
      baseUrl: this.probe.baseUrl,
      market,
      limit: input.limit,
      ...(input.min_price !== undefined ? { minPrice: input.min_price } : {}),
      ...(input.max_price !== undefined ? { maxPrice: input.max_price } : {})
    });
    if (outcome.kind === 'error') {
      this.recordObservedAuthFailure(outcome.code);
      throw new ProviderError(outcome.code, outcome.message);
    }
    if (outcome.kind === 'empty') return [];
    return [...outcome.listings];
  }

  /**
   * A result page that itself shows a login, captcha, or checkpoint means the session this
   * profile holds has expired or been challenged, even when the last probe assessed it usable.
   * Downgrade the cached assessment so `marketplace_status` stops reporting the stale verdict
   * until a probe or re-auth records a fresh one (#147).
   */
  private recordObservedAuthFailure(code: ProviderErrorCode): void {
    if (isFacebookAuthClassCode(code)) this.browser.assessSession('session_needs_reauth');
  }

  private async ensureUsableSession(signal: AbortSignal): Promise<void> {
    let session: Awaited<ReturnType<FacebookSessionProbe['probeSession']>>;
    try {
      session = await this.probe.probeSession(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }

    if (session.status === 'session_usable') this.loginGate.recordSuccess(LOGIN_SCOPE);

    if (session.status === 'session_needs_reauth') {
      // A captcha or checkpoint the probe observed is a challenge only a human can clear, so it
      // hard-opens the shared gate for every scope: the scope that first observes the challenge
      // owns that open, so no request may submit credentials while the challenge stands
      // (issue #144).
      if (session.code !== 'LOGIN_REQUIRED') {
        this.loginGate.recordChallenge(LOGIN_SCOPE);
      }
      // Credentials are submitted only for a plain login requirement. A captcha or checkpoint
      // already means a human is needed, and re-submitting credentials there is exactly the loop
      // the manual re-auth flow exists to avoid.
      const recovery = await this.waitForCredentialLogin(session.code, signal);
      if (!recovery.recovered) {
        const code = recovery.code ?? session.code ?? 'SESSION_INVALID';
        const messages = {
          LOGIN_REQUIRED: 'Facebook Marketplace requires login.',
          CAPTCHA_REQUIRED: 'Facebook Marketplace requires a captcha challenge.',
          SESSION_INVALID: 'The Facebook session requires a security check.'
        } as const;
        throw new ProviderError(code, messages[code]);
      }
      session = await this.confirmCredentialLogin(signal);
      if (session.status !== 'session_usable') {
        // A captcha or checkpoint the confirming probe observed is a challenge only a human can
        // clear, so it hard-opens the shared gate for every scope: a challenge is a fact about
        // the profile, whoever noticed it, and the scope that first observes it owns that open
        // (issue #144).
        if (session.status === 'session_needs_reauth' && session.code !== 'LOGIN_REQUIRED') {
          this.loginGate.recordChallenge(LOGIN_SCOPE);
        } else if (recovery.ownsAttempt) {
          this.loginGate.recordCycleFailure(LOGIN_SCOPE);
        }
        const code = session.code ?? 'SESSION_INVALID';
        const messages = {
          LOGIN_REQUIRED: 'Facebook Marketplace requires login.',
          CAPTCHA_REQUIRED: 'Facebook Marketplace requires a captcha challenge.',
          SESSION_INVALID: 'The Facebook session requires a security check.'
        } as const;
        throw new ProviderError(code, messages[code]);
      }
    }
    if (session.status === 'session_unknown') {
      // The frozen error contract has no "unverified" code; SESSION_INVALID points an operator at the re-auth console, and the message states plainly that verification failed.
      throw new ProviderError('SESSION_INVALID', 'The Facebook session could not be verified, so the request was not attempted.');
    }
  }

  /**
   * Submits optional credentials when the probe reported a plain login requirement, then confirms
   * the outcome with the probe rather than trusting the login attempt's own classification.
   *
   * Returns the code to surface when recovery did not happen, so a challenge encountered during
   * the attempt is reported as itself rather than as the original login requirement.
   */
  private async waitForCredentialLogin(
    code: FacebookProbeCode | undefined,
    signal: AbortSignal
  ): Promise<{ recovered: boolean; code?: FacebookProbeCode; ownsAttempt?: boolean }> {
    if (!this.login || code !== 'LOGIN_REQUIRED') return { recovered: false };
    if (this.closePromise || this.loginController.signal.aborted) {
      throw this.loginController.signal.reason ?? new Error('Facebook backend is shutting down');
    }

    let ownsAttempt = false;
    let recovery = this.credentialRecovery;
    if (!recovery) {
      const permit = this.loginGate.beginAttempt(LOGIN_SCOPE);
      if (!permit) return { recovered: false };
      ownsAttempt = true;
      recovery = this.startCredentialLogin(permit);
    }
    let outcome: { recovered: boolean; code?: FacebookProbeCode } | undefined;
    try {
      outcome = await waitForRequestBudget(recovery, signal);
    } catch (error) {
      if (signal.aborted) return { recovered: false, code: 'LOGIN_REQUIRED' };
      throw error;
    }
    if (outcome === undefined) return { recovered: false, code: 'LOGIN_REQUIRED' };
    return ownsAttempt ? { ...outcome, ownsAttempt: true } : outcome;
  }

  private async confirmCredentialLogin(signal: AbortSignal): Promise<Awaited<ReturnType<FacebookSessionProbe['probeSession']>>> {
    try {
      const session = await this.probe.probeSession(signal);
      if (session.status === 'session_usable') this.loginGate.recordSuccess(LOGIN_SCOPE);
      return session;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }
  }

  private startCredentialLogin(permit: FacebookLoginAttemptPermit): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    const attempt = Promise.resolve().then(() => this.performCredentialLogin(permit));
    this.credentialRecovery = attempt;
    void attempt.finally(() => {
      if (this.credentialRecovery === attempt) this.credentialRecovery = undefined;
    }).catch(() => undefined);
    return attempt;
  }

  private async performCredentialLogin(permit: FacebookLoginAttemptPermit): Promise<{ recovered: boolean; code?: FacebookProbeCode }> {
    // The gate arms the revocation of this attempt together with the grant, so a challenge
    // recorded while the attempt is in flight aborts it before it can submit any further
    // credentials. The challenge is a fact about the account, so the other scope's probe can
    // revoke this scope's attempt too. A manual re-auth lease takes the browser profile over,
    // so it ends the attempt the same way: the lease owns the profile from that moment, and the
    // attempt must not submit a credential into it.
    const attemptSignal = AbortSignal.any([this.loginController.signal, permit.signal, this.browser.profileTakeoverSignal]);
    // A challenge recorded between the grant and this point already revoked the permit, so the
    // attempt must not start at all: no credential is submitted.
    if (permit.signal.aborted) {
      this.loginGate.settleAttempt(permit, 'abandoned');
      throw new ProviderError('LOGIN_REQUIRED', 'Facebook Marketplace requires login.');
    }
    // A lease that took the profile over between the grant and this point ended the attempt's
    // access to it, so the attempt must not start at all: no credential is submitted. A takeover
    // is not a challenge, so the attempt is abandoned and the scope spends no retry budget on it.
    if (this.browser.profileTakeoverSignal.aborted) {
      this.loginGate.settleAttempt(permit, 'abandoned');
      throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
    }
    try {
      const outcome = await this.login!.attempt(attemptSignal);
      // A challenge recorded while this attempt was running revoked it, so a revoked attempt that
      // failed is abandoned rather than counted as a failure: the scope spends no retry budget on
      // an attempt the challenge cut short. A challenge the attempt itself hit still counts as a
      // failed cycle for its scope, and a self-reported success still leaves an unverified claim.
      this.loginGate.settleAttempt(permit, outcome.outcome === 'challenge'
        ? 'challenge'
        : outcome.outcome === 'authenticated' ? 'accepted'
          : permit.signal.aborted ? 'abandoned' : 'failure');
      if (outcome.outcome !== 'authenticated') {
        return { recovered: false, ...(outcome.code !== undefined ? { code: outcome.code } : {}) };
      }
      return { recovered: true };
    } catch (error) {
      if (this.loginController.signal.aborted) {
        this.loginGate.settleAttempt(permit, 'abandoned');
        throw this.loginController.signal.reason ?? error;
      }
      if (permit.signal.aborted) {
        // The attempt was revoked by a challenge, not by a login failure: it is abandoned, so the
        // scope spends no retry budget on it, and the request reports the plain login requirement.
        this.loginGate.settleAttempt(permit, 'abandoned');
        throw new ProviderError('LOGIN_REQUIRED', 'Facebook Marketplace requires login.');
      }
      if (error instanceof BrowserUnavailableError) {
        this.loginGate.settleAttempt(permit, 'abandoned');
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.loginGate.settleAttempt(permit, 'failure');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook session could not be established.');
    }
  }

  async fetch(input: ReturnType<typeof fetchInputSchema.parse>, signal: AbortSignal): Promise<Listing | null> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');

    const resolved = resolveMarketplaceItemInput(input, this.probe.baseUrl);
    if (!resolved) return null;

    await this.ensureUsableSession(signal);

    let extracted: ExtractedMarketplaceItem;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(resolved.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });

        const extractOptions = {
          limits: MARKETPLACE_ITEM_EXTRACT_LIMITS
        };
        let result = await page.evaluate(extractMarketplaceItem, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMarketplaceItem(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) {
            // Playwright page.evaluate cannot be cancelled directly; the extracted page work is bounded.
            result = await page.evaluate(extractMarketplaceItem, extractOptions);
          }
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new ProviderError('TIMEOUT', 'The Facebook Marketplace listing page did not load in time.');
      }
      if (error instanceof ProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Marketplace fetch failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new ProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace listing could not be fetched.');
    }

    const locationMarket = extracted.locationText?.trim()
      ? resolveFacebookMarket(extracted.locationText, this.markets)
      : null;
    const outcome = interpretMarketplaceItem({
      page: extracted,
      id: resolved.id,
      url: resolved.url,
      ...(locationMarket?.ok ? { fallbackCurrency: locationMarket.market.currency } : {})
    });
    if (outcome.kind === 'error') {
      this.recordObservedAuthFailure(outcome.code);
      throw new ProviderError(outcome.code, outcome.message);
    }
    if (outcome.kind === 'unavailable') return null;
    return outcome.listing;
  }
}
