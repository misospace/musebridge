import { errors } from 'playwright';
import { BrowserSessionManager, BrowserUnavailableError, sleepUntilAbort } from './browser.js';
import type { ConversationBackend } from './backend.js';
import { ProviderError as MarketplaceProviderError, SurfaceDisabledError, renderDeliveredMessage } from './backend.js';
import { validateTimeout, waitForRequestBudget } from './timeout.js';
import {
  threadsListInputSchema,
  threadReadInputSchema,
  threadSendInputSchema,
  type ConversationDraft,
  type ConversationThread,
  type ConversationThreadMessages,
  type ProviderErrorCode
} from './domain.js';
import {
  extractMessengerInboxPage,
  extractMessengerThreadPage,
  MESSENGER_COMPOSER_SELECTOR,
  findMessengerComposer,
  classifyMessengerComposerCount,
  MESSENGER_EXTRACT_LIMITS,
  type ExtractedInboxPage,
  type ExtractedThreadPage
} from './facebook-messenger-extract.js';
import {
  classifyMessengerInboxPage,
  classifyMessengerThreadPage,
  interpretMessengerInboxPage,
  interpretMessengerThreadPage
} from './facebook-messenger-parse.js';
import {
  buildMessengerInboxUrl,
  buildMessengerThreadUrl,
  MESSENGER_THREAD_PATH
} from './facebook-messenger-url.js';
import { assertFacebookOrigin, FacebookSessionProbe, type FacebookProbeCode } from './facebook.js';
import { FacebookCredentialLogin } from './facebook-login.js';
import { FacebookLoginCircuitBreaker, type FacebookLoginAttemptPermit, type FacebookLoginScope } from './facebook-login-circuit-breaker.js';
import {
  MessengerInboxGraphQLCollector,
  parseMessengerInboxGraphQLRequest,
  type MessengerInboxGraphQLObservation
} from './facebook-messenger-inbox-graphql.js';

/**
 * The scope this backend owns in the shared account-level login gate. The Messenger profile is its
 * own browser session, so a usable session verified here only clears Messenger's own penalty; the
 * Marketplace scope keeps its own.
 */
const LOGIN_SCOPE: FacebookLoginScope = 'messenger';

export interface FacebookMessengerBackendOptions {
  browser: BrowserSessionManager;
  probe: FacebookSessionProbe;
  /** Optional env-backed login instance isolated to the Messenger browser profile. */
  login?: FacebookCredentialLogin;
  loginGate?: FacebookLoginCircuitBreaker;
  /** Probe the existing session only; never log in, extract threads, or open a conversation. */
  probeOnly?: boolean;
  inboxPath?: string;
  navigationTimeoutMs?: number;
  settleTimeoutMs?: number;
  graphqlFlushTimeoutMs?: number;
  maxThreads?: number;
  logger?: Pick<Console, 'error'>;
}

