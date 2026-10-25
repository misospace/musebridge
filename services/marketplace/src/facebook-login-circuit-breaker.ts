import { validateTimeout } from './timeout.js';

export const FACEBOOK_LOGIN_GATE_DEFAULTS = {
  baseCooldownMs: 30_000,
  maxCooldownMs: 600_000,
  maxFailures: 3
} as const;

export interface FacebookLoginCircuitBreakerOptions {
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  maxFailures?: number;
}

/**
 * The Facebook surfaces that share one account-level credential-login gate. Each scope drives its
 * own browser profile, so a session verified in one scope says nothing about the other scope's
 * session: every penalty the gate records is owned by the scope that incurred it.
 */
export type FacebookLoginScope = 'marketplace' | 'messenger';

export interface FacebookLoginAttemptPermit {
  readonly id: symbol;
  /** The scope that asked for the attempt; the outcome is attributed to it when it settles. */
  readonly scope: FacebookLoginScope;
}

export type FacebookLoginGateSnapshot =
  | { status: 'closed' }
  | { status: 'cooldown'; failures: number; blockedForMs: number }
  | { status: 'open'; reason: 'failures' | 'challenge' };

/** One scope's own penalty state: its failure count, its cooldown deadline, its pending claim. */
interface FacebookLoginScopeState {
  failures: number;
  blockUntil: number;
  unconfirmedClaim: boolean;
}

const LOGIN_SCOPES: readonly FacebookLoginScope[] = ['marketplace', 'messenger'];

export class FacebookLoginCircuitBreaker {
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxFailures: number;
  /**
   * Per-scope penalty state. The failure threshold is per scope, so each scope escalates on its
   * own counter and its own exponential cooldown; the cooldown itself still holds credential
   * attempts in the other scope back, because the two profiles share one Facebook account.
   */
  private readonly scopes: Record<FacebookLoginScope, FacebookLoginScopeState> = {
    marketplace: { failures: 0, blockUntil: 0, unconfirmedClaim: false },
    messenger: { failures: 0, blockUntil: 0, unconfirmedClaim: false }
  };
  /**
   * The account-level hard open. It blocks every scope, and `openScope` is the only scope whose
   * verified usable session may close it: a challenge or a failure threshold is a fact about that
   * scope's profile, and another profile's session cannot vouch for it.
   */
  private openReason: 'failures' | 'challenge' | undefined;
  private openScope: FacebookLoginScope | undefined;
  private activePermit: FacebookLoginAttemptPermit | undefined;
  private readonly settled = new WeakSet<object>();
  /**
   * The listeners told about a recorded challenge. A challenge is a fact about the account, so a
   * credential attempt that is already in flight has to learn about it: the backends subscribe
   * here and abort the attempt they own before it can submit any further credentials.
   */
  private readonly challengeListeners = new Set<(scope: FacebookLoginScope) => void>();

  constructor(options: FacebookLoginCircuitBreakerOptions = {}) {
    this.baseCooldownMs = options.baseCooldownMs ?? FACEBOOK_LOGIN_GATE_DEFAULTS.baseCooldownMs;
    this.maxCooldownMs = options.maxCooldownMs ?? FACEBOOK_LOGIN_GATE_DEFAULTS.maxCooldownMs;
    this.maxFailures = options.maxFailures ?? FACEBOOK_LOGIN_GATE_DEFAULTS.maxFailures;
    validateTimeout(this.baseCooldownMs, 'baseCooldownMs');
    validateTimeout(this.maxCooldownMs, 'maxCooldownMs');
    if (this.baseCooldownMs > this.maxCooldownMs) throw new RangeError('baseCooldownMs must not exceed maxCooldownMs');
    if (!Number.isSafeInteger(this.maxFailures) || this.maxFailures < 1) {
      throw new RangeError('maxFailures must be a safe integer of at least 1');
    }
  }

