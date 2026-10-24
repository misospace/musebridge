// setTimeout coerces delays above 2^31-1 ms to 1, so an out-of-range timeout would abort
// every request instantly instead of failing at construction. Reject at the seam instead.
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function validateTimeout(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be a positive integer within the setTimeout range`);
  }
}
