import { describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager } from '../src/browser.js';
import { FacebookSessionProbe } from '../src/facebook.js';
import { FacebookCredentialLogin } from '../src/facebook-login.js';
import { FacebookLoginCircuitBreaker } from '../src/facebook-login-circuit-breaker.js';
import { FacebookMarketplaceBackend } from '../src/facebook-marketplace-backend.js';
import { FacebookMessengerBackend } from '../src/facebook-messenger-backend.js';
import { searchInputSchema, threadsListInputSchema } from '../src/domain.js';

const loginRequired = { status: 'session_needs_reauth', code: 'LOGIN_REQUIRED', outcome: 'login_required' } as const;
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

function mockProbe(probe: FacebookSessionProbe, results: Array<typeof loginRequired | typeof usable>) {
  vi.spyOn(probe, 'probeSession').mockImplementation(async () => results.shift() ?? loginRequired);
}

function mockLogin(login: FacebookCredentialLogin, outcomes: Array<'timeout' | 'authenticated' | 'challenge'> = ['timeout']) {
  return vi.spyOn(login, 'attempt').mockImplementation(async () => {
    const outcome = outcomes.shift() ?? 'timeout';
    return { outcome, code: outcome === 'challenge' ? 'CAPTCHA_REQUIRED' as const : 'LOGIN_REQUIRED' as const };
  });
}

/**
 * Runs the Messenger session gate alone, without the browser work that follows it, so the shared
 * gate's scope ownership can be exercised without a Chromium install.
 */
function messengerSession(messenger: FacebookMessengerBackend) {
  return (messenger as unknown as { ensureUsableSession(signal: AbortSignal): Promise<void> }).ensureUsableSession(signal());
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
});