  beginAttempt(scope: FacebookLoginScope, now = Date.now()): FacebookLoginAttemptPermit | undefined {
    assertLoginScope(scope);
    now = Math.floor(now);
    // One credential attempt at a time, across both scopes: the two profiles share one account.
    if (this.activePermit !== undefined) return undefined;
    // A hard open blocks every scope until the scope that caused it verifies a usable session.
    if (this.openReason !== undefined) return undefined;
    // A cooldown in any scope holds credential attempts back account-wide.
    if (this.cooldownScope(now) !== undefined) return undefined;
    // The unverified self-claim is graded against the scope that made it, not against the scope
    // that happens to ask for the next attempt.
    const claiming = this.claimingScope();
    if (claiming !== undefined) {
      // The previous attempt in that scope self-claimed `authenticated` and no probe has verified
      // it: grade that cycle as failed before any attempt may be considered, then refuse
      // immediately either way (the fresh cooldown cannot have expired within the same call). A
      // repeated unverified acceptance therefore still decelerates and eventually opens the gate
      // instead of looping.
      this.scopes[claiming].unconfirmedClaim = false;
      this.applyFailure(claiming, now);
      return undefined;
    }
    const permit: FacebookLoginAttemptPermit = Object.freeze({
      id: Symbol('facebook-login-attempt'),
      scope
    });
    this.activePermit = permit;
    return permit;
  }

  settleAttempt(
    permit: FacebookLoginAttemptPermit,
    outcome: 'failure' | 'challenge' | 'accepted' | 'abandoned',
    now = Date.now()
  ): void {
    if (!permit || typeof permit !== 'object') throw new TypeError('permit must be an attempt permit');
    if (this.settled.has(permit)) return;
    if (this.activePermit !== permit) throw new TypeError('permit was not granted by this circuit breaker');
    this.settled.add(permit);
    this.activePermit = undefined;
    // The outcome belongs to the scope that asked for the attempt; another scope's claim, counter,
    // cooldown, and hard-open ownership are never touched here.
    const scope = permit.scope;
    assertLoginScope(scope);
    const state = this.scopes[scope];
    if (outcome === 'failure') {
      state.unconfirmedClaim = false;
      this.applyFailure(scope, now);
    } else if (outcome === 'challenge') {
      state.unconfirmedClaim = false;
      if (this.openReason === undefined) {
        this.openReason = 'challenge';
        this.openScope = scope;
      } else {
        // A hard open is already standing and keeps the scope that caused it: that scope is the
        // only one whose verified session may close it. The challenge still counts as a failed
        // cycle for the scope that hit it.
        this.applyFailure(scope, now);
      }
      // The gate state is already updated, so a listener sees the open the challenge caused.
      this.notifyChallenge(scope);
    } else if (outcome === 'accepted') {
      // The login self-classified as authenticated, but no probe has confirmed a usable session
      // yet, so the claim stands until a probe verifies it or the next attempt grades it.
      state.unconfirmedClaim = true;
    }
    // 'abandoned' releases the permit and nothing else.
  }

  /**
   * Arms the account-level hard open for a challenge observed outside a credential attempt, such
   * as a captcha or checkpoint seen by the session probe. It behaves like the challenge branch of
   * `settleAttempt` without a permit: the scope that first observes the challenge owns the open,
   * and a standing open keeps the scope that caused it while the observing scope records a failed
   * cycle.
   */
  recordChallenge(scope: FacebookLoginScope, now = Date.now()): void {
    assertLoginScope(scope);
    const state = this.scopes[scope];
    state.unconfirmedClaim = false;
    if (this.openReason === undefined) {
      this.openReason = 'challenge';
      this.openScope = scope;
    } else {
      // A hard open is already standing and keeps the scope that caused it: that scope is the
      // only one whose verified session may close it. The challenge still counts as a failed
      // cycle for the scope that hit it.
      this.applyFailure(scope, now);
    }
    // The gate state is already updated, so a listener sees the open the challenge caused.
    this.notifyChallenge(scope);
  }

