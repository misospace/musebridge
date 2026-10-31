import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { BrowserSessionManager, BrowserSessionOptions } from '../src/browser.js';
import { BrowserSessionManager as BrowserManager, BrowserUnavailableError, canonicalProfileDirIdentity } from '../src/browser.js';
import type { OwnedBrowserTerminationResult } from '../src/browser-process-terminator.js';
import type { MarketplaceBackend } from '../src/backend.js';
import { createMarketplaceService, type MarketplaceService } from '../src/service.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFakePlaywrightHarness } from './helpers/fake-browser-playwright.js';
import { symlinkOrSkip } from './helpers/symlink-or-skip.js';

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.REQUIRE_BROWSER_TESTS === '1') {
  throw new Error('Chromium is required for browser tests at ' + chromium.executablePath());
}

type SyntheticServer = {
  server: Server;
  origin: string;
  requests: string[];
  close(): Promise<void>;
};

let synthetic: SyntheticServer;
const profileDirs: string[] = [];
const managers: BrowserSessionManager[] = [];

beforeAll(async () => {
  synthetic = await startSyntheticServer();
});

afterAll(async () => {
  await synthetic?.close();
});

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  for (const profileDir of profileDirs.splice(0)) rmSync(profileDir, { recursive: true, force: true });
  synthetic.requests.length = 0;
});