export class FacebookMessengerBackend implements ConversationBackend {
  readonly name = 'facebook';
  private readonly browser: BrowserSessionManager;
  private readonly probe: FacebookSessionProbe;
  private readonly login: FacebookCredentialLogin | undefined;
  readonly loginGate: FacebookLoginCircuitBreaker;
  private readonly probeOnly: boolean;
  private readonly inboxPath: string;
  private readonly navigationTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly graphqlFlushTimeoutMs: number;
  private readonly maxThreads: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly loginController = new AbortController();
  private credentialRecovery: Promise<{ recovered: boolean; code?: FacebookProbeCode }> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: FacebookMessengerBackendOptions) {
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
    this.probeOnly = options.probeOnly ?? false;
    if (typeof this.probeOnly !== 'boolean') throw new TypeError('probeOnly must be a boolean');
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 8_000;
    this.settleTimeoutMs = options.settleTimeoutMs ?? 3_000;
    this.graphqlFlushTimeoutMs = options.graphqlFlushTimeoutMs ?? GRAPHQL_FLUSH_TIMEOUT_MS;
    this.maxThreads = options.maxThreads ?? MESSENGER_EXTRACT_LIMITS.maxThreads;
    this.logger = options.logger ?? console;
    validateTimeout(this.navigationTimeoutMs, 'navigationTimeoutMs');
    validateTimeout(this.settleTimeoutMs, 'settleTimeoutMs');
    validateTimeout(this.graphqlFlushTimeoutMs, 'graphqlFlushTimeoutMs');
    if (!Number.isSafeInteger(this.maxThreads) || this.maxThreads < 1 || this.maxThreads > MESSENGER_EXTRACT_LIMITS.maxThreads) {
      throw new RangeError(`maxThreads must be an integer from 1 to ${MESSENGER_EXTRACT_LIMITS.maxThreads}`);
    }
    this.inboxPath = options.inboxPath ?? '/marketplace/inbox/';
    // Validate the configured path at startup, not in the middle of a browser operation.
    buildMessengerInboxUrl({ baseUrl: this.probe.baseUrl, inboxPath: this.inboxPath });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.loginController.abort(new Error('Facebook Messenger backend is shutting down'));
    this.closePromise = (async () => {
      await this.credentialRecovery?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  async listThreads(
    input: ReturnType<typeof threadsListInputSchema.parse>,
    signal: AbortSignal
  ): Promise<ConversationThread[]> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    await this.ensureUsableSession(signal);

    const inboxUrl = assertFacebookOrigin(buildMessengerInboxUrl({ baseUrl: this.probe.baseUrl, inboxPath: this.inboxPath }));
    let extracted: ExtractedInboxPage;
    let graphql: MessengerInboxGraphQLObservation = { recognized: false, malformed: false, empty: false, incomplete: false, threadIds: [] };
    try {
      const result = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        const collector = new MessengerInboxGraphQLCollector({ maxThreads: this.maxThreads });
        // Pending body reads run concurrently; each is bounded by `GRAPHQL_BODY_READ_TIMEOUT_MS`
        // and the whole flush is bounded by `graphqlFlushTimeoutMs` so 60 stalled bodies cannot
        // serialize 120s of work past the navigation and settle budgets.
        const pendingReads = new Set<Promise<void>>();
        let dispatchedReads = 0;
        const baseOrigin = new URL(this.probe.baseUrl).origin;
        const handler = (response: import('playwright').Response): void => {
          const work = (async () => {
            let potentiallyRelevant = false;
            try {
              const url = new URL(response.url());
              if (url.origin !== baseOrigin || !url.pathname.startsWith('/api/graphql/')) return;
              const request = response.request();
              let postData: string | null = null;
              try {
                postData = request.postData();
              } catch {
                // The response schema can still identify an inbox connection, but without its
                // request cursor it cannot contribute to a verified pagination chain.
              }
              const requestObservation = parseMessengerInboxGraphQLRequest({ body: postData, url: request.url() });
              if (requestObservation.kind === 'unrelated') return;
              potentiallyRelevant = true;
              if (!isJsonContentType(response.headers()['content-type'])) {
                collector.markUnobservedResponse();
                return;
              }
              if (dispatchedReads >= GRAPHQL_RESPONSE_READ_LIMIT) {
                collector.markUnobservedResponse();
                return;
              }
              dispatchedReads += 1;
              const payload = await readResponseBody(response);
              if (payload !== undefined) collector.observe(payload, requestObservation);
              else collector.markUnobservedResponse();
            } catch {
              if (potentiallyRelevant) collector.markUnobservedResponse();
              return;
            }
          })();
          pendingReads.add(work);
          // Each newly dispatched read inherits the flush clock that was started by the outer
          // `waitForReadFlush` call: the deadline is computed once in that call and the outer
          // loop re-races `Promise.allSettled(Array.from(pending))` against a fresh timeout
          // per pass, so a read added after the first pass is still bounded by the original
          // total budget. The per-read `GRAPHQL_BODY_READ_TIMEOUT_MS` ceiling also holds, so
          // the listener never holds the exclusive session past the flush deadline.
          void work.finally(() => { pendingReads.delete(work); });
        };
        page.on('response', handler);
        try {
          await page.goto(inboxUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.navigationTimeoutMs,
            signal: taskSignal
          });
          const extractOptions = {
            threadPath: MESSENGER_THREAD_PATH,
            limits: { ...MESSENGER_EXTRACT_LIMITS, maxThreads: this.maxThreads }
          };
          let pageResult = await page.evaluate(extractMessengerInboxPage, extractOptions);
          const deadline = Date.now() + this.settleTimeoutMs;
          while (classifyMessengerInboxPage(pageResult) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
            await sleepUntilAbort(200, taskSignal);
            if (!taskSignal.aborted) pageResult = await page.evaluate(extractMessengerInboxPage, extractOptions);
          }
          if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
          return pageResult;
        } finally {
          page.off('response', handler);
          await waitForReadFlush(pendingReads, this.graphqlFlushTimeoutMs);
          if (pendingReads.size > 0) collector.markUnobservedResponse();
          graphql = collector.snapshot();
        }
      });
      extracted = result;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new MarketplaceProviderError('TIMEOUT', 'The Facebook Marketplace inbox page did not load in time.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Messenger inbox read failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Marketplace inbox could not be read.');
    }

    const outcome = interpretMessengerInboxPage({
      page: extracted,
      baseUrl: this.probe.baseUrl,
      inboxPath: this.inboxPath,
      limit: input.limit,
      graphql
    });
    if (outcome.kind === 'error') throw new MarketplaceProviderError(outcome.code, outcome.message);
    if (outcome.kind === 'empty') return [];
    return [...outcome.threads];
  }

  async readThread(
    input: ReturnType<typeof threadReadInputSchema.parse>,
    signal: AbortSignal
  ): Promise<ConversationThreadMessages | null> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    await this.ensureUsableSession(signal);

    let threadUrl: string;
    try {
      threadUrl = assertFacebookOrigin(buildMessengerThreadUrl({ baseUrl: this.probe.baseUrl, threadId: input.thread_id }));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The requested Facebook Messenger thread id is invalid.');
      }
      throw error;
    }

    let extracted: ExtractedThreadPage;
    try {
      extracted = await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });
        const extractOptions = { limits: MESSENGER_EXTRACT_LIMITS };
        let result = await page.evaluate(extractMessengerThreadPage, extractOptions);
        const deadline = Date.now() + this.settleTimeoutMs;
        while (classifyMessengerThreadPage(result) === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) result = await page.evaluate(extractMessengerThreadPage, extractOptions);
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        return result;
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof errors.TimeoutError) {
        throw new MarketplaceProviderError('TIMEOUT', 'The Facebook Messenger thread page did not load in time.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.logger.error('Facebook Messenger thread read failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Messenger thread could not be read.');
    }

    const outcome = interpretMessengerThreadPage({ page: extracted, baseUrl: this.probe.baseUrl, threadId: input.thread_id });
    if (outcome.kind === 'error') throw new MarketplaceProviderError(outcome.code, outcome.message);
    // The coverage is part of the read contract: the window's newest end is established by the
    // explicit timestamps on the message rows (never by DOM order), and a truncated window says
    // so rather than presenting the newest messages as the whole thread. An orientation that
    // cannot be proven is a typed upstream error, never a window.
    return { thread_id: input.thread_id, messages: [...outcome.messages], coverage: outcome.coverage };
  }

  // A draft needs only the conversation context, so it reuses this same thread read — including
  // the "Seen" side effect of opening the thread that messenger_thread_read already documents. It
  // performs no send and no write, and adds no browser or session logic of its own.
  async prepareDraft(
    input: ReturnType<typeof threadSendInputSchema.parse>,
    signal: AbortSignal
  ): Promise<ConversationDraft | null> {
    const thread = await this.readThread({ thread_id: input.thread_id }, signal);
    if (thread === null) return null;
    // Extraction drops message rows whose sender name is empty or over the bound rather than
    // truncating it, so an unattributed conversation yields null rather than a fabricated handle.
    const lastCounterparty = [...thread.messages].reverse().find(({ sender }) => sender === 'other');
    return { participant: lastCounterparty?.sender_name ?? null };
  }

  async sendThread(
    input: ReturnType<typeof threadSendInputSchema.parse>,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new Error('Browser operation aborted');
    await this.ensureUsableSession(signal);

    let threadUrl: string;
    try {
      threadUrl = assertFacebookOrigin(buildMessengerThreadUrl({ baseUrl: this.probe.baseUrl, threadId: input.thread_id }));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The requested Facebook Messenger thread id is invalid.');
      }
      throw error;
    }

    // Once the Enter press is dispatched the message may already be in flight, so any failure
    // from that point on is tagged submit_triggered and must never be reported as unsent.
    let submitTriggered = false;
    try {
      await this.browser.runExclusive(signal, async (page, taskSignal) => {
        await page.goto(threadUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
          signal: taskSignal
        });

        // Verify the page is a recognized thread conversation before typing anything. A page
        // that cannot be recognized as a thread is an upstream error and is never typed into.
        const extractOptions = { limits: MESSENGER_EXTRACT_LIMITS };
        let pageKind = classifyMessengerThreadPage(await page.evaluate(extractMessengerThreadPage, extractOptions));
        const deadline = Date.now() + this.settleTimeoutMs;
        while (pageKind === 'unknown' && Date.now() < deadline && !taskSignal.aborted) {
          await sleepUntilAbort(200, taskSignal);
          if (!taskSignal.aborted) {
            pageKind = classifyMessengerThreadPage(await page.evaluate(extractMessengerThreadPage, extractOptions));
          }
        }
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        if (pageKind !== 'messages') {
          throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Messenger thread could not be verified before sending.');
        }

        // Recognize exactly one contract composer. An absent or ambiguous composer is an
        // upstream error so the message is never typed into an unrecognized page.
        const composer = await page.evaluate(findMessengerComposer, { selector: MESSENGER_COMPOSER_SELECTOR });
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        if (classifyMessengerComposerCount(composer.composerCount) !== 'present') {
          throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Messenger message composer was not recognized.');
        }

        // Focus the composer with the same contract selector, type the rendered message (the message
        // plus the idempotency token bound by renderDeliveredMessage), and submit it with Enter. The
        // focus accepts a signal; keyboard calls have no signal in Playwright 1.64, so each await is
        // guarded by an explicit abort check. The serialized session also races the task against the
        // abort signal, so a cancelled send never completes.
        await page.locator(MESSENGER_COMPOSER_SELECTOR).focus({ signal: taskSignal });
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        await page.keyboard.type(renderDeliveredMessage(input));
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
        submitTriggered = true;
        await page.keyboard.press('Enter');
        if (taskSignal.aborted) throw taskSignal.reason ?? new Error('Browser operation aborted');
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const submitMetadata = submitTriggered ? { submit_triggered: true } : undefined;
      if (error instanceof errors.TimeoutError) {
        // A timeout after the Enter press means the send itself did not complete, not that the
        // page failed to load.
        throw new MarketplaceProviderError(
          'TIMEOUT',
          submitTriggered ? 'The Messenger send did not complete in time.' : 'The Facebook Messenger thread page did not load in time.',
          submitMetadata
        );
      }
      if (error instanceof MarketplaceProviderError) {
        throw submitTriggered
          ? new MarketplaceProviderError(error.code, error.message, { ...error.metadata, submit_triggered: true })
          : error;
      }
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.', submitMetadata);
      }
      this.logger.error('Facebook Messenger send failed:', error instanceof Error ? error.name : 'UnknownError');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook Messenger message could not be sent.', submitMetadata);
    }
  }

  private async ensureUsableSession(signal: AbortSignal): Promise<void> {
    let session: Awaited<ReturnType<FacebookSessionProbe['probeSession']>>;
    try {
      session = await this.probe.probeSession(signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      if (error instanceof MarketplaceProviderError) throw error;
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
    }

    if (session.status === 'session_usable') this.loginGate.recordSuccess(LOGIN_SCOPE);

    // A captcha or checkpoint the probe observed is a challenge only a human can clear, so it
    // hard-opens the shared gate for every scope: the scope that first observes the challenge
    // owns that open, so no request may submit credentials while the challenge stands (issue
    // #144). The probe-only diagnostics run observes the same states, so it arms the gate before
    // it reports the disabled surface.
    if (session.status === 'session_needs_reauth' && session.code !== 'LOGIN_REQUIRED') {
      this.loginGate.recordChallenge(LOGIN_SCOPE);
    }

    if (this.probeOnly) {
      if (session.code) {
        throw new MarketplaceProviderError(session.code, messengerSessionMessage(session.code));
      }
      throw new SurfaceDisabledError('Messenger probe-only diagnostics are enabled; conversation access is disabled.');
    }
    if (session.status === 'session_needs_reauth') {
      const recovery = await this.waitForCredentialLogin(session.code, signal);
      if (!recovery.recovered) {
        const code = recovery.code ?? session.code ?? 'SESSION_INVALID';
        throw new MarketplaceProviderError(code, messengerSessionMessage(code));
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
        throw new MarketplaceProviderError(code, messengerSessionMessage(code));
      }
    }
    if (session.status === 'session_unknown') {
      throw new MarketplaceProviderError('SESSION_INVALID', 'The Facebook session could not be verified, so the request was not attempted.');
    }
  }

  private async waitForCredentialLogin(
    code: FacebookProbeCode | undefined,
    signal: AbortSignal
  ): Promise<{ recovered: boolean; code?: FacebookProbeCode; ownsAttempt?: boolean }> {
    if (!this.login || code !== 'LOGIN_REQUIRED') return { recovered: false };
    if (this.closePromise || this.loginController.signal.aborted) {
      throw this.loginController.signal.reason ?? new Error('Facebook Messenger backend is shutting down');
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
      if (error instanceof MarketplaceProviderError) throw error;
      if (error instanceof BrowserUnavailableError) {
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be verified.');
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
      throw new MarketplaceProviderError('LOGIN_REQUIRED', messengerSessionMessage('LOGIN_REQUIRED'));
    }
    // A lease that took the profile over between the grant and this point ended the attempt's
    // access to it, so the attempt must not start at all: no credential is submitted. A takeover
    // is not a challenge, so the attempt is abandoned and the scope spends no retry budget on it.
    if (this.browser.profileTakeoverSignal.aborted) {
      this.loginGate.settleAttempt(permit, 'abandoned');
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
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
        throw new MarketplaceProviderError('LOGIN_REQUIRED', messengerSessionMessage('LOGIN_REQUIRED'));
      }
      if (error instanceof BrowserUnavailableError) {
        this.loginGate.settleAttempt(permit, 'abandoned');
        throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The browser session is not available.');
      }
      this.loginGate.settleAttempt(permit, 'failure');
      if (error instanceof MarketplaceProviderError) throw error;
      throw new MarketplaceProviderError('UPSTREAM_ERROR', 'The Facebook session could not be established.');
    }
  }
}

