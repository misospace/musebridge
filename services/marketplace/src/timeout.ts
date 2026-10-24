import { ProviderError } from './backend.js';

// setTimeout coerces delays above 2^31-1 ms to 1, so an out-of-range timeout would abort
// every request instantly instead of failing at construction. Reject at the seam instead.
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function validateTimeout(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be a positive integer within the setTimeout range`);
  }
}

/**
 * Runs one provider request under a per-request deadline. Expiry aborts only the request's
 * own controller, and both deadline and caller aborts reject with `ProviderError('TIMEOUT')`;
 * a `deadline exceeded` abort reason selects the timeout message, everything else reports
 * the request as aborted. The caller's own signal is never aborted here.
 */
export async function runWithDeadline<T>(
  signal: AbortSignal,
  timeoutMs: number,
  provider: string,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal.aborted) throw timeoutOrAbort(signal, provider);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), timeoutMs);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => controller.signal.addEventListener('abort', () => reject(timeoutOrAbort(controller.signal, provider)), { once: true }))
    ]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

function timeoutOrAbort(signal: AbortSignal, provider: string): ProviderError {
  return new ProviderError('TIMEOUT', signal.reason instanceof Error && signal.reason.message === 'deadline exceeded' ? `The ${provider} request timed out.` : `The ${provider} request was aborted.`);
}

/**
 * Races `promise` against the caller's abort budget: a caller abort resolves `undefined`
 * (budget spent, no result), while the promise's own rejection propagates.
 */
export function waitForRequestBudget<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (result) => { cleanup(); resolve(result); },
      (error: unknown) => { cleanup(); reject(error); }
    );
  });
}
