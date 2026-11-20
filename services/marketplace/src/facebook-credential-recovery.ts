import { mapBrowserOperationError } from './browser-error-mapping.js';
import { BrowserSessionManager, BrowserUnavailableError } from './browser.js';
import { ProviderError, SurfaceDisabledError } from './backend.js';
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
  /** The CAPTCHA_REQUIRED failure the owning scope reports. */
  readonly captcha: string;
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
   * Probes the session and runs the shared usable-session gate both Facebook scopes are held to
   * before every surface read: a usable probe records the scope's verified success; a captcha or
   * checkpoint hard-opens the shared gate (a challenge is a fact about the account); a plain
   * login requirement may submit credentials once through the single-attempt ladder and must
   * confirm the outcome with a probe rather than the login's own classification; anything the
   * probe cannot verify fails closed as SESSION_INVALID. Throws a typed ProviderError unless the
   * session ends usable.
   *
   * `probeOnlyDisabledMessage` runs the same gate in diagnostics-only mode: it arms the gate
   * exactly like a normal probe — the probe-only run observes the same states — then reports the
   * scope's disabled surface instead of attempting credential recovery. The wording is
   * scope-owned.
   */
  async ensureUsableSession(signal: AbortSignal, probeOnlyDisabledMessage?: string): Promise<void> {
    let session: FacebookSessionProbeResult;
    try {
      session = await this.probe.probeSession(signal);
    } catch (error) {
      mapBrowserOperationError(error, signal, { fallbackMessage: 'The Facebook session could not be verified.' });
    }

    if (session.status === 'session_usable') this.loginGate.recordSuccess(this.scope);

    // A captcha or checkpoint the probe observed is a challenge only a human can clear, so it
    // hard-opens the shared gate for every scope: the scope that first observes the challenge
    // owns that open, so no request may submit credentials while the challenge stands (issue
    // #144). The probe-only diagnostics run observes the same states, so it arms the gate before
    // it reports the disabled surface.
    if (session.status === 'session_needs_reauth' && session.code !== 'LOGIN_REQUIRED') {
      this.loginGate.recordChallenge(this.scope);
    }

    if (probeOnlyDisabledMessage !== undefined) {
      if (session.code) throw new ProviderError(session.code, this.sessionMessage(session.code));
      throw new SurfaceDisabledError(probeOnlyDisabledMessage);
    }

    if (session.status === 'session_needs_reauth') {
      // Credentials are submitted only for a plain login requirement. A captcha or checkpoint
      // already means a human is needed, and re-submitting credentials there is exactly the loop
      // the manual re-auth flow exists to avoid.
      const recovery = await this.waitForCredentialLogin(session.code, signal);
      if (!recovery.recovered) {
        const code = recovery.code ?? session.code ?? 'SESSION_INVALID';
        throw new ProviderError(code, this.sessionMessage(code));
      }
      session = await this.confirmCredentialLogin(signal);
      if (session.status !== 'session_usable') {
        // A captcha or checkpoint the confirming probe observed is a challenge only a human can
        // clear, so it hard-opens the shared gate for every scope: a challenge is a fact about
        // the profile, whoever noticed it, and the scope that first observes it owns that open
        // (issue #144).
        if (session.status === 'session_needs_reauth' && session.code !== 'LOGIN_REQUIRED') {
          this.loginGate.recordChallenge(this.scope);
        } else if (recovery.ownsAttempt) {
          this.loginGate.recordCycleFailure(this.scope);
        }
        const code = session.code ?? 'SESSION_INVALID';
        throw new ProviderError(code, this.sessionMessage(code));
      }
    }
    if (session.status === 'session_unknown') {
      // The frozen error contract has no "unverified" code; SESSION_INVALID points an operator at
      // the re-auth console, and the message states plainly that verification failed.
      throw new ProviderError('SESSION_INVALID', 'The Facebook session could not be verified, so the request was not attempted.');
    }
  }

  /** The scope-owned wording for an auth-class failure code. */
  private sessionMessage(code: FacebookProbeCode): string {
    return code === 'LOGIN_REQUIRED'
      ? this.messages.loginRequired
      : code === 'CAPTCHA_REQUIRED' ? this.messages.captcha : 'The Facebook session requires a security check.';
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
  private async waitForCredentialLogin(
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

  private async confirmCredentialLogin(signal: AbortSignal): Promise<FacebookSessionProbeResult> {
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
