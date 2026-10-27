import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface OwnedBrowserTerminationResult {
  platformSupported: boolean;
  /** Processes this call signalled and confirmed exited within a grace window. */
  terminatedPids: number[];
  /** Owned processes that were still alive when the sequence ended, or could never be signalled (EPERM). */
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
 * touched. Only an absolute flag value can prove ownership: an empty or relative value is
 * resolved against the scanning process's own working directory, never the target's, so it
 * never matches. Ownership is re-proved immediately before every single signal, so a pid that
 * exited and was recycled in the meantime is never signalled. The whole sequence is bounded:
 * SIGTERM, a grace window, then SIGKILL, then a final grace window; anything still alive, or
 * that could not be signalled at all, is reported, never waited on.
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

  const signalled = new Set<number>();
  const denied = new Set<number>();
  // Mains and helpers are swept in the same wave: a helper that ignores SIGTERM must not be
  // able to outlive a cleanly dying main and stay invisible to the result.
  const termWave = signalOwnedProcesses(procRoot, profileDir, [...initial.mains, ...initial.helpers], 'SIGTERM');
  for (const pid of termWave.signalled) signalled.add(pid);
  for (const pid of termWave.denied) denied.add(pid);

  const stillAlive = await waitForExit(procRoot, [...termWave.signalled], termGraceMs, pollIntervalMs);
  if (stillAlive.length > 0) {
    // The fresh scan adds helper processes the first wave left behind and any process that
    // appeared since; a newly seen main also goes straight to SIGKILL because the SIGTERM
    // grace window has already elapsed for this teardown.
    const rescan = scanOwnedBrowserProcesses(procRoot, profileDir);
    const killWave = [...new Set([...stillAlive, ...rescan.mains, ...rescan.helpers])];
    const killResult = signalOwnedProcesses(procRoot, profileDir, killWave, 'SIGKILL');
    for (const pid of killResult.signalled) signalled.add(pid);
    for (const pid of killResult.denied) denied.add(pid);
    await waitForExit(procRoot, [...killResult.signalled], killGraceMs, pollIntervalMs);
  }

  // Honest final accounting: every owned process that is still alive after the sequence is
  // reported as a failure, and a process that exited on its own is never reported as one.
  // A clean-looking result therefore never hides a process that ignored every signal.
  const finalScan = scanOwnedBrowserProcesses(procRoot, profileDir);
  const failed = new Set<number>();
  for (const pid of [...finalScan.mains, ...finalScan.helpers]) {
    if (isProcessAlive(procRoot, pid)) failed.add(pid);
  }
  for (const pid of [...signalled, ...denied]) {
    if (isProcessAlive(procRoot, pid)) failed.add(pid);
  }
  const failedPids = [...failed].sort((left, right) => left - right);
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
  let profileValue: string | undefined;
  let isHelper = false;
  for (const argument of commandLine.split('\0')) {
    if (argument.startsWith('--user-data-dir=')) {
      // Chromium keeps the last occurrence of a repeated switch, so ownership must be judged
      // by that value alone: a process whose final value names another profile is not ours.
      profileValue = argument.slice('--user-data-dir='.length);
    } else if (argument.startsWith('--type=')) {
      isHelper = true;
    }
  }
  if (profileValue === undefined) return 'unowned';
  // An empty or relative value could only be resolved against this process's own working
  // directory, which says nothing about the target's, so it never proves ownership.
  if (!profileValue.startsWith('/')) return 'unowned';
  if (!pathsReferToSameDirectory(profileValue, profileDir)) return 'unowned';
  return isHelper ? 'helper' : 'main';
}

function provesProfileOwnership(procRoot: string, pid: number, profileDir: string): boolean {
  try {
    return classifyOwnedBrowserCommand(readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8'), profileDir) !== 'unowned';
  } catch {
    return false;
  }
}

/**
 * Signals only the processes that still prove ownership of this profile at the moment of the
 * signal. A pid taken from an earlier scan may have exited and been recycled by an unrelated
 * process in the meantime, so ownership is re-read immediately before every single signal.
 */
function signalOwnedProcesses(
  procRoot: string,
  profileDir: string,
  pids: number[],
  signal: NodeJS.Signals
): { signalled: number[]; denied: number[] } {
  const signalled: number[] = [];
  const denied: number[] = [];
  for (const pid of pids) {
    if (!provesProfileOwnership(procRoot, pid, profileDir)) continue;
    try {
      process.kill(pid, signal);
      signalled.push(pid);
    } catch (error) {
      // ESRCH: the process already exited on its own, which is the outcome we wanted.
      // Anything else (EPERM included) means the signal never landed: report, do not assume.
      if (!isNotFound(error)) denied.push(pid);
    }
  }
  return { signalled, denied };
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
