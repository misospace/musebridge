import { describe, expect, it, vi } from 'vitest';
import { errors } from 'playwright';
import { mapBrowserOperationError } from '../src/browser-error-mapping.js';
import { ProviderError } from '../src/backend.js';
import { BrowserUnavailableError } from '../src/browser.js';

const idleSignal = new AbortController().signal;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected mapBrowserOperationError to throw');
}

describe('mapBrowserOperationError', () => {
  it('re-throws the abort reason before any other classification, even for a timeout', () => {
    const reason = new Error('caller cancelled');
    const signal = AbortSignal.abort(reason);
    const timeout = new errors.TimeoutError();
    expect(() => mapBrowserOperationError(timeout, signal, { timeoutMessage: 'timed out', fallbackMessage: 'fallback' }))
      .toThrow(reason);
    expect(thrown(() => mapBrowserOperationError(timeout, signal, { timeoutMessage: 'timed out', fallbackMessage: 'fallback' })))
      .toBe(reason);
  });

  it('re-throws the original error when the signal is aborted without a reason', () => {
    const signal = { aborted: true } as AbortSignal;
    const failure = new BrowserUnavailableError('launch failed');
    expect(thrown(() => mapBrowserOperationError(failure, signal, { fallbackMessage: 'fallback' }))).toBe(failure);
  });

  it('maps a Playwright timeout to TIMEOUT with the configured message and metadata', () => {
    const error = thrown(() => mapBrowserOperationError(new errors.TimeoutError(), idleSignal, {
      timeoutMessage: 'The page action timed out.',
      fallbackMessage: 'fallback',
      metadata: { submit_triggered: true }
    }));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'The page action timed out.', metadata: { submit_triggered: true } });
  });

  it('lets a timeout fall through to the logged fallback when no timeoutMessage is configured', () => {
    const logger = { error: vi.fn() };
    const error = thrown(() => mapBrowserOperationError(new errors.TimeoutError(), idleSignal, {
      fallbackMessage: 'The browser operation failed.',
      logger,
      logLabel: 'session probe failed:'
    })) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The browser operation failed.');
    expect(logger.error).toHaveBeenCalledWith('session probe failed:', 'TimeoutError');
  });

  it('re-throws a ProviderError as the same instance when no extra metadata is supplied', () => {
    const original = new ProviderError('RATE_LIMITED', 'Nothing there.', { retry_after: 5 });
    expect(thrown(() => mapBrowserOperationError(original, idleSignal, { fallbackMessage: 'fallback' }))).toBe(original);
  });

  it('merges extra metadata into a re-thrown ProviderError, options winning on conflict', () => {
    const original = new ProviderError('RATE_LIMITED', 'Nothing there.', { retry_after: 5, submit_triggered: false });
    const error = thrown(() => mapBrowserOperationError(original, idleSignal, {
      fallbackMessage: 'fallback',
      metadata: { submit_triggered: true, action_required: 're-authenticate manually' }
    })) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBe(original);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.message).toBe('Nothing there.');
    expect(error.metadata).toEqual({ retry_after: 5, submit_triggered: true, action_required: 're-authenticate manually' });
  });

  it('maps BrowserUnavailableError to a static UPSTREAM_ERROR without logging', () => {
    const logger = { error: vi.fn() };
    const error = thrown(() => mapBrowserOperationError(new BrowserUnavailableError('profile locked'), idleSignal, {
      timeoutMessage: 'timed out',
      fallbackMessage: 'The browser operation failed.',
      logger,
      metadata: { submit_triggered: true }
    })) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The browser session is not available.');
    expect(error.metadata).toEqual({ submit_triggered: true });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs the error name and throws the fallback UPSTREAM_ERROR for unknown failures', () => {
    const logger = { error: vi.fn() };
    const failure = new TypeError('unexpected parse failure');
    const error = thrown(() => mapBrowserOperationError(failure, idleSignal, {
      fallbackMessage: 'The browser operation failed.',
      logger,
      logLabel: 'send failed:'
    })) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The browser operation failed.');
    expect(logger.error).toHaveBeenCalledWith('send failed:', 'TypeError');
  });

  it('uses the default log label and UnknownError name for non-Error failures', () => {
    const logger = { error: vi.fn() };
    const error = thrown(() => mapBrowserOperationError('boom', idleSignal, {
      fallbackMessage: 'The browser operation failed.',
      logger
    })) as ProviderError;
    expect(error.code).toBe('UPSTREAM_ERROR');
    expect(error.message).toBe('The browser operation failed.');
    expect(logger.error).toHaveBeenCalledWith('Browser operation failed:', 'UnknownError');
  });
});
