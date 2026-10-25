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

export interface FacebookLoginAttemptPermit {
  readonly id: symbol;
}

export type FacebookLoginGateSnapshot =
  | { status: 'closed' }
  | { status: 'cooldown'; failures: number; blockedForMs: number }
  | { status: 'open'; reason: 'failures' | 'challenge' };

export class FacebookLoginCircuitBreaker {
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly maxFailures: number;
  private failures = 0;
  private blockUntil = 0;
  private openReason: 'failures' | 'challenge' | undefined;
  private activePermit: FacebookLoginAttemptPermit | undefined;
  private readonly settled = new WeakSet<object>();
  /**
   * The last concluded attempt self-reported `authenticated` but no backend probe has yet
   * independently confirmed a usable session. That claim is never trusted (issue #144): the next
   * `beginAttempt` grades it as a failed cycle instead of granting a fresh attempt un-penalized.
   * `recordSuccess` clears it (the usable session was verified); every other settle either leaves
   * it standing by re-claiming (`accepted`) or records its own cycle conclusion, which supersedes
   * the earlier unverified claim (failure, challenge) — so exactly one penalty lands per cycle.
   */
  private unconfirmedClaim = false;

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

  beginAttempt(now = Date.now()): FacebookLoginAttemptPermit | undefined {
    now = Math.floor(now);
    if (this.activePermit !== undefined || this.openReason !== undefined) return undefined;
    if (this.failures > 0 && now < this.blockUntil) return undefined;
    if (this.unconfirmedClaim) {
      // The previous attempt self-claimed `authenticated` and no probe has verified it: grade that
      // cycle as failed before this one may even be considered, then refuse immediately either way
      // (the fresh cooldown cannot have expired within the same call). A repeated unverified
      // acceptance therefore still decelerates and eventually opens the gate instead of looping.
      this.unconfirmedClaim = false;
      this.applyFailure(now);
      return undefined;
    }
    const permit: FacebookLoginAttemptPermit = Object.freeze({ id: Symbol('facebook-login-attempt') });
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
    if (outcome === 'failure') this.applyFailure(now);
    else if (outcome === 'challenge') this.openReason = 'challenge';
    // 'accepted' leaves an unverified self-claim standing; every other outcome is either its own
    // cycle's conclusion (failure, challenge) or an already-consumed/waiting state, so the claim
    // does not carry forward.
    this.unconfirmedClaim = outcome === 'accepted';
  }

  recordCycleFailure(now = Date.now()): void {
    if (this.openReason !== undefined) return;
    this.unconfirmedClaim = false;
    this.applyFailure(now);
  }

  recordSuccess(_now = Date.now()): void {
    this.failures = 0;
    this.blockUntil = 0;
    this.openReason = undefined;
    this.unconfirmedClaim = false;
  }

  snapshot(now = Date.now()): FacebookLoginGateSnapshot {
    if (this.openReason !== undefined) return { status: 'open', reason: this.openReason };
    if (this.failures === 0 || now >= this.blockUntil) return { status: 'closed' };
    return { status: 'cooldown', failures: this.failures, blockedForMs: this.blockUntil - now };
  }

  private applyFailure(now: number): void {
    this.failures += 1;
    if (this.failures >= this.maxFailures) {
      this.openReason = 'failures';
      this.blockUntil = 0;
      return;
    }
    const exponent = Math.min(this.failures - 1, 52);
    const cooldown = Math.min(this.baseCooldownMs * 2 ** exponent, this.maxCooldownMs);
    const safeNow = Math.floor(now);
    this.blockUntil = Math.min(Number.MAX_SAFE_INTEGER, safeNow + cooldown);
  }
}
