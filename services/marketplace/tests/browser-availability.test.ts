import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => {
  // This file's imports must not touch the shared cross-process cache and must not take the loud-CI
  // path just because the surrounding environment happens to set these.
  process.env.MARKETPLACE_BROWSER_PROBE_CACHE = 'off';
  delete process.env.REQUIRE_BROWSER_TESTS;
  const launch = vi.fn<() => Promise<{ close: () => Promise<void> }>>();
  const executablePath = vi.fn<() => string>();
  launch.mockResolvedValue({ close: async () => undefined });
  // process.execPath always exists, so it stands in for "the main Chromium binary is on disk".
  executablePath.mockReturnValue(process.execPath);
  return { launch, executablePath };
});

vi.mock('playwright', () => ({
  chromium: { launch: probes.launch, executablePath: probes.executablePath },
}));

// The helper probes at module load; with the mocked launch succeeding that import is fast and silent.
const { describeLaunchFailure, probeBrowserAvailability, resolveBrowserAvailability, summarizeLaunchFailure } =
  await import('./helpers/browser-availability.js');

// Realistic Playwright failure shapes (launch error message embedding the process stderr).
function missingSharedLibrariesError(): Error {
  return new Error([
    'browserType.launch: Target page, context or browser has been closed',
    'Browser logs:',
    '<launching> /ms-playwright/chromium_headless_shell-1234/chrome-linux/chrome-headless-shell --disable-field-trial-config',
    '<launched> pid=4321',
    '[pid=4321][err] chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory',
    'Call log:',
  ].join('\n'));
}

// What `chromium.launch()` throws when the headless shell is missing even though the main Chromium
// binary is installed (e.g. `install chromium --no-shell` or a partial download).
function headlessShellMissingError(): Error {
  return new Error([
    "browserType.launch: Executable doesn't exist at /ms-playwright/chromium_headless_shell-1234/chrome-linux/chrome-headless-shell",
    '╔════════════════════════════════════════════════════════════╗',
    '║ Looks like Playwright was just installed or updated.        ║',
    '║ npx playwright install chromium                             ║',
    '╚════════════════════════════════════════════════════════════╝',
  ].join('\n'));
}

const ABSENT_MAIN_BINARY_PATH = '/synthetic/ms-playwright-should-not-exist/chrome-linux/chrome';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  probes.launch.mockReset();
  probes.launch.mockResolvedValue({ close: async () => undefined });
  probes.executablePath.mockReset();
  probes.executablePath.mockReturnValue(process.execPath);
  process.env.MARKETPLACE_BROWSER_PROBE_CACHE = 'off';
  delete process.env.REQUIRE_BROWSER_TESTS;
});

