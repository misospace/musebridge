import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface OwnedBrowserTerminationResult {
  platformSupported: boolean;
  terminatedPids: number[];
  failedPids: number[];
}

export interface OwnedBrowserTerminatorOptions {
  termGraceMs?: number;
  killGraceMs?: number;
  pollIntervalMs?: number;
  procRoot?: string;
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * Last-resort cleanup for a persistent-context browser that survived both graceful teardown
 * paths. Ownership proof is the process itself: only processes whose own command line passes
 * `--user-data-dir=<this profile>` are ever signalled, so unrelated processes are never
 * touched. The whole sequence is bounded: SIGTERM, a grace window, then SIGKILL, then a final
 * grace window; anything still alive is reported, never waited on forever.
 */
export async function terminateOwnedBrowserProcesses(
  profileDir: string,
  options: OwnedBrowserTerminatorOptions = {}
): Promise<OwnedBrowserTerminationResult> {
  if (process.platform !== 'linux') {
    return { platformSupported: false, terminatedPids: [], failedPids: [] };
  }
  const termGraceMs = positiveInteger(options.termGraceMs ?? DEFAULT_TERM_GRACE_MS, 'termGraceMs');
  const killGraceMs = positiveInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, 'killGraceMs');
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
  const procRoot = options.procRoot ?? '/proc';

  const initial = scanOwnedBrowserProcesses(procRoot, profileDir);
  if (initial.mains.length === 0 && initial.helpers.length === 0) {
    return { platformSupported: true, terminatedPids: [], failedPids: [] };
  }

  const signalled = new Set<number>(signalProcesses(initial.mains, 'SIGTERM'));
  let stillAlive = await waitForExit(procRoot, [...signalled], termGraceMs, pollIntervalMs);
  if (stillAlive.length > 0) {
    // The second scan catches helper processes the first wave left behind; helpers only ever
    // exist under a main process that already declared this profile, so they stay inside the
    // ownership proof.
    const rescan = scanOwnedBrowserProcesses(procRoot, profileDir);
    const killWave = [...new Set([...stillAlive, ...rescan.mains, ...rescan.helpers])];
    for (const pid of killWave) signalled.add(pid);
    signalProcesses(killWave, 'SIGKILL');
    stillAlive = await waitForExit(procRoot, [...signalled], killGraceMs, pollIntervalMs);
  }

  const failedPids = [...new Set(stillAlive)];
  const failedSet = new Set(failedPids);
  const terminatedPids = [...signalled].filter((pid) => !failedSet.has(pid)).sort((left, right) => left - right);
  return { platformSupported: true, terminatedPids, failedPids };
}

function scanOwnedBrowserProcesses(
  procRoot: string,
  profileDir: string
): { mains: number[]; helpers: number[] } {
  const mains: number[] = [];
  const helpers: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return { mains, helpers };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let commandLine: string;
    try {
      commandLine = readFileSync(join(procRoot, entry, 'cmdline'), 'utf8');
    } catch {
      // The process exited or its attributes became unreadable between listing and reading.
      continue;
    }
    const classification = classifyOwnedBrowserCommand(commandLine, profileDir);
    if (classification === 'main') mains.push(pid);
    else if (classification === 'helper') helpers.push(pid);
  }
  return { mains, helpers };
}

export function classifyOwnedBrowserCommand(
  commandLine: string,
  profileDir: string
): 'main' | 'helper' | 'unowned' {
  let ownsProfile = false;
  let isHelper = false;
  for (const argument of commandLine.split('\0')) {
    if (argument.startsWith('--user-data-dir=')) {
      if (pathsReferToSameDirectory(argument.slice('--user-data-dir='.length), profileDir)) ownsProfile = true;
    } else if (argument.startsWith('--type=')) {
      isHelper = true;
    }
  }
  if (!ownsProfile) return 'unowned';
  return isHelper ? 'helper' : 'main';
}

function signalProcesses(pids: number[], signal: NodeJS.Signals): number[] {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch (error) {
      if (!isNotFound(error)) signalled.push(pid);
      // ESRCH: the process already exited on its own, which is the outcome we wanted.
    }
  }
  return signalled;
}

async function waitForExit(
  procRoot: string,
  pids: number[],
  timeoutMs: number,
  pollIntervalMs: number
): Promise<number[]> {
  let remaining = pids.filter((pid) => isProcessAlive(procRoot, pid));
  const deadline = Date.now() + timeoutMs;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resleep) => setTimeout(resleep, pollIntervalMs));
    remaining = remaining.filter((pid) => isProcessAlive(procRoot, pid));
  }
  return remaining;
}

function isProcessAlive(procRoot: string, pid: number): boolean {
  let stat: string;
  try {
    // A killed process that its parent has not reaped yet is a zombie: it no longer holds the
    // profile lock, so it counts as exited even though its pid still exists. The comm field is
    // parenthesized and may contain spaces or ')', so the state field starts after the last ')'.
    stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return false;
  }
  const stateStart = stat.lastIndexOf(')');
  if (stateStart === -1) return true;
  return stat.charAt(stateStart + 2).trim() !== 'Z';
}

function pathsReferToSameDirectory(left: string, right: string): boolean {
  const normalizedLeft = normalizeDirectoryPath(left);
  const normalizedRight = normalizeDirectoryPath(right);
  if (normalizedLeft === normalizedRight) return true;
  return realpathOrSelf(normalizedLeft) === realpathOrSelf(normalizedRight);
}

function normalizeDirectoryPath(candidate: string): string {
  const resolved = resolve(candidate);
  return resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;
}

function realpathOrSelf(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