describe('browser launch args', () => {
  it('rejects remote debugging arguments with one or two leading dashes', () => {
    for (const argument of ['-remote-debugging-port=0', '--remote-debugging-pipe', '--remote-allow-origins=*']) {
      expect(() => new BrowserManager({ launchArgs: [argument] })).toThrow(TypeError);
    }
  });

  it('does not reuse an interactive launch superseded by closeInteractive', async () => {
    let releaseFirst!: () => void;
    let launchCount = 0;
    let firstContextClosed = false;
    const firstLaunch = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async (_profileDir: string, options: { handleSIGINT?: boolean; handleSIGTERM?: boolean; handleSIGHUP?: boolean }) => {
              expect(options).toMatchObject({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
              launchCount += 1;
              if (launchCount === 1) {
                await firstLaunch;
                return { close: async () => { firstContextClosed = true; }, once: () => undefined, browser: () => null };
              }
              return { close: async () => undefined, once: () => undefined, browser: () => null };
            }
          }
        } as unknown as typeof import('playwright'));
      }
    }({ profileDir: makeProfileDir(), launchTimeoutMs: 100, settleTimeoutMs: 10 });
    managers.push(manager);

    await manager.beginInteractive();
    const staleLaunch = manager.openInteractive({ headless: true });
    await Promise.resolve();
    const closeStartedAt = Date.now();
    await manager.closeInteractive();
    expect(Date.now() - closeStartedAt).toBeGreaterThanOrEqual(80);
    manager.endInteractive();
    await manager.beginInteractive();
    const currentContext = await manager.openInteractive({ headless: true });
    expect(launchCount).toBe(2);

    releaseFirst();
    await expect(staleLaunch).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(firstContextClosed).toBe(true);
    expect(manager.interactiveContext()).toBe(currentContext);
  });

  it('rejects openInteractive after closeInteractive invalidates ownership', async () => {
    let launchCount = 0;
    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async () => {
              launchCount += 1;
              return { close: async () => undefined, once: () => undefined, browser: () => null };
            }
          }
        } as unknown as typeof import('playwright'));
      }
    }({ profileDir: makeProfileDir() });
    managers.push(manager);

    await manager.beginInteractive();
    await manager.closeInteractive();
    await expect(manager.openInteractive({ headless: true })).rejects.toMatchObject({
      name: 'BrowserUnavailableError',
      message: 'Interactive browser launch was superseded'
    });
    expect(launchCount).toBe(0);
  });

  it('enables WebGL and passes only defined proxy variables into interactive Chromium', async () => {
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => { delete process.env[key]; });
    process.env.HTTP_PROXY = 'http://upper-proxy.example:8080';
    process.env.http_proxy = 'http://lower-proxy.example:8080';
    process.env.NO_PROXY = 'localhost';
    let launchEnvironment: NodeJS.ProcessEnv | undefined;
    let launchArgs: string[] | undefined;
    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async (_profileDir: string, options: { args?: string[]; env?: NodeJS.ProcessEnv }) => {
              launchArgs = options.args;
              launchEnvironment = options.env;
              return { close: async () => undefined, once: () => undefined, browser: () => null };
            }
          }
        } as unknown as typeof import('playwright'));
      }
    }({ profileDir: makeProfileDir() });
    managers.push(manager);
    try {
      await manager.beginInteractive();
      await manager.openInteractive({ display: ':7' });
      expect(launchArgs).toContain('--enable-webgl');
      expect(launchEnvironment).toMatchObject({
        DISPLAY: ':7',
        HTTP_PROXY: 'http://upper-proxy.example:8080',
        http_proxy: 'http://lower-proxy.example:8080',
        NO_PROXY: 'localhost'
      });
      expect(launchEnvironment).not.toHaveProperty('HTTPS_PROXY');
      expect(launchEnvironment).not.toHaveProperty('https_proxy');
      expect(launchEnvironment).not.toHaveProperty('no_proxy');
    } finally {
      await manager.close();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reports renderer exits without logging target URLs or identifiers', async () => {
    const errors: string[] = [];
    const calls: Array<{ method: string; params?: object }> = [];
    const secretUrl = 'https://facebook.example/two_step?encrypted_context=secret-value';
    const session = new EventEmitter() as EventEmitter & {
      send(method: string, params?: object): Promise<unknown>;
      detach(): Promise<void>;
    };
    session.send = async (method, params) => {
      calls.push({ method, params });
      return {};
    };
    session.detach = async () => undefined;

    const page = new EventEmitter();
    const context = new EventEmitter() as EventEmitter & {
      close(): Promise<void>;
      browser(): { newBrowserCDPSession(): Promise<typeof session> };
      pages(): typeof page[];
    };
    context.close = async () => undefined;
    context.browser = () => ({ newBrowserCDPSession: async () => session });
    context.pages = () => [page];

    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async () => context
          }
        } as unknown as typeof import('playwright'));
      }
    }({ profileDir: makeProfileDir(), logger: { error: (message) => errors.push(String(message)) } });
    managers.push(manager);

    await manager.beginInteractive();
    await manager.openInteractive({ headless: true });
    page.emit('crash');
    session.emit('Target.targetCreated', {
      targetInfo: { targetId: 'sensitive-frame-id', type: 'iframe', url: secretUrl }
    });
    session.emit('Target.targetCrashed', { targetId: 'sensitive-frame-id', status: 'crashed', errorCode: -11 });
    session.emit('Target.targetCrashed', { targetId: 'untracked-target-id', status: 'oom', errorCode: 9 });

    expect(errors).toEqual([
      'Reauth page renderer crashed',
      'Reauth iframe renderer exited; status crashed; code -11'
    ]);
    expect(JSON.stringify(errors)).not.toContain(secretUrl);
    expect(JSON.stringify(errors)).not.toContain('sensitive-frame-id');
    expect(JSON.stringify(errors)).not.toContain('secret-value');

    await manager.close();
    expect(calls).toContainEqual({ method: 'Target.setDiscoverTargets', params: { discover: false } });
  });
});
describe('canonical profile directory identity', () => {
  it('treats a symlink alias of an existing directory as the same identity', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      const real = join(root, 'real');
      mkdirSync(real, { recursive: true });
      const alias = join(root, 'alias');
      symlinkOrSkip(ctx, real, alias);
      expect(canonicalProfileDirIdentity(alias)).toBe(canonicalProfileDirIdentity(real));
      // A chain of aliases is the same directory, not a different one.
      const chained = join(root, 'chained');
      symlinkOrSkip(ctx, alias, chained);
      expect(canonicalProfileDirIdentity(chained)).toBe(canonicalProfileDirIdentity(real));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a dangling symlink as its target even though neither exists yet', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      const target = join(root, 'target');
      const alias = join(root, 'alias');
      symlinkOrSkip(ctx, target, alias);
      expect(canonicalProfileDirIdentity(alias)).toBe(canonicalProfileDirIdentity(target));
      // A differently spelled dangling alias to the same target collapses onto it too.
      const secondAlias = join(root, 'second-alias');
      symlinkOrSkip(ctx, target, secondAlias);
      expect(canonicalProfileDirIdentity(secondAlias)).toBe(canonicalProfileDirIdentity(target));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a missing directory to the real path of its nearest existing ancestor', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      const realParent = join(root, 'real-parent');
      mkdirSync(realParent, { recursive: true });
      const aliasedParent = join(root, 'aliased-parent');
      symlinkOrSkip(ctx, realParent, aliasedParent);
      const sharedChild = 'profile';
      expect(canonicalProfileDirIdentity(join(aliasedParent, sharedChild)))
        .toBe(canonicalProfileDirIdentity(join(realParent, sharedChild)));
      // Siblings under the same aliased parent stay distinct identities.
      expect(canonicalProfileDirIdentity(join(aliasedParent, 'a')))
        .not.toBe(canonicalProfileDirIdentity(join(aliasedParent, 'b')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the order of multiple missing components without colliding with their reversed path', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      const realParent = join(root, 'real-parent');
      mkdirSync(realParent, { recursive: true });
      // Two missing components below an existing parent: the identity must reconstruct the
      // configured order, not the walk order reversed twice.
      expect(canonicalProfileDirIdentity(join(realParent, 'x', 'y')))
        .toBe(join(realpathSync(realParent), 'x', 'y'));
      // A deeper suffix keeps the same order all the way down.
      expect(canonicalProfileDirIdentity(join(realParent, 'x', 'y', 'z')))
        .toBe(join(realpathSync(realParent), 'x', 'y', 'z'));
      // A distinct existing directory spelled in reverse order must never collide with it.
      const reversed = join(realParent, 'y', 'x');
      mkdirSync(reversed, { recursive: true });
      expect(canonicalProfileDirIdentity(join(realParent, 'x', 'y')))
        .not.toBe(canonicalProfileDirIdentity(reversed));
      // Same property under an aliased parent, where the dangling-symlink splice is in play.
      const aliasedParent = join(root, 'aliased-parent');
      symlinkOrSkip(ctx, realParent, aliasedParent);
      expect(canonicalProfileDirIdentity(join(aliasedParent, 'x', 'y')))
        .toBe(join(realpathSync(realParent), 'x', 'y'));
      expect(canonicalProfileDirIdentity(join(aliasedParent, 'x', 'y')))
        .not.toBe(canonicalProfileDirIdentity(reversed));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the configured order when the missing suffix spans a spliced dangling symlink', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      // `link` is a dangling symlink to a missing target, so the walk splices it and then keeps
      // collecting missing components on both sides of the splice. The component collected before
      // the splice is the deeper one, so the reconstruction must keep it deepest — a walk that
      // reversed the collected components once more would rebuild this as `y/t` under the root
      // instead of `root/t/y`.
      const linkParent = join(root, 'x');
      mkdirSync(linkParent, { recursive: true });
      const link = join(linkParent, 'link');
      symlinkOrSkip(ctx, join(root, 't'), link);
      expect(canonicalProfileDirIdentity(join(linkParent, 'link', 'y')))
        .toBe(join(realpathSync(root), 't', 'y'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a self-referential symlink', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      // A loop has no canonical identity at all; the filesystem error must propagate so startup
      // fails instead of comparing two unverifiable profiles.
      const loop = join(root, 'loop');
      symlinkOrSkip(ctx, loop, loop);
      expect(() => canonicalProfileDirIdentity(loop)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a dangling alias chain outlives the symlink splice budget', (ctx) => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      // Chain of exactly 40 links: the last one resolves to the dangling target and identity is
      // still established as the target's canonical path.
      const budget = 40;
      const target = join(root, 'target');
      let previous = target;
      for (let i = budget; i >= 1; i -= 1) {
        const link = join(root, `link-${i}`);
        symlinkOrSkip(ctx, previous, link);
        previous = link;
      }
      expect(canonicalProfileDirIdentity(previous)).toBe(canonicalProfileDirIdentity(target));

      // One more link pushes the chain past the splice budget. Long chains must fail closed —
      // never fabricate a noncanonical missing-path identity, which would let two differently
      // spelled long alias chains bypass scope isolation. The kernel's own ELOOP preempts a
      // nested chain on Linux; the splice-budget error guards the cases where it would not.
      symlinkOrSkip(ctx, previous, join(root, 'link-0'));
      expect(() => canonicalProfileDirIdentity(join(root, 'link-0'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a null-byte path', () => {
    expect(() => canonicalProfileDirIdentity(join('root', 'bad\0name'))).toThrow();
  });

  it('keeps distinct directories distinct and normalizes spelling differences', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-profile-identity-'));
    try {
      const one = join(root, 'one');
      mkdirSync(one, { recursive: true });
      mkdirSync(join(root, 'two'), { recursive: true });
      expect(canonicalProfileDirIdentity(one)).not.toBe(canonicalProfileDirIdentity(join(root, 'two')));
      expect(canonicalProfileDirIdentity(one)).toBe(canonicalProfileDirIdentity(`${one}/.`));
      // The not-yet-existing leaf keeps the configured spelling, but the existing prefix is
      // canonicalized — so the identity is the real path of the ancestor plus the leaf, not the
      // raw configured spelling (tmpdir() can itself sit behind a symlink, e.g. macOS /var).
      expect(canonicalProfileDirIdentity(join(root, 'does-not-exist')))
        .toBe(join(realpathSync(root), 'does-not-exist'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('interactive lease ownership', () => {
  it('re-establishes the interactive ownership when a previous begin outlived its lease', async () => {
    const harness = createFakePlaywrightHarness({ settleTimeoutMs: 10, launchTimeoutMs: 1_000 });
    profileDirs.push(harness.profileDir);
    const manager = harness.manager;
    managers.push(manager);

    let releaseGate!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = manager.runExclusive(new AbortController().signal, async () => {
      markStarted();
      await gate;
    });
    await started;
    const headlessContext = harness.contexts[0];
    expect(headlessContext).toBeDefined();

    // The lease ends while its begin is still waiting for the queued headless work.
    const staleBegin = manager.beginInteractive();
    await manager.closeInteractive();
    manager.endInteractive();

    releaseGate();
    await blocked;
    await staleBegin;
    expect(headlessContext?.closed).toBe(false);

    const begin = manager.beginInteractive();
    await begin;
    expect(manager.getInfo().interactive).toBe(true);
    expect(manager.profileTakeoverSignal.aborted).toBe(true);
    expect(headlessContext?.closed).toBe(true);
    await expect(manager.openInteractive({ headless: true })).resolves.toBeDefined();

    manager.endInteractive();
    await manager.closeInteractive();
    await manager.close();
  });
});

describe('last-resort orphan termination', () => {
  interface StubOptions {
    contextClose?: 'clean' | 'hang';
    browserMode?: 'clean' | 'hang' | 'throws' | 'null';
    pageClose?: 'clean' | 'hang';
    newPageMode?: 'clean' | 'hang';
    terminate?: (profileDir: string) => Promise<OwnedBrowserTerminationResult>;
  }

  function createTerminationStub(options: StubOptions): { manager: BrowserSessionManager; profileDir: string; errors: string[] } {
    const profileDir = makeProfileDir();
    const errors: string[] = [];
    const hang = () => new Promise<void>(() => undefined);
    const page = { close: options.pageClose === 'hang' ? hang : async () => undefined };
    const newPage = options.newPageMode === 'hang' ? hang : async () => page;
    const browser = options.browserMode === 'hang'
      ? { close: hang }
      : { close: async () => undefined };
    const context = options.browserMode === 'throws'
      ? { close: options.contextClose === 'hang' ? hang : async () => undefined, once: () => undefined, browser: () => { throw new Error('browser detached'); }, newPage }
      : options.browserMode === 'null'
        ? { close: options.contextClose === 'hang' ? hang : async () => undefined, once: () => undefined, browser: () => null, newPage }
        : { close: options.contextClose === 'hang' ? hang : async () => undefined, once: () => undefined, browser: () => browser, newPage };
    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: { launchPersistentContext: async () => context }
        } as unknown as typeof import('playwright'));
      }
    }({
      profileDir,
      settleTimeoutMs: 20,
      launchTimeoutMs: 100,
      logger: { error: (message) => { errors.push(String(message)); } },
      ...(options.terminate ? { terminateOwnedProcesses: options.terminate } : {})
    });
    managers.push(manager);
    return { manager, profileDir, errors };
  }

  async function startAndClose(stub: { manager: BrowserSessionManager }): Promise<void> {
    await stub.manager.runExclusive(new AbortController().signal, async () => undefined);
    await stub.manager.close();
  }

  it('terminates owned processes once when both graceful closes hang', async () => {
    const calls: string[] = [];
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async (profileDir) => {
        calls.push(profileDir);
        return { platformSupported: true, terminatedPids: [4242], failedPids: [] };
      }
    });
    const startedAt = Date.now();
    await startAndClose(stub);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(calls).toEqual([stub.profileDir]);
    expect(stub.errors).toContain('Terminated 1 orphaned browser process(es) after graceful close failed');
  });

  it('does not terminate when the graceful context close succeeds', async () => {
    let calls = 0;
    const stub = createTerminationStub({
      terminate: async () => { calls += 1; return { platformSupported: true, terminatedPids: [], failedPids: [] }; }
    });
    await startAndClose(stub);
    expect(calls).toBe(0);
    expect(stub.errors).toEqual([]);
  });

  it('does not terminate when the browser fallback close succeeds', async () => {
    let calls = 0;
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'clean',
      terminate: async () => { calls += 1; return { platformSupported: true, terminatedPids: [], failedPids: [] }; }
    });
    await startAndClose(stub);
    expect(calls).toBe(0);
    expect(stub.errors).toContain('Headless browser context did not close within the configured timeout');
  });

  it('terminates when the persistent browser accessor throws', async () => {
    const calls: string[] = [];
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'throws',
      terminate: async (profileDir) => {
        calls.push(profileDir);
        return { platformSupported: true, terminatedPids: [7], failedPids: [] };
      }
    });
    await startAndClose(stub);
    expect(calls).toEqual([stub.profileDir]);
    expect(stub.errors).toContain('Could not access the persistent browser for forced shutdown');
    expect(stub.errors).toContain('Terminated 1 orphaned browser process(es) after graceful close failed');
  });

  it('terminates when the graceful close failed and the browser accessor reports none', async () => {
    const calls: string[] = [];
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'null',
      terminate: async (profileDir) => {
        calls.push(profileDir);
        return { platformSupported: true, terminatedPids: [11], failedPids: [] };
      }
    });
    await startAndClose(stub);
    expect(calls).toEqual([stub.profileDir]);
    expect(stub.errors).toContain('Terminated 1 orphaned browser process(es) after graceful close failed');
  });

  it('reports survived processes without failing close', async () => {
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async () => ({ platformSupported: true, terminatedPids: [5], failedPids: [9, 3] })
    });
    await startAndClose(stub);
    expect(stub.errors).toContain('Owned browser processes survived termination for 2 process(es); the profile lock may persist');
  });

  it('reports a platform without process inspection', async () => {
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async () => ({ platformSupported: false, terminatedPids: [], failedPids: [] })
    });
    await startAndClose(stub);
    expect(stub.errors).toContain('Could not terminate owned browser processes: process inspection is unavailable on this platform');
  });

  it('keeps close bounded when the terminator itself fails', async () => {
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async () => { throw new Error('terminator exploded'); }
    });
    const startedAt = Date.now();
    await startAndClose(stub);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(stub.errors).toContain('Owned browser process termination failed unexpectedly');
  });

  it('keeps close bounded when the injected terminator never settles', async () => {
    const stub = createTerminationStub({
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: () => new Promise<OwnedBrowserTerminationResult>(() => undefined)
    });
    const startedAt = Date.now();
    await startAndClose(stub);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(stub.errors).toContain('Owned browser process termination did not settle within 20 ms; abandoning it without waiting');
  });

  it('escalates an abandoned context whose close hangs to owned-process termination', async () => {
    const calls: string[] = [];
    const stub = createTerminationStub({
      pageClose: 'hang',
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async (profileDir) => {
        calls.push(profileDir);
        return { platformSupported: true, terminatedPids: [4242], failedPids: [] };
      }
    });
    const startedAt = Date.now();
    await stub.manager.runExclusive(new AbortController().signal, async () => undefined);
    expect(stub.manager.getInfo()).toMatchObject({
      status: 'browser_unavailable',
      browserStarted: false,
      reason: 'Browser did not close a page in time'
    });
    await stub.manager.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(calls).toEqual([stub.profileDir]);
    expect(stub.errors).toContain('Abandoned headless browser context did not close within the configured timeout');
    expect(stub.errors).toContain('Persistent browser did not close within the configured timeout');
    expect(stub.errors).toContain('Terminated 1 orphaned browser process(es) after graceful close failed');
  });

  it('escalates the abandoned context from the page-acquisition timeout path', async () => {
    const calls: string[] = [];
    const stub = createTerminationStub({
      newPageMode: 'hang',
      contextClose: 'hang',
      browserMode: 'hang',
      terminate: async (profileDir) => {
        calls.push(profileDir);
        return { platformSupported: true, terminatedPids: [7], failedPids: [] };
      }
    });
    await expect(stub.manager.runExclusive(new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ name: 'BrowserUnavailableError', message: 'Browser did not provide a page in time' });
    await stub.manager.close();
    expect(calls).toEqual([stub.profileDir]);
    expect(stub.errors).toContain('Abandoned headless browser context did not close within the configured timeout');
    expect(stub.errors).toContain('Terminated 1 orphaned browser process(es) after graceful close failed');
  });

  it('does not escalate an abandoned context that closes cleanly', async () => {
    let calls = 0;
    const stub = createTerminationStub({
      pageClose: 'hang',
      terminate: async () => {
        calls += 1;
        return { platformSupported: true, terminatedPids: [], failedPids: [] };
      }
    });
    await stub.manager.runExclusive(new AbortController().signal, async () => undefined);
    await stub.manager.close();
    expect(calls).toBe(0);
    expect(stub.errors).toEqual([]);
  });

  it('ends the abandoned-context escalation at a clean browser fallback close', async () => {
    let calls = 0;
    const stub = createTerminationStub({
      pageClose: 'hang',
      contextClose: 'hang',
      browserMode: 'clean',
      terminate: async () => {
        calls += 1;
        return { platformSupported: true, terminatedPids: [], failedPids: [] };
      }
    });
    await stub.manager.runExclusive(new AbortController().signal, async () => undefined);
    await stub.manager.close();
    expect(calls).toBe(0);
    expect(stub.errors).toContain('Abandoned headless browser context did not close within the configured timeout');
  });

  it('relaunches on the next operation after an abandoned-context termination', async () => {
    const profileDir = makeProfileDir();
    let launches = 0;
    let terminateCalls = 0;
    const hang = () => new Promise<void>(() => undefined);
    const manager = new class extends BrowserManager {
      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async () => {
              launches += 1;
              if (launches === 1) {
                return {
                  close: hang,
                  once: () => undefined,
                  browser: () => ({ close: hang }),
                  newPage: async () => ({ close: hang })
                };
              }
              return {
                close: async () => undefined,
                once: () => undefined,
                browser: () => null,
                newPage: async () => ({ close: async () => undefined })
              };
            }
          }
        } as unknown as typeof import('playwright'));
      }
    }({
      profileDir,
      settleTimeoutMs: 20,
      launchTimeoutMs: 100,
      logger: { error: () => undefined },
      terminateOwnedProcesses: async () => {
        terminateCalls += 1;
        return { platformSupported: true, terminatedPids: [3], failedPids: [] };
      }
    });
    managers.push(manager);
    await manager.runExclusive(new AbortController().signal, async () => undefined);
    await manager.runExclusive(new AbortController().signal, async () => undefined);
    expect(launches).toBe(2);
    expect(terminateCalls).toBe(1);
    expect(manager.getInfo()).toMatchObject({ status: 'session_unknown', browserStarted: true });
    await manager.close();
  });
});

