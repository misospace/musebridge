import { symlinkSync } from 'node:fs';
import type { TestContext } from 'vitest';

const SYMLINK_PRIVILEGE_ERROR_CODES = new Set(['EPERM', 'EACCES']);

/**
 * Create `path` as a directory symlink to `target`, skipping the test when the platform cannot
 * create symlinks at all (Windows without developer mode or the equivalent privilege). Any other
 * failure is rethrown so a genuine bug is never silently swallowed by a skip.
 */
export function symlinkOrSkip(ctx: TestContext, target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error) {
    if (!SYMLINK_PRIVILEGE_ERROR_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? '')) {
      throw error;
    }
    ctx.skip();
  }
}
