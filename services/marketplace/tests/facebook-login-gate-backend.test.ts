import { describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager } from '../src/browser.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookLoginCircuitBreaker, type FacebookLoginScope } from '../src/facebook-login-circuit-breaker.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { searchInputSchema, threadReadInputSchema, threadsListInputSchema, threadSendInputSchema } from '../src/domain.js';

const loginRequired = { status: 'session_needs_reauth', code: 'LOGIN_REQUIRED', outcome: 'login_required' } as const;
const captchaRequired = { status: 'session_needs_reauth', code: 'CAPTCHA_REQUIRED', outcome: 'captcha' } as const;
const checkpointRequired = { status: 'session_needs_reauth', code: 'SESSION_INVALID', outcome: 'checkpoint' } as const;
const usable = { status: 'session_usable', outcome: 'messages_authenticated' } as const;
const signal = () => new AbortController().signal;
const search = searchInputSchema.parse({ query: 'bike', location: 'New York City' });
const threads = threadsListInputSchema.parse({ limit: 10 });

function setup(gate = new FacebookLoginCircuitBreaker()) {
  const browser = new BrowserSessionManager({ profileDir: '/tmp/circuit-gate-test-profile' });
  const marketplaceProbe = new FacebookSessionProbe({ browser, baseUrl: 'http://127.0.0.1:1234' });
  const messengerBrowser = new BrowserSessionManager({ profileDir: '/tmp/circuit-gate-test-messenger-profile' });
  const messengerProbe = new FacebookSessionProbe({ browser: messengerBrowser, baseUrl: 'http://127.0.0.1:1234', surface: 'messenger' });
  const marketplaceLogin = new FacebookCredentialLogin({ browser, username: 'USER-SENTINEL-1234', password: 'PASS-SENTINEL-5678' });
  const messengerLogin = new FacebookCredentialLogin({ browser: messengerBrowser, username: 'USER-SENTINEL-1234', password: 'PASS-SENTINEL-5678', surface: 'messenger' });
  const marketplace = new FacebookMarketplaceBackend({ browser, probe: marketplaceProbe, login: marketplaceLogin, loginGate: gate });
  const messenger = new FacebookMessengerBackend({ browser: messengerBrowser, probe: messengerProbe, login: messengerLogin, loginGate: gate });
  return { gate, marketplace, messenger, marketplaceProbe, messengerProbe, marketplaceLogin, messengerLogin, browser, messengerBrowser };
}

function mockProbe(
  probe: FacebookSessionProbe,
  results: Array<typeof loginRequired | typeof captchaRequired | typeof checkpointRequired | typeof usable>
) {
  vi.spyOn(probe, 'probeSession').mockImplementation(async () => results.shift() ?? loginRequired);
}

function mockLogin(login: FacebookCredentialLogin, outcomes: Array<'timeout' | 'authenticated' | 'challenge'> = ['timeout']) {
  return vi.spyOn(login, 'attempt').mockImplementation(async () => {
    const outcome = outcomes.shift() ?? 'timeout';
    return { outcome, code: outcome === 'challenge' ? 'CAPTCHA_REQUIRED' as const : 'LOGIN_REQUIRED' as const };
  });
}

/**
 * Stands in for a credential attempt that is in flight: it only concludes when the signal it was
 * handed aborts, which is what a challenge recorded while it runs has to cause. Without that
 * abort the attempt would go on and submit the login form, so `submitted` records the credential
 * submission the abort is supposed to prevent.
 */