  /**
   * Registers a listener that is told whenever a challenge is recorded, whether the session probe
   * observed it (`recordChallenge`) or a credential attempt reported it (`settleAttempt(permit,
   * 'challenge')`). The notified scope is the scope that observed the challenge, so a listener can
   * tell whose profile hit it.
   *
   * A listener must not throw: a throwing listener is swallowed, so it can neither corrupt the
   * gate nor break the caller that recorded the challenge. The gate has no logger, so there is
   * nowhere to report such a failure. The returned function unsubscribes the listener; calling it
   * more than once is harmless.
   */
  subscribeChallenge(listener: (scope: FacebookLoginScope) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    // Each registration gets its own wrapper, so registering the same function twice keeps two
    // independent subscriptions and unsubscribing one leaves the other in place.
    const wrapped = (scope: FacebookLoginScope): void => {
      listener(scope);
    };
    this.challengeListeners.add(wrapped);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.challengeListeners.delete(wrapped);
    };
  }

  recordCycleFailure(scope: FacebookLoginScope, now = Date.now()): void {
    assertLoginScope(scope);
    if (this.openReason !== undefined) return;
    this.scopes[scope].unconfirmedClaim = false;
    this.applyFailure(scope, now);
  }

  recordSuccess(scope: FacebookLoginScope, _now = Date.now()): void {
    assertLoginScope(scope);
    // A verified usable session only vouches for the scope whose profile produced it, so this
    // clears that scope's own penalty and nothing else.
    const state = this.scopes[scope];
    state.failures = 0;
    state.blockUntil = 0;
    state.unconfirmedClaim = false;
    // The hard open is account-wide, but only the scope that hit the challenge or the failure
    // threshold may close it.
    if (this.openScope === scope) {
      this.openReason = undefined;
      this.openScope = undefined;
    }
  }

  snapshot(now = Date.now()): FacebookLoginGateSnapshot {
    if (this.openReason !== undefined) return { status: 'open', reason: this.openReason };
    const binding = this.cooldownScope(now);
    if (binding === undefined) return { status: 'closed' };
    const state = this.scopes[binding];
    return { status: 'cooldown', failures: state.failures, blockedForMs: state.blockUntil - now };
  }

  /**
   * The scope holding a standing unverified accepted-claim, if any. A concluded attempt in that
   * scope self-reported `authenticated` but no backend probe has yet independently confirmed a
   * usable session. That claim is never trusted (issue #144): the next `beginAttempt` grades it as
   * a failed cycle for the scope that made it, instead of granting a fresh attempt un-penalized. A
   * verified success clears that scope's claim (the usable session was verified); every other
   * settle either leaves the claim standing by re-claiming (`accepted`) or records its own cycle
   * conclusion, which supersedes the earlier unverified claim (failure, challenge) — so exactly
   * one penalty lands per cycle, and never in another scope.
   */
  private claimingScope(): FacebookLoginScope | undefined {
    for (const scope of LOGIN_SCOPES) {
      if (this.scopes[scope].unconfirmedClaim) return scope;
    }
    return undefined;
  }

  /**
   * The scope whose cooldown is currently holding attempts back, if any. The cooldown is
   * account-wide, so the binding scope is the one with the longest remaining blocked time and the
   * reported failure count is that scope's own.
   */
  private cooldownScope(now: number): FacebookLoginScope | undefined {
    let binding: FacebookLoginScope | undefined;
    let longest = 0;
    for (const scope of LOGIN_SCOPES) {
      const state = this.scopes[scope];
      if (state.failures <= 0 || now >= state.blockUntil) continue;
      const remaining = state.blockUntil - now;
      if (remaining > longest) {
        longest = remaining;
        binding = scope;
      }
    }
    return binding;
  }

  /**
   * Tells every subscriber that a challenge was recorded. The gate state is already updated when
   * this runs. A listener that throws is swallowed: it must not corrupt the gate (the state is
   * already written) nor propagate into the caller that recorded the challenge.
   */
  private notifyChallenge(scope: FacebookLoginScope): void {
    for (const listener of [...this.challengeListeners]) {
      try {
        listener(scope);
      } catch {
        // The gate has no logger and a listener must never break the caller that recorded the
        // challenge, so the failure is swallowed here.
      }
    }
  }

  private applyFailure(scope: FacebookLoginScope, now: number): void {
    const state = this.scopes[scope];
    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      // The scope's own failure threshold hard-opens the account gate for every scope. A hard
      // open that is already standing keeps the scope that caused it: an attempt that was in
      // flight while it opened must not silently hand the open to another scope, because the
      // scope that caused it is the only one whose verified session may close it.
      if (this.openReason === undefined) {
        this.openReason = 'failures';
        this.openScope = scope;
      }
      // The threshold is not swallowed by a standing open that another scope owns: this scope
      // stays held back with the ladder's ceiling cooldown, so the open clearing later does not
      // hand the threshold scope a free attempt.
      state.blockUntil = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now) + this.maxCooldownMs);
      return;
    }
    const exponent = Math.min(state.failures - 1, 52);
    const cooldown = Math.min(this.baseCooldownMs * 2 ** exponent, this.maxCooldownMs);
    const safeNow = Math.floor(now);
    state.blockUntil = Math.min(Number.MAX_SAFE_INTEGER, safeNow + cooldown);
  }
}

function assertLoginScope(scope: FacebookLoginScope): void {
  if (!LOGIN_SCOPES.includes(scope)) throw new TypeError('scope must be a known Facebook login scope');
}
