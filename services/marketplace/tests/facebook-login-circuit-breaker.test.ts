import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_LOGIN_GATE_DEFAULTS,
  FacebookLoginCircuitBreaker
} from '../src/facebook-login-circuit-breaker.js';

describe('FacebookLoginCircuitBreaker', () => {
  it('grants one permit, records outcomes once, and rejects foreign permits', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200 });
    const permit = gate.beginAttempt(0)!;
    expect(gate.beginAttempt(0)).toBeUndefined();
    gate.settleAttempt(permit, 'failure', 0);
    gate.settleAttempt(permit, 'failure', 0);
    expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
    expect(() => new FacebookLoginCircuitBreaker().settleAttempt(permit, 'failure', 0)).toThrow(TypeError);
  });

  it('applies exponential cooldown with cap and expiry', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 10 });
    let now = 0;
    for (const cooldown of [50, 100, 200, 200]) {
      const permit = gate.beginAttempt(now)!;
      gate.settleAttempt(permit, 'failure', now);
      expect(gate.snapshot(now)).toMatchObject({ status: 'cooldown', blockedForMs: cooldown });
      expect(gate.beginAttempt(now + cooldown - 1)).toBeUndefined();
      now += cooldown;
      const granted = gate.beginAttempt(now);
      expect(granted).toBeDefined();
      gate.settleAttempt(granted!, 'abandoned', now);
    }
  });

  it('opens on threshold or challenge, and verified success closes either state', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
    for (const now of [0, 50, 150]) {
      const permit = gate.beginAttempt(now)!;
      gate.settleAttempt(permit, 'failure', now);
    }
    expect(gate.snapshot(1_000_000)).toEqual({ status: 'open', reason: 'failures' });
    expect(gate.beginAttempt(1_000_000)).toBeUndefined();
    gate.recordSuccess(1_000_000);
    const permit = gate.beginAttempt(1_000_000)!;
    gate.settleAttempt(permit, 'challenge', 1_000_000);
    expect(gate.snapshot(9_000_000)).toEqual({ status: 'open', reason: 'challenge' });
    gate.recordSuccess(9_000_000);
    expect(gate.snapshot(9_000_000)).toEqual({ status: 'closed' });
  });

  it('preserves unsettled single-flight permits when success clears penalties', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 100 });
    const permit = gate.beginAttempt(0)!;
    gate.settleAttempt(permit, 'failure', 0);
    const inflight = gate.beginAttempt(50)!;
    gate.recordSuccess(51);
    expect(gate.snapshot(51)).toEqual({ status: 'closed' });
    expect(gate.beginAttempt(51)).toBeUndefined();
    gate.settleAttempt(inflight, 'accepted', 52);
    expect(gate.beginAttempt(52)).toBeDefined();
  });

  it('penalizes cycles, keeps open gates open, and reveals no credentials', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 100, maxFailures: 2 });
    gate.recordCycleFailure(0);
    expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
    gate.recordCycleFailure(50);
    expect(gate.snapshot(50)).toEqual({ status: 'open', reason: 'failures' });
    gate.recordCycleFailure(60);
    expect(Object.keys(gate.snapshot(60)).sort()).toEqual(['reason', 'status']);
    expect(JSON.stringify(gate.snapshot(60))).not.toMatch(/USER|PASS|password|username/i);
  });

  it('validates options and publishes production defaults', () => {
    expect(FACEBOOK_LOGIN_GATE_DEFAULTS).toEqual({ baseCooldownMs: 30_000, maxCooldownMs: 600_000, maxFailures: 3 });
    expect(() => new FacebookLoginCircuitBreaker({ baseCooldownMs: 0 })).toThrow(RangeError);
    expect(() => new FacebookLoginCircuitBreaker({ maxCooldownMs: 2_147_483_648 })).toThrow(RangeError);
    expect(() => new FacebookLoginCircuitBreaker({ maxFailures: 0 })).toThrow(RangeError);
    expect(() => new FacebookLoginCircuitBreaker({ maxFailures: 1.5 })).toThrow(RangeError);
    expect(() => new FacebookLoginCircuitBreaker({ baseCooldownMs: 100, maxCooldownMs: 50 })).toThrow(RangeError);
  });
});
