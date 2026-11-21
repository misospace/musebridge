import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

/**
 * One shared availability gate for every browser-dependent test file. `existsSync(chromium.executablePath())`
 * only proves the Playwright Chromium binary was downloaded; it does not prove the binary can launch. A
 * container that ran `npx playwright install chromium` without the system libraries passes such a gate and
 * then fails every browser test on the same loader error (for example
 * `chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0`), which reads like a code
 * regression. This helper instead attempts one real headless launch — the headless shell is what every
 * gated test launches (the headful interactive default in `src/browser.ts` is not exercised by any gated
 * test; if one ever is, this probe must grow a headful launch too) — and exports the outcome, so an
 * unlaunchable browser skips browser tests with an explicit reason naming the launch failure.
 * `REQUIRE_BROWSER_TESTS=1` (set by CI) turns any unavailable outcome into a loud module-load
 * failure instead of a skip.
 *
 * vitest evaluates modules per test file, so a raw probe would launch Chromium once per importing file.
 * The outcome is therefore shared across test-file processes through a short-TTL cache file in the OS
 * temp directory: within the TTL the first probe result is reused, cutting a full suite run from one
 * launch per file to roughly one launch per TTL window. The cache is strictly best-effort — any cache
 * read or write error falls back to a live probe, and a stale cache costs at most one extra launch.
 * Set `MARKETPLACE_BROWSER_PROBE_CACHE` to a path to relocate the cache file or to `off` to disable
 * sharing (this helper's own unit tests use `off`).
 */
export type BrowserAvailability =
  | { available: true }
  | { available: false; reason: string };

const PROBE_CACHE_TTL_MS = 30_000;

export function summarizeLaunchFailure(error: unknown): string {
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

/**
 * Turn a summarized launch failure into the skip reason. The suggested fix must match the actual
 * failure: missing system libraries are the only failure `install-deps` fixes, so a missing headless
 * shell (possible with the main Chromium binary on disk) must not send the reader to `install-deps`,
 * and only a truly missing browser warrants `playwright install chromium`.
 */
export function describeLaunchFailure(summary: string): string {
  if (summary.includes('error while loading shared libraries')) {
    // The summary names the process that could not start (usually `chrome-headless-shell`), so this
    // branch does not attribute the failure to the main Chromium binary.
    return `${summary}. Missing system libraries? Try "npx playwright install-deps chromium" (or apt-get install the missing shared libraries)`;
  }
  if (summary.includes("Executable doesn't exist")) {
    return `the Chromium executable a headless launch needs is missing — ${summary}; run "npx playwright install chromium"`;
  }
  const executablePath = chromium.executablePath();
  if (!existsSync(executablePath)) {
    return `Chromium is not installed (${summary}); run "npx playwright install chromium"`;
  }
  return `the Chromium binary exists at ${executablePath} but the headless launch probe failed: ${summary}`;
}

export async function probeBrowserAvailability(): Promise<BrowserAvailability> {
  try {
    // Attempt the launch first: a headless launch runs the chromium headless shell, not the main Chromium
    // binary, so a file-existence check on executablePath() alone would misreport a shell-only install
    // (npx playwright install chromium --only-shell) as unavailable.
    const browser = await chromium.launch({ timeout: 30_000 });
    try {
      await browser.close();
    } catch {
      // Close is best-effort; a successful launch already proved the binary is launchable.
    }
    return { available: true };
  } catch (error) {
    return { available: false, reason: describeLaunchFailure(summarizeLaunchFailure(error)) };
  }
}

function probeCachePath(): string | undefined {
  const setting = process.env.MARKETPLACE_BROWSER_PROBE_CACHE;
  if (setting === 'off') return undefined;
  if (setting) return setting;
  // Key the shared default by the probed binary's path (which embeds the Playwright browsers root and
  // the browser build revision), so concurrent runs of checkouts pinned to different Playwright builds
  // or browsers paths never inherit each other's verdict.
  const key = createHash('sha256').update(chromium.executablePath()).digest('hex').slice(0, 16);
  return join(tmpdir(), `musebridge-marketplace-browser-availability-${key}.json`);
}

type ProbeCacheEntry = { checkedAtMs: number; available: boolean; reason?: string };

function readProbeCache(path: string): BrowserAvailability | undefined {
  let entry: ProbeCacheEntry | null;
  try {
    entry = JSON.parse(readFileSync(path, 'utf8')) as ProbeCacheEntry | null;
  } catch {
    return undefined; // missing, unreadable, or corrupt cache: probe live.
  }
  const now = Date.now();
  // A future-dated entry (written by an ahead clock that was later corrected) must not stay fresh
  // forever; treat it like a stale entry and probe live.
  if (!entry || typeof entry.checkedAtMs !== 'number' || entry.checkedAtMs > now || now - entry.checkedAtMs > PROBE_CACHE_TTL_MS) {
    return undefined; // malformed, future-dated, or stale: probe live.
  }
  if (entry.available === true) return { available: true };
  if (entry.available === false && typeof entry.reason === 'string') {
    return { available: false, reason: entry.reason };
  }
  return undefined;
}

function writeProbeCache(path: string, availability: BrowserAvailability): void {
  const tempPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const entry: ProbeCacheEntry = { checkedAtMs: Date.now(), ...availability };
    writeFileSync(tempPath, JSON.stringify(entry));
    renameSync(tempPath, path); // atomic swap; concurrent probes from parallel workers simply overwrite.
  } catch {
    // Caching is an optimization; an unwritable cache just means every file pays its own probe.
    try {
      unlinkSync(tempPath);
    } catch {
      // Nothing to clean up if the temp file was never created.
    }
  }
}

export async function resolveBrowserAvailability(): Promise<BrowserAvailability> {
  const cachePath = probeCachePath();
  const cached = cachePath ? readProbeCache(cachePath) : undefined;
  if (cached) return cached;
  const availability = await probeBrowserAvailability();
  if (cachePath) writeProbeCache(cachePath, availability);
  return availability;
}

const availability = await resolveBrowserAvailability();

export const browserAvailable = availability.available;

if (!availability.available) {
  if (process.env.REQUIRE_BROWSER_TESTS === '1') {
    throw new Error(`Browser tests are required (REQUIRE_BROWSER_TESTS=1), but they cannot run: ${availability.reason}.`);
  }
  // Raw stderr, not console.warn: vitest's default reporter hides intercepted console output from
  // passing files, and the skip reason must be visible in a plain `npm test` run.
  process.stderr.write(`[marketplace-tests] Skipping browser-dependent tests: ${availability.reason}\n`);
}
