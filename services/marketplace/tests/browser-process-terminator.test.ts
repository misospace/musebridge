import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyOwnedBrowserCommand, terminateOwnedBrowserProcesses } from '../src/browser-process-terminator.js';

const BENIGN_SCRIPT = 'setInterval(() => undefined, 60_000)';
const STUBBORN_SCRIPT = `if (process.env.MARKETPLACE_TEST_READY_FILE) require('fs').writeFileSync(process.env.MARKETPLACE_TEST_READY_FILE, 'ready'); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 60_000)`;
const FAST_OPTIONS = { termGraceMs: 300, killGraceMs: 1_000, pollIntervalMs: 25 };

const spawned: ChildProcess[] = [];
const profileDirs: string[] = [];

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(reapChild));
  for (const dir of profileDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('terminateOwnedBrowserProcesses', () => {
  it('terminates a benign owned main with SIGTERM', async () => {
    const profileDir = makeProfileDir();
    const child = spawnDummy(BENIGN_SCRIPT, [`--user-data-dir=${profileDir}`]);
    await waitForVisibleInProc(child, `--user-data-dir=${profileDir}`);
    expect(child.pid).not.toBeNull();

    const result = await terminateOwnedBrowserProcesses(profileDir);

    expect(result.platformSupported).toBe(true);
    expect(result.terminatedPids).toContain(child.pid);
    expect(result.failedPids).toEqual([]);
    await expectExit(child);
  }, 15_000);

  it('escapes to SIGKILL for a main that ignores SIGTERM', async () => {
    const profileDir = makeProfileDir();
    const readyFile = join(profileDir, 'ready');
    const child = spawnDummy(STUBBORN_SCRIPT, [`--user-data-dir=${profileDir}`], { ...process.env, MARKETPLACE_TEST_READY_FILE: readyFile });
    await waitForVisibleInProc(child, `--user-data-dir=${profileDir}`);
    await waitForFile(readyFile);
    expect(child.pid).not.toBeNull();

    const result = await terminateOwnedBrowserProcesses(profileDir, FAST_OPTIONS);

    expect(result.platformSupported).toBe(true);
    expect(result.terminatedPids).toContain(child.pid);
    expect(result.failedPids).toEqual([]);
    await expectExit(child);
  }, 15_000);

  it('never signals processes that do not own the profile', async () => {
    const profileDir = makeProfileDir();
    const otherProfileDir = makeProfileDir();
    const owned = spawnDummy(BENIGN_SCRIPT, [`--user-data-dir=${profileDir}`]);
    const unrelated = spawnDummy(BENIGN_SCRIPT);
    const otherOwner = spawnDummy(BENIGN_SCRIPT, [`--user-data-dir=${otherProfileDir}`]);
    await waitForVisibleInProc(owned, `--user-data-dir=${profileDir}`);
    await waitForVisibleInProc(unrelated, null);
    await waitForVisibleInProc(otherOwner, `--user-data-dir=${otherProfileDir}`);
    expect(owned.pid).not.toBeNull();
    expect(unrelated.pid).not.toBeNull();
    expect(otherOwner.pid).not.toBeNull();

    const result = await terminateOwnedBrowserProcesses(profileDir);

    expect(result.terminatedPids).toContain(owned.pid);
    expect(result.terminatedPids).not.toContain(unrelated.pid);
    expect(result.terminatedPids).not.toContain(otherOwner.pid);
    expect(isAlive(unrelated.pid!)).toBe(true);
    expect(isAlive(otherOwner.pid!)).toBe(true);
    unrelated.kill('SIGKILL');
    otherOwner.kill('SIGKILL');
    await expectExit(unrelated);
    await expectExit(otherOwner);
    await expectExit(owned);
  }, 15_000);

  it('SIGKILLs a stubborn main and its surviving helper', async () => {
    const profileDir = makeProfileDir();
    const mainReadyFile = join(profileDir, 'ready-main');
    const helperReadyFile = join(profileDir, 'ready-helper');
    const main = spawnDummy(STUBBORN_SCRIPT, [`--user-data-dir=${profileDir}`], { ...process.env, MARKETPLACE_TEST_READY_FILE: mainReadyFile });
    const helper = spawnDummy(STUBBORN_SCRIPT, [`--user-data-dir=${profileDir}`, '--type=renderer'], { ...process.env, MARKETPLACE_TEST_READY_FILE: helperReadyFile });
    await waitForVisibleInProc(main, `--user-data-dir=${profileDir}`);
    await waitForVisibleInProc(helper, `--user-data-dir=${profileDir}`);
    await waitForFile(mainReadyFile);
    await waitForFile(helperReadyFile);
    expect(main.pid).not.toBeNull();
    expect(helper.pid).not.toBeNull();

    const result = await terminateOwnedBrowserProcesses(profileDir, FAST_OPTIONS);

    expect(result.platformSupported).toBe(true);
    expect(result.terminatedPids).toContain(main.pid);
    expect(result.terminatedPids).toContain(helper.pid);
    expect(result.failedPids).toEqual([]);
    await expectExit(main);
    await expectExit(helper);
  }, 15_000);

  it('reports an empty result for a profile no process owns and resolves quickly', async () => {
    const profileDir = makeProfileDir();
    const startedAt = Date.now();

    const result = await terminateOwnedBrowserProcesses(profileDir);

    expect(result).toEqual({ platformSupported: true, terminatedPids: [], failedPids: [] });
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 15_000);

  it('terminates a process whose cmdline names the real dir when given a symlinked profile path', async () => {
    const realDir = makeProfileDir();
    const linkParent = makeProfileDir();
    const linkPath = join(linkParent, 'profile-link');
    symlinkSync(realDir, linkPath);
    const child = spawnDummy(BENIGN_SCRIPT, [`--user-data-dir=${realDir}`]);
    await waitForVisibleInProc(child, `--user-data-dir=${realDir}`);
    expect(child.pid).not.toBeNull();

    const result = await terminateOwnedBrowserProcesses(linkPath, FAST_OPTIONS);

    expect(result.platformSupported).toBe(true);
    expect(result.terminatedPids).toContain(child.pid);
    expect(result.failedPids).toEqual([]);
    await expectExit(child);
  }, 15_000);
});

describe('classifyOwnedBrowserCommand', () => {
  it('separates main, helper, and unowned command lines', () => {
    const main = '/usr/bin/browser\0--user-data-dir=/mine/profile\0--no-sandbox\0';
    expect(classifyOwnedBrowserCommand(main, '/mine/profile')).toBe('main');
    expect(classifyOwnedBrowserCommand('/usr/bin/browser\0--type=renderer\0--user-data-dir=/mine/profile\0', '/mine/profile')).toBe('helper');
    expect(classifyOwnedBrowserCommand('/usr/bin/browser\0--user-data-dir=/other\0', '/mine/profile')).toBe('unowned');
    expect(classifyOwnedBrowserCommand('/usr/bin/browser\0--type=renderer\0--user-data-dir=/other\0', '/mine/profile')).toBe('unowned');
    expect(classifyOwnedBrowserCommand('/usr/bin/browser\0--type=renderer\0', '/mine/profile')).toBe('unowned');
  });

  it('treats trailing-slash and relative forms that resolve to the same directory as owned', () => {
    const commandLine = '/usr/bin/browser\0--user-data-dir=/mine/profile\0';
    expect(classifyOwnedBrowserCommand(commandLine, '/mine/profile/')).toBe('main');
    expect(classifyOwnedBrowserCommand(commandLine, '/mine/../mine/profile')).toBe('main');
    const relative = '/usr/bin/browser\0--user-data-dir=profile-x\0';
    expect(classifyOwnedBrowserCommand(relative, 'profile-x')).toBe('main');
    expect(classifyOwnedBrowserCommand(relative, 'profile-x/')).toBe('main');
  });

  it('does not treat a different directory as owned, even for helpers', () => {
    const commandLine = '/usr/bin/browser\0--user-data-dir=/mine/profile\0';
    expect(classifyOwnedBrowserCommand(commandLine, '/mine/other')).toBe('unowned');
    expect(classifyOwnedBrowserCommand('/usr/bin/browser\0--type=utility\0--user-data-dir=/mine/other\0', '/mine/profile')).toBe('unowned');
  });

  it('resolves a symlinked directory form to the same ownership identity', () => {
    const realDir = makeProfileDir();
    const linkParent = makeProfileDir();
    const linkPath = join(linkParent, 'profile-link');
    symlinkSync(realDir, linkPath);
    const commandLine = `/usr/bin/browser\0--user-data-dir=${realDir}\0`;
    expect(classifyOwnedBrowserCommand(commandLine, linkPath)).toBe('main');
    expect(classifyOwnedBrowserCommand(commandLine, `${linkPath}/`)).toBe('main');
  });
});

function makeProfileDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'marketplace-terminator-test-'));
  profileDirs.push(dir);
  return dir;
}

function spawnDummy(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  // Node parses unknown `--` flags following a -e script as node options and aborts, so the
  // browser-style flags must sit after a `--` separator to reach the cmdline as plain argv.
  const child = spawn(process.execPath, ['-e', script, ...(args.length > 0 ? ['--', ...args] : [])], { stdio: 'ignore', env });
  // A spawn failure would otherwise surface as an unhandled 'error' event outside any test.
  child.on('error', () => undefined);
  spawned.push(child);
  return child;
}

async function waitForVisibleInProc(child: ChildProcess, marker: string | null, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('dummy child exited before it became visible in /proc');
    if (child.pid !== null) {
      try {
        const commandLine = readFileSync(join('/proc', String(child.pid), 'cmdline'), 'utf8');
        if (marker === null || commandLine.includes(marker)) return;
      } catch {
        // The process has not materialized in /proc yet.
      }
    }
    if (Date.now() - startedAt >= timeoutMs) throw new Error('timed out waiting for dummy child to become visible in /proc');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for readiness file ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function expectExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('owned child did not exit in time')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reapChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill('SIGKILL');
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3_000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
}
