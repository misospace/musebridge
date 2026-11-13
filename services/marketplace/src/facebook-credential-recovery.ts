import { mapBrowserOperationError } from './browser-error-mapping.js';
import { BrowserSessionManager, BrowserUnavailableError } from './browser.js';
import { ProviderError } from './backend.js';
import {
  isFacebookAuthClassCode,
  type FacebookProbeCode,
  type FacebookSessionProbe,
  type FacebookSessionProbeResult
} from './facebook.js';
import { FacebookLoginCircuitBreaker, type FacebookLoginAttemptPermit, type FacebookLoginScope } from './facebook-login-circuit-breaker.js';
import { FacebookCredentialLogin } from './facebook-login.js';
import type { ProviderErrorCode } from './domain.js';
import { waitForRequestBudget } from './timeout.js';

type RecoveryOutcome = { recovered: boolean; code?: FacebookProbeCode };

/** Error wording that differs per scope; the recovery flow itself is identical. */
export interface FacebookCredentialRecoveryMessages {
  /** Aborts the recovery channel on close and rejects attempts that start after shutdown began. */
  readonly shutdown: string;
  /** The plain LOGIN_REQUIRED failure the owning scope reports. */
  readonly loginRequired: string;
}

/**
 * The credential-recovery machinery shared by the two Facebook backends (marketplace and
 * messenger scopes): the shutdown channel, the single in-flight credential attempt keyed to the
 * shared login gate, the permit settlement ladder, and the confirm-by-probe step. The gate and
 * permit semantics are deliberately identical across the scopes — a challenge is a fact about
 * the account — so they live here once; only the scope-owned error wording differs.
 */
export class FacebookCredentialRecovery {
  private readonly browser: BrowserSessionManager;
  private readonly probe: FacebookSessionProbe;
  private readonly scope: FacebookLoginScope;
  private readonly loginGate: FacebookLoginCircuitBreaker;
  private readonly login: FacebookCredentialLogin | undefined;
  private readonly messages: FacebookCredentialRecoveryMessages;
  private readonly loginController = new AbortController();
  private recovery: Promise<RecoveryOutcome> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly browser: BrowserSessionManager;
    readonly probe: FacebookSessionProbe;
    readonly scope: FacebookLoginScope;
    readonly loginGate: FacebookLoginCircuitBreaker;
    readonly login?: FacebookCredentialLogin;
    readonly messages: FacebookCredentialRecoveryMessages;
  }) {
    this.browser = options.browser;
    this.probe = options.probe;
    this.scope = options.scope;
    this.loginGate = options.loginGate;
    this.login = options.login;
    this.messages = options.messages;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.loginController.abort(new Error(this.messages.shutdown));
    this.closePromise = (async () => {
      await this.recovery?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  /**
   * A result page that itself shows a login, captcha, or checkpoint means the session this
   * profile holds has expired or been challenged, even when the last probe assessed it usable.
   * Downgrade the cached assessment so `marketplace_status` stops reporting the stale verdict
   * until a probe or re-auth records a fresh one (#147).
   */
  recordObservedAuthFailure(code: ProviderErrorCode): void {
    if (!isFacebookAuthClassCode(code)) return;
    this.browser.assessSession('session_needs_reauth');
    // A captcha or checkpoint a page observed is a challenge only a human can clear, so it
    // hard-opens the shared gate for every scope exactly like the probe path does (issue #144):
    // the scope that first observes the challenge owns that open, so no other scope's request
    // may submit credentials while it stands. A plain login requirement stays the recoverable
    // credential path's business and never hard-opens the gate.
    if (code !== 'LOGIN_REQUIRED') this.loginGate.recordChallenge(this.scope);
  }

  /**
   * Submits optional credentials when the probe reported a plain login requirement, then confirms
   * the outcome with the probe rather than trusting the login attempt's own classification.
   *
   * Returns the code to surface when recovery did not happen, so a challenge encountered during
   * the attempt is reported as itself rather than as the original login requirement.
   */
  async waitForCredentialLogin(
    code: FacebookProbeCode | undefined,
    signal: AbortSignal
  ): Promise<RecoveryOutcome & { ownsAttempt?: boolean }> {
    if (!this.login || code !== 'LOGIN_REQUIRED') return { recovered: false };
    if (this.closePromise || this.loginController.signal.aborted) {
      throw this.loginController.signal.reason ?? new Error(this.messages.shutdown);
    }

    let ownsAttempt = false;
    let recovery = this.recovery;
    if (!recovery) {
      const permit = this.loginGate.beginAttempt(this.scope);
      if (!permit) return { recovered: false };
      ownsAttempt = true;
      recovery = this.startCredentialLogin(permit);
    }
    let outcome: RecoveryOutcome | undefined;
    try {
      outcome = await waitForRequestBudget(recovery, signal);
    } catch (error) {
      if (signal.aborted) return { recovered: false, code: 'LOGIN_REQUIRED' };
      throw error;
    }
    if (outcome === undefined) return { recovered: false, code: 'LOGIN_REQUIRED' };
    return ownsAttempt ? { ...outcome, ownsAttempt: true } : outcome;
  }

  async confirmCredentialLogin(signal: AbortSignal): Promise<FacebookSessionProbeResult> {
    try {
      const session = await this.probe.probeSession(signal);
      if (session.status === 'session_usable') this.loginGate.recordSuccess(this.scope);
      return session;
    } catch (error) {
      mapBrowserOperationError(error, signal, { fallbackMessage: 'The Facebook session could not be verified.' });
    }
  }

  private startCredentialLogin(permit: FacebookLoginAttemptPermit): Promise<RecoveryOutcome> {
    const attempt = Promise.resolve().then(() => this.performCredentialLogin(permit));
    this.recovery = attempt;
    void attempt.finally(() => {
      if (this.recovery === attempt) this.recovery = undefined;
    }).catch(() => undefined);
    return attempt;
  }

  private async performCredentialLogin(permit: FacebookLoginAttemptPermit): Promise<RecoveryOutcome> {
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
      throw new ProviderError('LOGIN_REQUIRED', this.messages.loginRequired);
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
        throw new ProviderError('LOGIN_REQUIRED', this.messages.loginRequired);
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
}