describe.skipIf(!browserAvailable)('browser session manager', () => {
  it('bounds close when an interactive context refuses to close', async () => {
    const manager = createManager({ settleTimeoutMs: 200, launchTimeoutMs: 5_000 });
    await manager.beginInteractive();
    const context = await manager.openInteractive({ headless: true });
    const owner = context.browser();
    expect(owner).not.toBeNull();
    context.close = () => new Promise<void>(() => undefined);

    const startedAt = Date.now();
    await manager.closeInteractive();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(manager.interactiveContext()).toBeUndefined();
    expect(manager.getInfo()).toMatchObject({ status: 'session_unknown', interactive: true, browserStarted: false });
    expect(owner?.isConnected()).toBe(false);

    manager.endInteractive();
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto('about:blank');
    })).resolves.toBeUndefined();
  });

  it('terminates an orphaned Chromium holding the profile and reopens it on the next manager', async () => {
    const profileDir = makeProfileDir();
    const errors: string[] = [];
    const manager = makeManager(profileDir, {
      settleTimeoutMs: 300,
      logger: { error: (message) => { errors.push(String(message)); } }
    });
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });
    await manager.runExclusive(new AbortController().signal, async (page) => {
      const context = page.context();
      context.close = () => new Promise<void>(() => undefined);
      const browser = context.browser();
      expect(browser).not.toBeNull();
      browser!.close = () => new Promise<void>(() => undefined);
    });

    const startedAt = Date.now();
    await manager.close();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(errors.some((message) => /Terminated \d+ orphaned browser process\(es\)/.test(message))).toBe(true);

    const reopened = makeManager(profileDir);
    await expect(reopened.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  }, 30_000);

  it('starts lazily and does not navigate before first use', async () => {
    const manager = createManager();
    expect(manager.getInfo().status).toBe('profile_missing');
    expect(synthetic.requests).toEqual([]);

    const title = await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    });

    expect(title).toBe('synthetic');
    expect(manager.getInfo().browserStarted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
    expect(synthetic.requests.filter((pathname) => pathname !== '/favicon.ico')).toEqual(['/']);
  });

  it('reports unexpected browser closure and relaunches on the next operation', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    });

    manager.assessSession('session_usable');
    expect(manager.getInfo().status).toBe('session_usable');
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.context().close();
    });

    expect(manager.getInfo()).toMatchObject({ status: 'browser_unavailable', browserStarted: false });
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
    expect(manager.getInfo().browserStarted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('invalidates an in-flight headless launch when reauth starts', async () => {
    class DelayedLaunchManager extends BrowserManager {
      private launchStarted!: () => void;
      private releaseLaunch!: () => void;
      readonly didStartLaunch = new Promise<void>((resolve) => { this.launchStarted = resolve; });
      readonly launchGate = new Promise<void>((resolve) => { this.releaseLaunch = resolve; });
      contextClosed = false;

      loadPlaywright(): Promise<typeof import('playwright')> {
        return Promise.resolve({
          chromium: {
            launchPersistentContext: async () => {
              this.launchStarted();
              await this.launchGate;
              return { close: async () => { this.contextClosed = true; } };
            }
          }
        } as unknown as typeof import('playwright'));
      }

      finishLaunch(): void {
        this.releaseLaunch();
      }
    }
    const manager = new DelayedLaunchManager({
      profileDir: makeProfileDir(),
      launchTimeoutMs: 1_000,
      settleTimeoutMs: 20,
      logger: { error: () => undefined }
    });
    managers.push(manager);
    const operation = manager.runExclusive(new AbortController().signal, async () => undefined);
    await manager.didStartLaunch;
    const begin = manager.beginInteractive();
    expect(manager.getInfo().interactive).toBe(true);
    manager.finishLaunch();
    await expect(operation).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(begin).resolves.toBeUndefined();
    expect(manager.contextClosed).toBe(true);
    expect(manager.interactiveContext()).toBeUndefined();
    await manager.endInteractive();
  });

  it('takes interactive ownership immediately and releases it for headless work', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });
    manager.assessSession('session_usable');

    await manager.beginInteractive();
    expect(manager.getInfo()).toMatchObject({ status: 'session_unknown', interactive: true, browserStarted: false });
    const startedAt = Date.now();
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined))
      .rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(250);

    await manager.endInteractive();
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  });

  it('persists localStorage and persistent cookies across browser restarts', async () => {
    const profileDir = makeProfileDir();
    const first = makeManager(profileDir);
    await first.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/set-state`);
      await page.waitForFunction(() => localStorage.getItem('marketplace-fixture') === 'persisted');
    });
    await first.close();

    const second = makeManager(profileDir);
    const persisted = await second.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      const localStorageValue = await page.evaluate(() => localStorage.getItem('marketplace-fixture'));
      const cookies = await page.context().cookies(synthetic.origin);
      return { localStorageValue, cookie: cookies.find(({ name }) => name === 'marketplace')?.value };
    });

    expect(persisted).toEqual({ localStorageValue: 'persisted', cookie: 'ok' });
  });

  it('serializes concurrent operations without overlap', async () => {
    const manager = createManager();
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstIsBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstHasStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const first = manager.runExclusive(new AbortController().signal, async () => {
      order.push('a:start');
      firstStarted();
      await firstIsBlocked;
      order.push('a:end');
    });
    await firstHasStarted;
    const second = manager.runExclusive(new AbortController().signal, async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('bounds a hanging page close and releases the mutex after abort', async () => {
    const manager = createManager({ settleTimeoutMs: 200 });
    const controller = new AbortController();
    const startedAt = Date.now();
    const operation = manager.runExclusive(controller.signal, async (page) => {
      page.close = () => new Promise<void>(() => undefined);
      controller.abort(new Error('test cancellation'));
    });

    await expect(operation).rejects.toThrow('test cancellation');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(manager.getInfo()).toMatchObject({ status: 'browser_unavailable', browserStarted: false });
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  });

  it('discards and relaunches after a hanging context page creation', async () => {
    const manager = createManager({ settleTimeoutMs: 200 });
    await manager.runExclusive(new AbortController().signal, async (page) => {
      manager.assessSession('session_usable');
      page.context().newPage = () => new Promise<typeof page>(() => undefined);
    });

    const startedAt = Date.now();
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined))
      .rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(manager.getInfo()).toMatchObject({ status: 'browser_unavailable', browserStarted: false });
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('cancels an in-flight page operation and releases the mutex', async () => {
    const manager = createManager();
    const controller = new AbortController();
    const startedAt = Date.now();
    const operation = manager.runExclusive(controller.signal, async (page, signal) => {
      await page.goto(`${synthetic.origin}/slow`, { timeout: 60_000, signal } as Parameters<typeof page.goto>[1]);
    });
    await waitForRequest('/slow');
    controller.abort(new Error('test cancellation'));

    await expect(operation).rejects.toThrow('test cancellation');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
  });

  it('shuts down promptly and rejects future operations', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });
    const startedAt = Date.now();
    await manager.close();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(manager.getInfo().status).toBe('browser_unavailable');
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(manager.close()).resolves.toBeUndefined();
  });

  it('reports launch failures when the profile path is a regular file', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'marketplace-browser-test-'));
    profileDirs.push(parent);
    const profileFile = join(parent, 'not-a-directory');
    writeFileSync(profileFile, 'synthetic');
    const manager = makeManager(profileFile);

    expect(manager.getInfo().profileExisted).toBe(true);
    expect(manager.getInfo().status).toBe('session_unknown');
    await expect(manager.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(manager.getInfo().status).toBe('browser_unavailable');

    rmSync(profileFile);
    mkdirSync(profileFile);
    await expect(manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
      return page.title();
    })).resolves.toBe('synthetic');
    expect(manager.getInfo().status).toBe('session_unknown');
  });

  it('round-trips provider assessments and rejects invalid values', async () => {
    const manager = createManager();
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.goto(`${synthetic.origin}/`);
    });

    manager.assessSession('session_usable');
    expect(manager.getInfo().status).toBe('session_usable');
    manager.assessSession('session_needs_reauth');
    expect(manager.getInfo().status).toBe('session_needs_reauth');
    expect(() => manager.assessSession('profile_missing' as never)).toThrow(RangeError);
  });

  it('intercepts and records a blocked external navigation', async () => {
    const manager = createManager();
    const seen: string[] = [];
    await manager.runExclusive(new AbortController().signal, async (page) => {
      await page.route('**', (route) => {
        seen.push(route.request().url());
        return route.abort();
      });
      await expect(page.goto('https://www.facebook.com/')).rejects.toThrow();
    });
    expect(seen).toEqual(['https://www.facebook.com/']);
  });

  it('aborts browser work at the service backend deadline and closes the browser on shutdown', async () => {
    const manager = createManager();
    const backend: MarketplaceBackend = {
      name: 'browser-deadline-test',
      search: async (_input, signal) => {
        await manager.runExclusive(signal, async (page) => {
          await page.goto(`${synthetic.origin}/slow`, { timeout: 60_000, signal } as Parameters<typeof page.goto>[1]);
        });
        return [];
      },
      fetch: () => null
    };
    const service = createMarketplaceService({
      host: '127.0.0.1',
      port: 0,
      backend,
      backendTimeoutMs: 500,
      browser: manager
    });
    let client: Client | undefined;
    try {
      await listen(service);
      const address = service.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      client = new Client({ name: 'marketplace-browser-deadline-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
      const result = await client.callTool({ name: 'marketplace_search', arguments: { query: 'synthetic', location: 'test' } });
      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: 'TIMEOUT', message: 'The backend operation exceeded its deadline.' }
      });
      await expect(manager.runExclusive(new AbortController().signal, async (page) => {
        await page.goto(`${synthetic.origin}/`);
        return page.title();
      })).resolves.toBe('synthetic');

      const startedAt = Date.now();
      await service.close();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(service.browser.getInfo().status).toBe('browser_unavailable');
      await expect(service.browser.runExclusive(new AbortController().signal, async () => undefined)).rejects.toBeInstanceOf(BrowserUnavailableError);
    } finally {
      await client?.close().catch(() => undefined);
      await service.close();
    }
  });
});

function createManager(options: BrowserSessionOptions = {}): BrowserSessionManager {
  return makeManager(makeProfileDir(), options);
}

function makeManager(profileDir: string, options: BrowserSessionOptions = {}): BrowserSessionManager {
  // An explicit logger wins: tests that assert on teardown diagnostics need to see them.
  const manager = new BrowserManager({ ...options, profileDir, logger: options.logger ?? { error: () => undefined } });
  managers.push(manager);
  return manager;
}

function makeProfileDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'marketplace-browser-test-'));
  profileDirs.push(parent);
  const profileDir = join(parent, 'profile');
  return profileDir;
}

async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(pathname);
    if (pathname === '/slow') return;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/set-state') {
      response.end('<!doctype html><html><head><title>state</title></head><body><script>localStorage.setItem("marketplace-fixture", "persisted"); document.cookie = "marketplace=ok; path=/; max-age=3600";</script></body></html>');
      return;
    }
    response.end('<!doctype html><html><head><title>synthetic</title></head><body>fixture</body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function waitForRequest(pathname: string): Promise<void> {
  if (synthetic.requests.includes(pathname)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for request ${pathname} after 5000 ms`));
    }, 5_000);
    const poll = setInterval(() => {
      if (synthetic.requests.includes(pathname)) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}

async function listen(service: MarketplaceService): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(service.port, service.host, resolve);
  });
}
