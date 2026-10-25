import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_LOGIN_GATE_DEFAULTS,
  FacebookLoginCircuitBreaker
} from '../src/facebook-login-circuit-breaker.js';

describe('FacebookLoginCircuitBreaker', () => {
  it('grants one permit across scopes, records outcomes once, and rejects foreign permits', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200 });
    const permit = gate.beginAttempt('marketplace', 0)!;
    expect(permit.scope).toBe('marketplace');
    expect(gate.beginAttempt('marketplace', 0)).toBeUndefined();
    // The single in-flight permit is account-wide: the other scope waits for it too.
    expect(gate.beginAttempt('messenger', 0)).toBeUndefined();
    gate.settleAttempt(permit, 'failure', 0);
    gate.settleAttempt(permit, 'failure', 0);
    expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
    expect(() => new FacebookLoginCircuitBreaker().settleAttempt(permit, 'failure', 0)).toThrow(TypeError);
  });

  it('applies exponential cooldown with cap and expiry', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 10 });
    let now = 0;
    for (const cooldown of [50, 100, 200, 200]) {
      const permit = gate.beginAttempt('marketplace', now)!;
      gate.settleAttempt(permit, 'failure', now);
      expect(gate.snapshot(now)).toMatchObject({ status: 'cooldown', blockedForMs: cooldown });
      expect(gate.beginAttempt('marketplace', now + cooldown - 1)).toBeUndefined();
      now += cooldown;
      const granted = gate.beginAttempt('marketplace', now);
      expect(granted).toBeDefined();
      gate.settleAttempt(granted!, 'abandoned', now);
    }
  });

  it('opens on threshold or challenge, and verified success closes either state', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
    for (const now of [0, 50, 150]) {
      const permit = gate.beginAttempt('marketplace', now)!;
      gate.settleAttempt(permit, 'failure', now);
    }
    expect(gate.snapshot(1_000_000)).toEqual({ status: 'open', reason: 'failures' });
    expect(gate.beginAttempt('marketplace', 1_000_000)).toBeUndefined();
    gate.recordSuccess('marketplace', 1_000_000);
    const permit = gate.beginAttempt('marketplace', 1_000_000)!;
    gate.settleAttempt(permit, 'challenge', 1_000_000);
    expect(gate.snapshot(9_000_000)).toEqual({ status: 'open', reason: 'challenge' });
    gate.recordSuccess('marketplace', 9_000_000);
    expect(gate.snapshot(9_000_000)).toEqual({ status: 'closed' });
  });

  it('preserves unsettled single-flight permits when success clears penalties', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 100 });
    const permit = gate.beginAttempt('marketplace', 0)!;
    gate.settleAttempt(permit, 'failure', 0);
    const inflight = gate.beginAttempt('marketplace', 50)!;
    gate.recordSuccess('marketplace', 51);
    expect(gate.snapshot(51)).toEqual({ status: 'closed' });
    expect(gate.beginAttempt('marketplace', 51)).toBeUndefined();
    // Release-only settle: the permit is dropped without grading cycles (an 'accepted' settle
    // would grade the claim now covered by the dedicated tests above).
    gate.settleAttempt(inflight, 'abandoned', 52);
    expect(gate.beginAttempt('marketplace', 52)).toBeDefined();
  });

  it('penalizes cycles, keeps open gates open, and reveals no credentials', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 100, maxFailures: 2 });
    gate.recordCycleFailure('marketplace', 0);
    expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
    gate.recordCycleFailure('marketplace', 50);
    expect(gate.snapshot(50)).toEqual({ status: 'open', reason: 'failures' });
    gate.recordCycleFailure('marketplace', 60);
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

  it('starts a fresh instance closed after a restart', () => {
    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
    gate.recordCycleFailure('marketplace', 0);
    expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
    // A restart replaces the in-memory breaker, so nothing carries over.
    const restarted = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
    expect(restarted.snapshot(0)).toEqual({ status: 'closed' });
    expect(restarted.beginAttempt('marketplace', 0)).toBeDefined();
  });

  describe('scope-owned penalties', () => {
    it('keeps a foreign usable session from clearing a challenge hard open', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'challenge', 0);
      expect(gate.snapshot(1_000)).toEqual({ status: 'open', reason: 'challenge' });
      // A usable session in the other scope proves nothing about the profile that hit the
      // challenge, so the account stays hard open.
      gate.recordSuccess('messenger', 1_000);
      expect(gate.snapshot(1_000)).toEqual({ status: 'open', reason: 'challenge' });
      expect(gate.beginAttempt('marketplace', 1_000)).toBeUndefined();
      expect(gate.beginAttempt('messenger', 1_000)).toBeUndefined();
      // Only the scope that hit the challenge may close it.
      gate.recordSuccess('marketplace', 1_000);
      expect(gate.snapshot(1_000)).toEqual({ status: 'closed' });
    });

    it('keeps a foreign usable session from clearing another scope cooldown or failure count', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      gate.recordCycleFailure('marketplace', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
      gate.recordSuccess('messenger', 10);
      expect(gate.snapshot(10)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 40 });
      expect(gate.beginAttempt('marketplace', 10)).toBeUndefined();
      // The escalation survives cross-scope traffic: the second failure doubles the cooldown.
      const permit = gate.beginAttempt('marketplace', 50)!;
      gate.settleAttempt(permit, 'failure', 50);
      expect(gate.snapshot(50)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 100 });
    });

    it('keeps a separate failure counter and cooldown per scope', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 5 });
      gate.recordCycleFailure('marketplace', 0);
      gate.recordCycleFailure('messenger', 0);
      // The Messenger scope escalates on its own counter, so it is the binding cooldown.
      const messenger = gate.beginAttempt('messenger', 50)!;
      gate.settleAttempt(messenger, 'failure', 50);
      expect(gate.snapshot(60)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 90 });
      // The Marketplace counter is untouched by the Messenger failure: it is still at one, so its
      // next failure doubles to two instead of jumping to three.
      const marketplace = gate.beginAttempt('marketplace', 150)!;
      gate.settleAttempt(marketplace, 'failure', 150);
      expect(gate.snapshot(150)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 100 });
    });

    it('hard-opens every scope at a scope failure threshold and only the owner may close it', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 2 });
      gate.recordCycleFailure('messenger', 0);
      const permit = gate.beginAttempt('messenger', 50)!;
      gate.settleAttempt(permit, 'failure', 50);
      expect(gate.snapshot(1_000)).toEqual({ status: 'open', reason: 'failures' });
      expect(gate.beginAttempt('marketplace', 1_000)).toBeUndefined();
      expect(gate.beginAttempt('messenger', 1_000)).toBeUndefined();
      gate.recordSuccess('marketplace', 1_000);
      expect(gate.snapshot(1_000)).toEqual({ status: 'open', reason: 'failures' });
      gate.recordSuccess('messenger', 1_000);
      expect(gate.snapshot(1_000)).toEqual({ status: 'closed' });
    });

    it('never lets a settle in one scope modify the other scope counter', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 5 });
      // The Marketplace scope holds a permit in flight while the Messenger scope escalates on its
      // own counter to two failures.
      const marketplace = gate.beginAttempt('marketplace', 0)!;
      gate.recordCycleFailure('messenger', 0);
      gate.recordCycleFailure('messenger', 50);
      gate.settleAttempt(marketplace, 'failure', 50);
      // The Messenger scope's cooldown is the binding one, so the snapshot reports that scope's
      // own counter of two. A settle that wrote into the other scope's state would change it.
      expect(gate.snapshot(50)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 100 });
    });

    it('keeps a challenge owned by the scope that hit it', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const messenger = gate.beginAttempt('messenger', 0)!;
      gate.settleAttempt(messenger, 'challenge', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      // The Marketplace scope owns nothing here, so its success changes nothing.
      gate.recordSuccess('marketplace', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      gate.recordSuccess('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'closed' });
    });

    it('keeps the hard-open owner when another scope fails while its attempt is in flight', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 1 });
      const marketplace = gate.beginAttempt('marketplace', 0)!;
      // The Messenger scope reaches its threshold first and owns the hard open.
      gate.recordCycleFailure('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'failures' });
      // The in-flight Marketplace attempt concludes after the open is standing.
      gate.settleAttempt(marketplace, 'failure', 0);
      // The open keeps the scope that caused it, so only the Messenger scope may close it.
      gate.recordSuccess('marketplace', 10);
      expect(gate.snapshot(10)).toEqual({ status: 'open', reason: 'failures' });
      gate.recordSuccess('messenger', 10);
      expect(gate.snapshot(10)).toEqual({ status: 'closed' });
    });
  });

  describe('probe-observed challenges', () => {
    it('hard-opens the account gate for every scope', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      gate.recordChallenge('marketplace', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      // The hard open is account-wide: neither scope may start a credential attempt.
      expect(gate.beginAttempt('marketplace', 0)).toBeUndefined();
      expect(gate.beginAttempt('messenger', 0)).toBeUndefined();
    });

    it('closes the challenge hard open only for the scope that observed it', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      gate.recordChallenge('marketplace', 0);
      // A usable session in the other scope proves nothing about the challenged profile, so the
      // account stays hard open.
      gate.recordSuccess('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      expect(gate.beginAttempt('messenger', 0)).toBeUndefined();
      // Only the scope that observed the challenge may close it.
      gate.recordSuccess('marketplace', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'closed' });
      expect(gate.beginAttempt('marketplace', 0)).toBeDefined();
    });

    it('keeps the standing hard-open owner when another scope observes a challenge', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'challenge', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      // The Messenger scope observes a challenge of its own; the standing open keeps the scope
      // that caused it.
      gate.recordChallenge('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      gate.recordSuccess('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      gate.recordSuccess('marketplace', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'closed' });
    });

    it('clears the observing scope unverified claim instead of grading it as a failed cycle', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 5 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'accepted', 0);
      // The Messenger scope owns the standing open, so the Marketplace challenge counts as a
      // failed cycle for the scope that hit it.
      gate.recordChallenge('messenger', 0);
      gate.recordChallenge('marketplace', 0);
      // The Messenger scope closes the account-wide open; the Marketplace scope keeps its own
      // failed cycle.
      gate.recordSuccess('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
      // The Marketplace scope's unverified acceptance was cleared by the challenge, so once its
      // own cooldown expires the next attempt is granted instead of being graded as another
      // failed cycle.
      expect(gate.beginAttempt('marketplace', 60)).toBeDefined();
    });
  });

  describe('permit revocation', () => {
    it('aborts the active permit when a challenge is recorded in the same scope', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      expect(permit.signal.aborted).toBe(false);
      gate.recordChallenge('marketplace', 0);
      // The permit is revoked by the challenge, whatever scope recorded it.
      expect(permit.signal.aborted).toBe(true);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
    });

    it('aborts the active permit when a challenge is recorded in the other scope', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      expect(permit.signal.aborted).toBe(false);
      // A challenge is a fact about the account, so the other scope's probe revokes this scope's
      // attempt too.
      gate.recordChallenge('messenger', 0);
      expect(permit.signal.aborted).toBe(true);
    });

    it('charges no retry budget to the scope whose attempt a challenge revoked', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      // The Messenger scope observes a challenge while the Marketplace attempt is in flight.
      gate.recordChallenge('messenger', 0);
      expect(permit.signal.aborted).toBe(true);
      // The revoked attempt is abandoned rather than failed, so the Marketplace scope spends no
      // retry budget on it and the account closes cleanly once the owning scope verifies a
      // session.
      gate.settleAttempt(permit, 'abandoned', 0);
      gate.recordSuccess('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'closed' });
    });

    it('leaves a settled permit unrevoked when a challenge is recorded later', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'abandoned', 0);
      gate.recordChallenge('messenger', 0);
      // The permit already concluded, so nothing is left to revoke.
      expect(permit.signal.aborted).toBe(false);
    });

    it('does not revoke a permit that reported the challenge itself', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'challenge', 0);
      // The attempt reported the challenge, so it has already stopped submitting credentials.
      expect(permit.signal.aborted).toBe(false);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
    });

    it('grants a permit whose signal starts unrevoked and refuses to grant one while the gate is open', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      // The revocation channel is armed together with the grant, so a fresh permit starts live.
      expect(permit.signal.aborted).toBe(false);
      gate.settleAttempt(permit, 'abandoned', 0);
      gate.recordChallenge('messenger', 0);
      expect(gate.snapshot(0)).toEqual({ status: 'open', reason: 'challenge' });
      // The hard open refuses every scope, so no further permit is granted.
      expect(gate.beginAttempt('marketplace', 0)).toBeUndefined();
      expect(gate.beginAttempt('messenger', 0)).toBeUndefined();
    });
  });

  describe('threshold cooldown under a standing open', () => {
    it('holds a scope that reached its threshold back while another scope owns the open', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 2 });
      // The Marketplace scope fails once and is holding a second attempt.
      gate.recordCycleFailure('marketplace', 0);
      const marketplace = gate.beginAttempt('marketplace', 50)!;
      // The Messenger scope observes a challenge and owns the account-wide open.
      gate.recordChallenge('messenger', 50);
      expect(gate.snapshot(50)).toEqual({ status: 'open', reason: 'challenge' });
      // The in-flight Marketplace attempt fails while the Messenger open stands, so the
      // Marketplace scope reaches its own failure threshold.
      gate.settleAttempt(marketplace, 'failure', 50);
      // The Marketplace scope records no verified success of its own: a usable session in a
      // challenged profile is exactly what the open is waiting for.
      expect(gate.snapshot(50)).toEqual({ status: 'open', reason: 'challenge' });
      // The owning scope's verified success closes the open.
      gate.recordSuccess('messenger', 60);
      // The threshold scope stays held back by its own cooldown instead of getting a free
      // attempt the moment the other scope's open clears.
      expect(gate.snapshot(60)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 190 });
      expect(gate.beginAttempt('marketplace', 60)).toBeUndefined();
      expect(gate.beginAttempt('marketplace', 249)).toBeUndefined();
      expect(gate.beginAttempt('marketplace', 250)).toBeDefined();
    });

    it('keeps the owner path invisible: its verified success clears its own penalty', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 2 });
      gate.recordCycleFailure('messenger', 0);
      const messenger = gate.beginAttempt('messenger', 50)!;
      gate.settleAttempt(messenger, 'failure', 50);
      expect(gate.snapshot(50)).toEqual({ status: 'open', reason: 'failures' });
      // The scope that owns the open records its own verified success: its penalty and cooldown
      // are reset, so the open closing leaves nothing behind.
      gate.recordSuccess('messenger', 60);
      expect(gate.snapshot(60)).toEqual({ status: 'closed' });
      expect(gate.beginAttempt('messenger', 60)).toBeDefined();
    });
  });

  describe('unconfirmed accepted self-claims', () => {
    it('grades an unverified acceptance as one failed cycle at the next attempt', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'accepted', 0);
      // The self-claim is invisible until the next request asks for an attempt, then it is graded.
      expect(gate.snapshot(10)).toEqual({ status: 'closed' });
      expect(gate.beginAttempt('marketplace', 10)).toBeUndefined();
      expect(gate.snapshot(10)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
      expect(gate.beginAttempt('marketplace', 10)).toBeUndefined();
    });

    it('grades an unverified acceptance against the scope that made the claim', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      const permit = gate.beginAttempt('messenger', 0)!;
      gate.settleAttempt(permit, 'accepted', 0);
      expect(gate.snapshot(10)).toEqual({ status: 'closed' });
      // The next request may come from the other scope, but the graded penalty belongs to the
      // scope that made the unverified claim.
      expect(gate.beginAttempt('marketplace', 10)).toBeUndefined();
      expect(gate.snapshot(10)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
      // A success for the scope that asked for the attempt does not clear the other scope's
      // penalty, which is what proves the penalty was graded on the claiming scope.
      gate.recordSuccess('marketplace', 10);
      expect(gate.snapshot(10)).toEqual({ status: 'cooldown', failures: 1, blockedForMs: 50 });
      gate.recordSuccess('messenger', 10);
      expect(gate.snapshot(10)).toEqual({ status: 'closed' });
    });

    it('clears the claim on verified success and never carries it into later cycles', () => {
      const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 50, maxCooldownMs: 200, maxFailures: 3 });
      let permit = gate.beginAttempt('marketplace', 0)!;
      gate.settleAttempt(permit, 'accepted', 0);
      expect(gate.beginAttempt('marketplace', 10)).toBeUndefined();
      // A usable session verified by an independent probe resets the scope, claim included.
      gate.recordSuccess('marketplace', 11);
      expect(gate.snapshot(11)).toEqual({ status: 'closed' });

      permit = gate.beginAttempt('marketplace', 12)!;
      gate.settleAttempt(permit, 'accepted', 12);
      expect(gate.beginAttempt('marketplace', 13)).toBeUndefined();
      // After the due cooldown a fresh attempt is granted with a clean claim, so its own failure
      // settles exactly one penalty; the consumed acceptance is not graded a second time.
      permit = gate.beginAttempt('marketplace', 63)!;
      gate.settleAttempt(permit, 'failure', 63);
      expect(gate.snapshot(63)).toEqual({ status: 'cooldown', failures: 2, blockedForMs: 100 });
      expect(gate.beginAttempt('marketplace', 163)).toBeDefined();
    });
  });
});
