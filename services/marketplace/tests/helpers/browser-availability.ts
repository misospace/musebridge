import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * One shared availability gate for every browser-dependent test file. `existsSync(chromium.executablePath())`
 * only proves the Playwright Chromium binary was downloaded; it does not prove the binary can launch. A
 * container that ran `npx playwright install chromium` without the system libraries passes such a gate and
 * then fails every browser test on the same loader error (for example
 * `chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0`), which reads like a code
 * regression. This helper instead attempts one real headless launch — the same binary the tests launch, once
 * per importing test file (vitest evaluates modules per test file) — and exports the outcome, so an
 * unlaunchable browser skips browser tests with an explicit reason naming the launch failure.
 * `REQUIRE_BROWSER_TESTS=1` (set by CI) turns any unavailable outcome into a loud module-load
 * failure instead of a skip.
 */
export type BrowserAvailability =
  | { available: true }
  | { available: false; reason: string };

function summarizeLaunchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  // Playwright's launch failure embeds the process stderr as `[pid=N][err] ...` lines below the
  // launch command; the root cause (e.g. the missing shared library) lives there, not in the first line.
  const stripPid = (line: string): string => line.replace(/^\[pid=\d+\]\[err\]\s*/, '');
  const candidate =
    lines.find((line) => line.includes('error while loading shared libraries'))
    ?? [...lines].reverse().find((line) => line.startsWith('[pid=') && line.includes('][err]'));
  const summary = candidate ? stripPid(candidate) : (lines[0] || message || 'unknown launch failure');
  return summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
}

export async function probeBrowserAvailability(): Promise<BrowserAvailability> {
  try {
    const browser = await chromium.launch({ timeout: 30_000 });
    try {
      await browser.close();
    } catch {
      // Close is best-effort; a successful launch already proved the binary is launchable.
    }
    return { available: true };
  } catch (error) {
    const summary = summarizeLaunchFailure(error);
    // Attempt the launch first: a headless launch runs the chromium headless shell, not the main Chromium
    // binary, so a file-existence check on executablePath() alone would misreport a shell-only install
    // (npx playwright install chromium --only-shell) as unavailable.
    const executablePath = chromium.executablePath();
    const reason = existsSync(executablePath)
      ? `the Chromium binary exists at ${executablePath} but failed to launch: ${summary}. `
        + 'Missing system libraries? Try "npx playwright install-deps chromium" (or apt-get install the missing shared libraries)'
      : `Chromium is not installed (${summary}); run "npx playwright install chromium"`;
    return { available: false, reason };
  }
}

const availability = await probeBrowserAvailability();

export const browserAvailable = availability.available;

if (!availability.available) {
  if (process.env.REQUIRE_BROWSER_TESTS === '1') {
    throw new Error(`Browser tests are required (REQUIRE_BROWSER_TESTS=1), but they cannot run: ${availability.reason}.`);
  }
  // Raw stderr, not console.warn: vitest's default reporter hides intercepted console output from
  // passing files, and the skip reason must be visible in a plain `npm test` run.
  process.stderr.write(`[marketplace-tests] Skipping browser-dependent tests: ${availability.reason}\n`);
}
