import { errors } from 'playwright';
import { ProviderError } from './backend.js';
import type { ProviderErrorMetadata } from './domain.js';
import { BrowserUnavailableError } from './browser.js';

export interface BrowserOperationErrorOptions {
  /**
   * Playwright timeout mapped to `TIMEOUT` with this message. Omit it where a timeout carries
   * no distinct meaning (the session-probe paths): a `TimeoutError` then falls through to the
   * fallback exactly as before.
   */
  readonly timeoutMessage?: string;
  /** The typed `UPSTREAM_ERROR` for any other failure. */
  readonly fallbackMessage: string;
  /** When set, an unknown failure's error name is logged under this label before the fallback throw. */
  readonly logger?: Pick<Console, 'error'>;
  readonly logLabel?: string;
  /**
   * Extra metadata carried on mapped failures and merged into a rethrown `ProviderError`
   * (the send path threads `submit_triggered` through every mapped failure so a dispatched
   * submit is never reported as unsent).
   */
  readonly metadata?: ProviderErrorMetadata;
}

/**
 * The shared browser-operation to typed `ProviderError` mapping ladder, in the exact order the
 * backends have always applied it: abort re-throw first, optional Playwright timeout, a
 * `ProviderError` passes through (re-wrapped only when extra metadata is supplied — the classes
 * are disjoint from `BrowserUnavailableError`, so the pass-through check cannot swallow it),
 * browser-unavailable, then a logged fallback. Always throws; a `catch` block delegates here
 * instead of restating the ladder.
 */
export function mapBrowserOperationError(
  error: unknown,
  signal: AbortSignal,
  options: BrowserOperationErrorOptions
): never {
  if (signal.aborted) throw signal.reason ?? error;
  if (options.timeoutMessage !== undefined && error instanceof errors.TimeoutError) {
    throw new ProviderError('TIMEOUT', options.timeoutMessage, options.metadata);
  }
  if (error instanceof ProviderError) {
    if (options.metadata === undefined) throw error;
    throw new ProviderError(error.code, error.message, { ...error.metadata, ...options.metadata });
  }
  if (error instanceof BrowserUnavailableError) {
    throw new ProviderError('UPSTREAM_ERROR', 'The browser session is not available.', options.metadata);
  }
  options.logger?.error(options.logLabel ?? 'Browser operation failed:', error instanceof Error ? error.name : 'UnknownError');
  throw new ProviderError('UPSTREAM_ERROR', options.fallbackMessage, options.metadata);
}