function messengerSessionMessage(code: FacebookProbeCode): string {
  const messages = {
    LOGIN_REQUIRED: 'Facebook login is required to read Marketplace conversations.',
    CAPTCHA_REQUIRED: 'Facebook requires a captcha challenge.',
    SESSION_INVALID: 'The Facebook session requires a security check.'
  } as const;
  return messages[code];
}

/**
 * Reads a captured GraphQL response body without ever letting the read hang the tool. A response
 * body that Chromium does not surface in time is skipped rather than awaited forever; a missing
 * observation is a fail-closed upstream error, never fabricated data. The losing promise is
 * settled so it cannot surface as an unhandled rejection. The dispatch counter in the handler
 * separately bounds how many bodies are read, so unrelated same-origin GraphQL traffic cannot
 * inflate the flush.
 */
const GRAPHQL_BODY_READ_TIMEOUT_MS = 2_000;
const GRAPHQL_RESPONSE_READ_LIMIT = 60;
const GRAPHQL_FLUSH_TIMEOUT_MS = 3_000;

async function readResponseBody(response: import('playwright').Response): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.json().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), GRAPHQL_BODY_READ_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Waits for already-dispatched response body reads to settle, bounded by `totalMs`. The reads
 * themselves run concurrently so a queue of stalled Chromium body reads cannot serialize past
 * the navigation and settle budgets. Reads still in flight when the deadline elapses continue
 * to settle in the background; each has its own 2s body-read timeout so the listener and page
 * never hold the exclusive browser session beyond their deadline.
 */
async function waitForReadFlush(pending: Set<Promise<void>>, totalMs: number): Promise<void> {
  if (pending.size === 0) return;
  const deadline = Date.now() + totalMs;
  while (pending.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    try {
      await Promise.race([Promise.allSettled(Array.from(pending)), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType === 'text/json' || mediaType === 'application/graphql+json';
}