function mockInFlightAttempt(login: FacebookCredentialLogin): {
  signal: () => AbortSignal | undefined;
  submitted: () => boolean;
} {
  let received: AbortSignal | undefined;
  let submitted = false;
  vi.spyOn(login, 'attempt').mockImplementation(async (attemptSignal: AbortSignal) => {
    received = attemptSignal;
    return await new Promise((_resolve, reject) => {
      attemptSignal.addEventListener('abort', () => {
        reject(attemptSignal.reason ?? new Error('Browser operation aborted'));
      }, { once: true });
      // The attempt would submit the credentials on the next tick unless the abort lands first.
      setTimeout(() => {
        if (attemptSignal.aborted) return;
        submitted = true;
        reject(new Error('The credential attempt submitted the login form.'));
      }, 20);
    });
  });
  return { signal: () => received, submitted: () => submitted };
}

/**
 * Records a challenge in the window between the gate granting the permit and the credential
 * attempt starting: the grant is intercepted and the challenge is recorded synchronously right
 * after the permit is granted. The backends defer the attempt by one microtask, so the challenge
 * lands exactly in that window, before any credential could be submitted.
 */
function challengeOnGrant(gate: FacebookLoginCircuitBreaker, scope: FacebookLoginScope) {
  const grant = gate.beginAttempt.bind(gate);
  vi.spyOn(gate, 'beginAttempt').mockImplementation((requested: FacebookLoginScope, now?: number) => {
    const permit = grant(requested, now);
    if (permit) gate.recordChallenge(scope, now);
    return permit;
  });
}

/**
 * Runs the Messenger session gate alone, without the browser work that follows it, so the shared
 * gate's scope ownership can be exercised without a Chromium install.
 */
function messengerSession(messenger: FacebookMessengerBackend) {
  return (messenger as unknown as { ensureUsableSession(signal: AbortSignal): Promise<void> }).ensureUsableSession(signal());
}

/**
 * Runs the Marketplace session gate alone, the Marketplace counterpart of `messengerSession`.
 */
function marketplaceSession(marketplace: FacebookMarketplaceBackend) {
  return (marketplace as unknown as { ensureUsableSession(signal: AbortSignal): Promise<void> }).ensureUsableSession(signal());
}

async function expectLoginRequired(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED', message });
}