describe('summarizeLaunchFailure', () => {
  it('names the shared-library line embedded in the process stderr', () => {
    expect(summarizeLaunchFailure(missingSharedLibrariesError())).toBe(
      'chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory',
    );
  });

  it('falls back to the last process-stderr line with the pid prefix stripped', () => {
    const error = new Error([
      'browserType.launch: Failed to launch chromium',
      '<launched> pid=9',
      '[pid=9][err] (process:9): GLib-GObject-WARNING',
      '[pid=9][err] chrome-headless-shell: finished with code 1',
    ].join('\n'));
    expect(summarizeLaunchFailure(error)).toBe('chrome-headless-shell: finished with code 1');
  });

  it('uses the first line when no process stderr is present', () => {
    expect(summarizeLaunchFailure(new Error('browserType.launch: something odd\nmore detail')))
      .toBe('browserType.launch: something odd');
  });

  it('handles non-Error thrown values and empty messages', () => {
    expect(summarizeLaunchFailure('boom')).toBe('boom');
    expect(summarizeLaunchFailure(new Error(''))).toBe('unknown launch failure');
  });

  it('truncates overlong summaries to 300 characters with an ellipsis', () => {
    const summary = summarizeLaunchFailure(new Error('x'.repeat(400)));
    expect(summary).toHaveLength(301);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('describeLaunchFailure', () => {
  it('attributes the failure to the summary, not to the main binary, when libraries are missing', () => {
    const reason = describeLaunchFailure(
      'chrome-headless-shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory',
    );
    expect(reason).toContain('npx playwright install-deps chromium');
    expect(reason.toLowerCase()).not.toContain('binary exists at');
  });
});

describe('probeBrowserAvailability', () => {
  it('reports available when a headless launch succeeds', async () => {
    await expect(probeBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
  });

  it('closes a successful probe launch best-effort', async () => {
    const close = vi.fn(async () => {
      throw new Error('close raced a crash');
    });
    probes.launch.mockResolvedValue({ close });
    await expect(probeBrowserAvailability()).resolves.toEqual({ available: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('suggests install-deps only for missing shared libraries, without blaming the main binary', async () => {
    probes.launch.mockRejectedValue(missingSharedLibrariesError());
    const result = await probeBrowserAvailability();
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('libglib-2.0.so.0');
    expect(result.reason).toContain('npx playwright install-deps chromium');
    expect(result.reason).not.toContain('not installed');
    expect(result.reason.toLowerCase()).not.toContain('binary exists at');
  });

  it('suggests playwright install, not install-deps, when only the headless shell is missing', async () => {
    // Main Chromium binary present (process.execPath), headless shell absent.
    probes.launch.mockRejectedValue(headlessShellMissingError());
    const result = await probeBrowserAvailability();
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain("Executable doesn't exist");
    expect(result.reason).toContain('npx playwright install chromium');
    expect(result.reason).not.toContain('install-deps');
  });

  it('keeps the not-installed hint when the main binary is absent and the failure is unclassified', async () => {
    probes.executablePath.mockReturnValue(ABSENT_MAIN_BINARY_PATH);
    probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
    const result = await probeBrowserAvailability();
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('Chromium is not installed');
    expect(result.reason).toContain('npx playwright install chromium');
    expect(result.reason).not.toContain('install-deps');
  });

  it('reports an unclassified failure against the existing main binary without a wrong fix', async () => {
    probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
    const result = await probeBrowserAvailability();
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('headless launch probe failed');
    expect(result.reason).toContain('some unclassified failure');
    expect(result.reason).not.toContain('install-deps');
  });
});

describe('module-load gate', () => {
  it('throws at module load under REQUIRE_BROWSER_TESTS=1, quoting the reason', async () => {
    process.env.REQUIRE_BROWSER_TESTS = '1';
    probes.executablePath.mockReturnValue(ABSENT_MAIN_BINARY_PATH);
    probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
    await expect(import('./helpers/browser-availability.js')).rejects.toThrow(
      /REQUIRE_BROWSER_TESTS=1[\s\S]*Chromium is not installed[\s\S]*npx playwright install chromium/,
    );
  });

  it('keeps browser tests enabled under REQUIRE_BROWSER_TESTS=1 when the launch probe succeeds', async () => {
    process.env.REQUIRE_BROWSER_TESTS = '1';
    const module = await import('./helpers/browser-availability.js');
    expect(module.browserAvailable).toBe(true);
  });

  it('exports browserAvailable=false and writes the skip reason to raw stderr without the requirement', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write');
    spy.mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    probes.executablePath.mockReturnValue(ABSENT_MAIN_BINARY_PATH);
    probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
    const module = await import('./helpers/browser-availability.js');
    expect(module.browserAvailable).toBe(false);
    expect(written.join('')).toContain('[marketplace-tests] Skipping browser-dependent tests:');
    expect(written.join('')).toContain('some unclassified failure');
  });

  it('throws under REQUIRE_BROWSER_TESTS=1 in every importing file, including from the cached result', async () => {
    // The loud CI failure must not depend on paying for a probe in each file: the first importing
    // file probes and caches the unavailable result, and later files must throw on the cached entry
    // without launching again.
    const dir = mkdtempSync(join(tmpdir(), 'marketplace-probe-cache-gate-'));
    try {
      process.env.MARKETPLACE_BROWSER_PROBE_CACHE = join(dir, 'gate-cache.json');
      process.env.REQUIRE_BROWSER_TESTS = '1';
      probes.executablePath.mockReturnValue(ABSENT_MAIN_BINARY_PATH);
      probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
      await expect(import('./helpers/browser-availability.js')).rejects.toThrow(/REQUIRE_BROWSER_TESTS=1/);
      vi.resetModules();
      await expect(import('./helpers/browser-availability.js')).rejects.toThrow(/REQUIRE_BROWSER_TESTS=1/);
      expect(probes.launch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveBrowserAvailability shared probe cache', () => {
  const cacheDirs: string[] = [];

  afterEach(() => {
    while (cacheDirs.length > 0) {
      const dir = cacheDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshCachePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'marketplace-probe-cache-test-'));
    cacheDirs.push(dir);
    return join(dir, 'probe-cache.json');
  }

  it('reuses one probe result across call sites within the TTL', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
    expect(readFileSync(cachePath, 'utf8')).toContain('"available":true');
  });

  it('reuses the unavailable reason from the cache too', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    probes.executablePath.mockReturnValue(ABSENT_MAIN_BINARY_PATH);
    probes.launch.mockRejectedValue(new Error('browserType.launch: some unclassified failure'));
    const first = await resolveBrowserAvailability();
    const second = await resolveBrowserAvailability();
    expect(first).toEqual(second);
    expect(probes.launch).toHaveBeenCalledTimes(1);
    if (first.available) throw new Error('unreachable');
    expect(second.available).toBe(false);
  });

  it('probes live again once the cached unavailable entry is stale, without inheriting its reason', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      checkedAtMs: Date.now() - 31_000,
      available: false,
      reason: 'Chromium is not installed (stale); run "npx playwright install chromium"',
    }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
    expect(readFileSync(cachePath, 'utf8')).toContain('"available":true');
  });

  it('probes live when the cached entry is future-dated (corrected clock)', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: Date.now() + 3_600_000, available: true }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
  });

  it('probes live when a cached unavailable entry is future-dated', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      checkedAtMs: Date.now() + 3_600_000,
      available: false,
      reason: 'future-dated skip',
    }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
  });

  it('keeps an available entry fresh past the short unavailable TTL', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: Date.now() - 20_000, available: true }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).not.toHaveBeenCalled();
  });

  it('expires a cached unavailable verdict quickly so a post-fix re-run probes live', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      checkedAtMs: Date.now() - 6_000,
      available: false,
      reason: 'stale skip from before the environment fix',
    }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
    expect(readFileSync(cachePath, 'utf8')).toContain('"available":true');
  });

  it('still reuses an unavailable entry inside its short TTL', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, JSON.stringify({
      checkedAtMs: Date.now() - 1_000,
      available: false,
      reason: 'fresh skip',
    }));
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: false, reason: 'fresh skip' });
    expect(probes.launch).not.toHaveBeenCalled();
  });

  // Mode bits and the uid trust check are POSIX-only; skip both on platforms without process.getuid.
  const posix = typeof process.getuid === 'function';

  it.runIf(posix)('writes the cache file mode 0600 so no other user can read or race it', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    await resolveBrowserAvailability();
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('ignores a shared cache file owned by another uid, even at an explicit path', async () => {
    // A planted "available" entry in a world-writable MARKETPLACE_BROWSER_PROBE_CACHE location must
    // not pin the verdict: the file fails the ownership check, so the module pays a live probe.
    const cachePath = freshCachePath();
    writeFileSync(cachePath, JSON.stringify({ checkedAtMs: Date.now(), available: true }));
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    const otherUid = (process.getuid?.() ?? 0) + 1;
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const originalStatSync = actual.statSync;
      const statSyncMock = ((...args: Parameters<typeof originalStatSync>) => {
        if (String(args[0]) === cachePath) {
          return { uid: otherUid } as unknown as ReturnType<typeof originalStatSync>;
        }
        return originalStatSync(...(args as [never, never]));
      }) as unknown as typeof actual.statSync;
      return { ...actual, statSync: statSyncMock };
    });
    try {
      const module = await import('./helpers/browser-availability.js');
      expect(module.browserAvailable).toBe(true); // from the live probe, not the planted entry
      expect(probes.launch).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('falls back to a live probe on a corrupt cache file and rewrites it', async () => {
    const cachePath = freshCachePath();
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = cachePath;
    writeFileSync(cachePath, 'not json at all');
    await expect(resolveBrowserAvailability()).resolves.toEqual({ available: true });
    expect(probes.launch).toHaveBeenCalledTimes(1);
    expect(readFileSync(cachePath, 'utf8')).toContain('"available":true');
  });

  it('probes on every call when the cache is switched off', async () => {
    process.env.MARKETPLACE_BROWSER_PROBE_CACHE = 'off';
    await resolveBrowserAvailability();
    await resolveBrowserAvailability();
    expect(probes.launch).toHaveBeenCalledTimes(2);
  });
});