describe('Facebook backend login gate', () => {
  it('blocks sequential credential retries and preserves the existing error contract', async () => {
    const state = setup();
    mockProbe(state.marketplaceProbe, [loginRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    const message = 'Facebook Marketplace requires login.';
    await expectLoginRequired(state.marketplace.search(search, signal()), message);
    await expectLoginRequired(state.marketplace.search(search, signal()), message);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.gate.snapshot())).not.toMatch(/USER-SENTINEL-1234|PASS-SENTINEL-5678/);
    await state.browser.close();
  });

  it('allows only one concurrent attempt across Marketplace and Messenger', async () => {
    const state = setup();
    mockProbe(state.marketplaceProbe, [loginRequired]);
    mockProbe(state.messengerProbe, [loginRequired]);
    let finish!: (value: { outcome: 'timeout'; code: 'LOGIN_REQUIRED' }) => void;
    const attempt = vi.spyOn(state.marketplaceLogin, 'attempt').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const messengerAttempt = mockLogin(state.messengerLogin);
    const marketplaceRequest = state.marketplace.search(search, signal());
    while (!attempt.mock.results.length) await new Promise((resolve) => setTimeout(resolve, 0));
    const messengerRequest = state.messenger.listThreads(threads, signal());
    finish({ outcome: 'timeout', code: 'LOGIN_REQUIRED' });
    const results = await Promise.allSettled([marketplaceRequest, messengerRequest]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(messengerAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toMatch(/USER-SENTINEL-1234|PASS-SENTINEL-5678/);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('resets only after an independently verified usable session', async () => {
    const state = setup();
    mockProbe(state.marketplaceProbe, [loginRequired, usable, loginRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['authenticated', 'timeout']);
    const first = (state.marketplace as unknown as { ensureUsableSession(signal: AbortSignal): Promise<void> }).ensureUsableSession(signal());
    while (attempt.mock.calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(first).resolves.toBeUndefined();
    const second = (state.marketplace as unknown as { ensureUsableSession(signal: AbortSignal): Promise<void> }).ensureUsableSession(signal());
    await expect(second).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(state.gate.snapshot().status).toBe('cooldown');
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('grades a detached attempt whose accepted self-claim was never probe-verified', async () => {
    const state = setup();
    let settle!: (value: { outcome: 'authenticated' }) => void;
    const attempt = vi.spyOn(state.marketplaceLogin, 'attempt')
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }))
      .mockImplementation(async () => ({ outcome: 'timeout' as const, code: 'LOGIN_REQUIRED' as const }));
    mockProbe(state.marketplaceProbe, [loginRequired, loginRequired]);
    // The first request aborts while the login is still waiting for approval; the attempt keeps
    // running detached and concludes 'authenticated' with nobody around to confirm it through a
    // probe. The next cycle must grade that unverified self-claim instead of restarting freely.
    const budgeted = new AbortController();
    setTimeout(() => budgeted.abort(new Error('deadline exceeded')), 20);
    await expect(state.marketplace.search(search, budgeted.signal)).rejects.toBeInstanceOf(Error);
    settle({ outcome: 'authenticated' });
    // Let the detached attempt's promise chain finish settle and clear the registration before the
    // next request consults the gate; otherwise that request might join the finished attempt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED' });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toMatchObject({ status: 'cooldown', failures: 1 });
    await state.browser.close();
  });

  it('keeps the breaker in memory across backend reconstruction only when the same gate is reused', async () => {    const gate = new FacebookLoginCircuitBreaker({ baseCooldownMs: 10, maxCooldownMs: 40, maxFailures: 3 });
    const state = setup(gate);
    mockProbe(state.marketplaceProbe, [loginRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    await new Promise((resolve) => setTimeout(resolve, 12));
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(2);
    const restarted = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 10, maxCooldownMs: 40, maxFailures: 3 }));
    mockProbe(restarted.marketplaceProbe, [loginRequired]);
    const restartedAttempt = mockLogin(restarted.marketplaceLogin);
    await expectLoginRequired(restarted.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(restartedAttempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close(), restarted.browser.close(), restarted.messengerBrowser.close()]);
  });

  it('hard-opens on the configured failure threshold', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 10, maxCooldownMs: 40, maxFailures: 1 }));
    mockProbe(state.marketplaceProbe, [loginRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('does not let a usable Messenger session clear a Marketplace challenge hard open', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['challenge']);
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'CAPTCHA_REQUIRED' });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The Messenger profile is a separate browser session: its usable session proves nothing
    // about the Marketplace profile that hit the challenge.
    mockProbe(state.messengerProbe, [usable]);
    const messengerAttempt = mockLogin(state.messengerLogin);
    await expect(messengerSession(state.messenger)).resolves.toBeUndefined();
    expect(messengerAttempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The Marketplace gate is still hard open, so the next request never submits credentials.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED' });
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('closes a Marketplace-owned challenge hard open with its own probe-verified usable session', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [captchaRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['timeout']);
    // The Marketplace scope observes the challenge, so it owns the account-wide hard open.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook Marketplace requires a captcha challenge.'
    });
    expect(attempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });

    // The Marketplace scope's own probe verifies a usable session, so it closes its own open.
    mockProbe(state.marketplaceProbe, [usable]);
    await expect(marketplaceSession(state.marketplace)).resolves.toBeUndefined();
    expect(state.gate.snapshot()).toEqual({ status: 'closed' });

    // A later credential attempt is allowed again in the Marketplace scope.
    mockProbe(state.marketplaceProbe, [loginRequired]);
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when the Marketplace probe observes a captcha', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [captchaRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    // The challenge is reported with the frozen error contract, unchanged.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook Marketplace requires a captcha challenge.'
    });
    expect(attempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The hard open is account-wide, so the next request never submits credentials.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED' });
    expect(attempt).not.toHaveBeenCalled();
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when the Messenger probe observes a checkpoint', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [checkpointRequired]);
    const messengerAttempt = mockLogin(state.messengerLogin);
    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'SESSION_INVALID',
      message: 'The Facebook session requires a security check.'
    });
    expect(messengerAttempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The Messenger scope owns the open, but it blocks the Marketplace scope too.
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED' });
    expect(attempt).not.toHaveBeenCalled();
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('arms the shared gate from a Messenger probe-only run that observes a captcha', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    const probeOnly = new FacebookMessengerBackend({
      browser: state.messengerBrowser,
      probe: state.messengerProbe,
      loginGate: state.gate,
      probeOnly: true
    });
    mockProbe(state.messengerProbe, [captchaRequired]);
    await expect(messengerSession(probeOnly)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook requires a captcha challenge.'
    });
    // The diagnostics run observes the challenge, so it arms the gate even though the surface is
    // disabled.
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when the confirming Marketplace probe observes a captcha', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired, captchaRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['authenticated']);
    // The credential attempt is accepted, but the confirming probe finds a captcha: the challenge
    // is a fact about the profile, so the gate hard-opens instead of taking a cooldown.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook Marketplace requires a captcha challenge.'
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The hard open is account-wide, so the next request never submits credentials.
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'LOGIN_REQUIRED' });
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when the confirming Messenger probe observes a checkpoint', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [loginRequired, checkpointRequired, loginRequired]);
    const attempt = mockLogin(state.messengerLogin, ['authenticated']);
    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'SESSION_INVALID',
      message: 'The Facebook session requires a security check.'
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The hard open is account-wide, so the next request never submits credentials.
    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_REQUIRED',
      message: 'Facebook login is required to read Marketplace conversations.'
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('grades a confirming plain login requirement as a failed cycle, not a hard open', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired, loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['authenticated']);
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_REQUIRED',
      message: 'Facebook Marketplace requires login.'
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    // A plain login requirement is the credential path's business: it grades one failed cycle and
    // leaves the gate in a cooldown, never the challenge hard open.
    expect(state.gate.snapshot()).toMatchObject({ status: 'cooldown', failures: 1 });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('submits no credentials when a challenge lands between the Marketplace permit grant and the attempt', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    // The Messenger scope observes a challenge in the window between the gate granting the
    // Marketplace permit and the credential attempt starting.
    challengeOnGrant(state.gate, 'messenger');

    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    // The revoked attempt never started, so no credential was submitted.
    expect(attempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('submits no credentials when a challenge lands between the Messenger permit grant and the attempt', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [loginRequired]);
    const attempt = mockLogin(state.messengerLogin);
    // The Marketplace scope observes a challenge in the window between the gate granting the
    // Messenger permit and the credential attempt starting.
    challengeOnGrant(state.gate, 'marketplace');

    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_REQUIRED',
      message: 'Facebook login is required to read Marketplace conversations.'
    });
    // The revoked attempt never started, so no credential was submitted.
    expect(attempt).not.toHaveBeenCalled();
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('charges no retry budget to a scope whose attempt a challenge cut short', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired]);
    // The Messenger scope observes a challenge while the Marketplace attempt is running, and the
    // attempt concludes with a failed login rather than throwing.
    const attempt = vi.spyOn(state.marketplaceLogin, 'attempt').mockImplementation(async () => {
      state.gate.recordChallenge('messenger', Date.now());
      return { outcome: 'timeout' as const, code: 'LOGIN_REQUIRED' as const };
    });

    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The Messenger scope owns the open and closes it with its own verified session.
    mockProbe(state.messengerProbe, [usable]);
    await expect(messengerSession(state.messenger)).resolves.toBeUndefined();
    // The revoked attempt was abandoned rather than failed, so the Marketplace scope spends no
    // retry budget on it.
    expect(state.gate.snapshot()).toEqual({ status: 'closed' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('aborts an in-flight Marketplace attempt when the Messenger scope observes a challenge', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockInFlightAttempt(state.marketplaceLogin);

    const marketplaceRequest = state.marketplace.search(search, signal());
    while (!attempt.signal()) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempt.signal()!.aborted).toBe(false);

    // The Messenger scope observes a captcha in its own profile while the Marketplace attempt is
    // in flight. The Messenger profile is a separate browser session, so this attempt is not
    // serialized against the probe.
    mockProbe(state.messengerProbe, [captchaRequired]);
    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook requires a captcha challenge.'
    });

    // The in-flight attempt was revoked before it could submit any further credentials.
    expect(attempt.signal()!.aborted).toBe(true);
    await expect(marketplaceRequest).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_REQUIRED',
      message: 'Facebook Marketplace requires login.'
    });
    expect(attempt.submitted()).toBe(false);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });

    // The revoked attempt is abandoned, not failed: the Marketplace scope spends no retry budget
    // on it, so once the owning scope's verified session closes the open the scope may attempt
    // again with a clean budget.
    mockProbe(state.messengerProbe, [usable]);
    await expect(messengerSession(state.messenger)).resolves.toBeUndefined();
    expect(state.gate.snapshot()).toEqual({ status: 'closed' });
    const permit = state.gate.beginAttempt('marketplace', Date.now());
    expect(permit).toBeDefined();
    state.gate.settleAttempt(permit!, 'abandoned', Date.now());
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('aborts an in-flight Messenger attempt when the Marketplace scope observes a challenge', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [loginRequired]);
    const attempt = mockInFlightAttempt(state.messengerLogin);

    const messengerRequest = messengerSession(state.messenger);
    while (!attempt.signal()) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempt.signal()!.aborted).toBe(false);

    // The Marketplace scope observes a captcha in its own profile while the Messenger attempt is
    // in flight.
    mockProbe(state.marketplaceProbe, [captchaRequired]);
    await expect(marketplaceSession(state.marketplace)).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'CAPTCHA_REQUIRED',
      message: 'Facebook Marketplace requires a captcha challenge.'
    });

    expect(attempt.signal()!.aborted).toBe(true);
    await expect(messengerRequest).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'LOGIN_REQUIRED',
      message: 'Facebook login is required to read Marketplace conversations.'
    });
    expect(attempt.submitted()).toBe(false);
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });

    // The revoked attempt is abandoned, not failed: the Messenger scope spends no retry budget.
    mockProbe(state.marketplaceProbe, [usable]);
    await expect(marketplaceSession(state.marketplace)).resolves.toBeUndefined();
    expect(state.gate.snapshot()).toEqual({ status: 'closed' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('does not let a usable Messenger session clear a Marketplace cooldown', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin, ['timeout']);
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(state.gate.snapshot()).toMatchObject({ status: 'cooldown', failures: 1 });
    // The Messenger success clears only the Messenger scope's own penalty.
    mockProbe(state.messengerProbe, [usable]);
    await expect(messengerSession(state.messenger)).resolves.toBeUndefined();
    expect(state.gate.snapshot()).toMatchObject({ status: 'cooldown', failures: 1 });
    // The Marketplace cooldown still holds, so the second request never submits credentials.
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).toHaveBeenCalledTimes(1);
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  // Page-observed challenges (#161 review): a captcha or checkpoint a page loaded under the
  // session is as much a fact about the account as a probe result, so it must hard-open the
  // shared gate too — the other scope may not start a credential attempt on its strength.
  type ObservedPageKind = 'login' | 'captcha' | 'checkpoint';
  const observedPageSignals = (kind: ObservedPageKind) => ({
    hasPasswordInput: false, hasLoginForm: kind === 'login',
    hasCheckpointForm: kind === 'checkpoint', hasCaptchaFrame: kind === 'captcha',
    hasMainLandmark: true, hasAuthenticatedMarker: false, hasLoginPrompt: false,
    mentionsCheckpoint: kind === 'checkpoint', mentionsCaptcha: kind === 'captcha'
  });

  function driveObservedPage(manager: BrowserSessionManager, extraction: Record<string, unknown>): void {
    const page = { goto: async () => undefined, evaluate: async () => extraction };
    vi.spyOn(manager, 'runExclusive').mockImplementation(async (signal, task) =>
      task(page as never, signal));
  }

  it('hard-opens the shared gate when a Marketplace result page observes a captcha', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [usable]);
    driveObservedPage(state.browser, {
      url: 'http://127.0.0.1:1234/marketplace/nyc/search/?query=bike',
      signals: { hasCaptcha: true, hasCheckpoint: false, hasLoginForm: false, hasRateLimitNotice: false, hasNoResultsNotice: false },
      cards: []
    });
    await expect(state.marketplace.search(search, signal())).rejects.toMatchObject({
      name: 'ProviderError', code: 'CAPTCHA_REQUIRED'
    });
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The hard open is account-wide: the Messenger scope may not submit credentials either.
    mockProbe(state.messengerProbe, [loginRequired]);
    const messengerAttempt = mockLogin(state.messengerLogin);
    await expect(messengerSession(state.messenger)).rejects.toMatchObject({
      name: 'ProviderError', code: 'LOGIN_REQUIRED'
    });
    expect(messengerAttempt).not.toHaveBeenCalled();
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when a Messenger thread page observes a checkpoint', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [usable]);
    driveObservedPage(state.messengerBrowser, {
      url: 'http://127.0.0.1:1234/messages/t/1684432532/',
      signals: observedPageSignals('checkpoint'),
      messages: []
    });
    await expect(state.messenger.readThread(threadReadInputSchema.parse({ thread_id: '1684432532' }), signal()))
      .rejects.toMatchObject({ name: 'ProviderError', code: 'SESSION_INVALID' });
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    // The hard open is account-wide: the Marketplace scope may not submit credentials either.
    mockProbe(state.marketplaceProbe, [loginRequired]);
    const attempt = mockLogin(state.marketplaceLogin);
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    expect(attempt).not.toHaveBeenCalled();
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('hard-opens the shared gate when the send verification page observes a captcha', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.messengerProbe, [usable]);
    driveObservedPage(state.messengerBrowser, {
      url: 'http://127.0.0.1:1234/messages/t/1684432532/',
      signals: observedPageSignals('captcha'),
      messages: []
    });
    // The pre-submit verification page downgrades and hard-opens the gate; nothing was typed.
    await expect(state.messenger.sendThread(threadSendInputSchema.parse({
      thread_id: '1684432532', message: 'Synthetic send sentinel', idempotency_token: '0123456789abcdef'
    }), signal())).rejects.toMatchObject({ name: 'ProviderError', code: 'UPSTREAM_ERROR' });
    expect(state.gate.snapshot()).toEqual({ status: 'open', reason: 'challenge' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });

  it('does not hard-open the shared gate when a page observes only a plain login requirement', async () => {
    const state = setup(new FacebookLoginCircuitBreaker({ baseCooldownMs: 60_000, maxCooldownMs: 120_000, maxFailures: 3 }));
    mockProbe(state.marketplaceProbe, [usable]);
    driveObservedPage(state.browser, {
      url: 'http://127.0.0.1:1234/marketplace/nyc/search/?query=bike',
      signals: { hasCaptcha: false, hasCheckpoint: false, hasLoginForm: true, hasRateLimitNotice: false, hasNoResultsNotice: false },
      cards: []
    });
    await expectLoginRequired(state.marketplace.search(search, signal()), 'Facebook Marketplace requires login.');
    // A plain login requirement stays the recoverable credential path's business, so the gate
    // keeps its closed state and a later credential attempt is not blocked by a hard open.
    expect(state.gate.snapshot()).toEqual({ status: 'closed' });
    await Promise.all([state.browser.close(), state.messengerBrowser.close()]);
  });
});
