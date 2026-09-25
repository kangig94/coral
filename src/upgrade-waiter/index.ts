import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { observeProcessLiveness, probeProcessIncarnation } from '../infra/node-process.js';
import { UPGRADE_WAITER_BUNDLE_FILE } from '../infra/bundle-manifest-address.js';
import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
} from '../infra/upgrade-intent.js';
import { createIpcClient } from '../transport/ipc/client.js';

const LEASE_MS = 30_000;
const POLL_MS = 2_000;

type RetirementObservation = 'serving' | 'retired' | 'unknown';

export type UpgradeWaiterOptions = Readonly<{
  runDir: string;
  socketPath: string;
  targetRoot: string;
  observeRetirement?: (intent: UpgradeIntent) => Promise<RetirementObservation>;
  launchTarget?: (intent: UpgradeIntent, attemptId: string) => Promise<void>;
  validateTarget?: (intent: UpgradeIntent) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitForIntentMs?: number;
}>;

export type UpgradeWaiterResult =
  | Readonly<{ kind: 'completed' | 'closed' | 'superseded' | 'target-unavailable' | 'lease-held' | 'expired' }>
  | Readonly<{ kind: 'unobservable'; reason: string }>;

export type UpgradeWaiterStart =
  | Readonly<{ kind: 'started' | 'existing'; pid: number }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

/** The contender must observe a durable waiter owner before it exits. */
export async function startUpgradeWaiter(
  options: Readonly<{
    runDir: string;
    socketPath: string;
    targetRoot: string;
    timeoutMs?: number;
  }>,
): Promise<UpgradeWaiterStart> {
  const observed = readUpgradeIntent(options.runDir);
  if (observed.kind !== 'readable') return { kind: 'unavailable', reason: `intent is ${observed.kind}` };
  if (observed.intent.target.pluginRootLabel !== options.targetRoot) {
    return { kind: 'unavailable', reason: 'intent target changed' };
  }
  if (observed.intent.disposition === 'completed' || observed.intent.disposition === 'closed') {
    return { kind: 'unavailable', reason: 'intent has ended' };
  }
  const owner = observed.intent.attemptOwner;
  if (
    owner?.kind === 'waiter' &&
    observed.intent.attemptDeadline !== null &&
    Date.parse(observed.intent.attemptDeadline) > Date.now()
  ) {
    return waiterAlive(owner)
      ? { kind: 'existing', pid: owner.pid }
      : { kind: 'unavailable', reason: 'recorded waiter died before its lease expired' };
  }
  const entryPoint = join(options.targetRoot, 'bridge', UPGRADE_WAITER_BUNDLE_FILE);
  const child = spawn(process.execPath, [entryPoint, options.runDir, options.socketPath, options.targetRoot], {
    detached: true,
    stdio: 'ignore',
  });
  const started = await new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('spawn', () => resolve(true));
  });
  if (!started || child.pid === undefined) return { kind: 'unavailable', reason: 'waiter process could not start' };
  child.unref();
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const current = readUpgradeIntent(options.runDir);
    if (current.kind !== 'readable') return { kind: 'unavailable', reason: `intent is ${current.kind}` };
    if (current.intent.requestId !== observed.intent.requestId) {
      return { kind: 'unavailable', reason: 'intent was superseded' };
    }
    const claimant = current.intent.attemptOwner;
    if (claimant?.kind === 'waiter' && claimant.pid === child.pid) return { kind: 'started', pid: child.pid };
    if (
      claimant?.kind === 'waiter' &&
      current.intent.attemptDeadline !== null &&
      Date.parse(current.intent.attemptDeadline) > Date.now() &&
      waiterAlive(claimant)
    ) {
      return { kind: 'existing', pid: claimant.pid };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return { kind: 'unavailable', reason: 'waiter did not claim the intent before the startup deadline' };
}

function sameIncumbent(
  intent: UpgradeIntent,
  ping: { instanceId: string; pid: number; incarnation?: string },
): boolean {
  return (
    ping.instanceId === intent.incumbent.instanceId &&
    ping.pid === intent.incumbent.pid &&
    (intent.incumbent.incarnation === null || ping.incarnation === intent.incumbent.incarnation)
  );
}

function waiterAlive(owner: NonNullable<UpgradeIntent['attemptOwner']>): boolean {
  if (owner.incarnation === null) return false;
  try {
    return probeProcessIncarnation(owner.pid) === owner.incarnation;
  } catch {
    return false;
  }
}

function discoveryReleased(runDir: string): boolean {
  try {
    readFileSync(join(runDir, 'coordinator.json'));
    return false;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

function socketReleased(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      resolve(code === 'ENOENT' || code === 'ECONNREFUSED');
    });
  });
}

/** Only ping and health may poll a legacy incumbent; catalog requests renew its idle timer. */
export async function observeNaturalRetirement(
  runDir: string,
  socketPath: string,
  intent: UpgradeIntent,
): Promise<RetirementObservation> {
  try {
    const ping = await createIpcClient(socketPath).ping<{
      instanceId: string;
      pid: number;
      incarnation?: string;
    }>({ timeoutMs: 1_000 });
    return sameIncumbent(intent, ping) ? 'serving' : 'unknown';
  } catch {
    const recorded = intent.incumbent.incarnation;
    const current = recorded === null ? null : probeProcessIncarnation(intent.incumbent.pid);
    const liveness =
      current !== null && recorded !== null
        ? current === recorded
          ? 'alive'
          : 'absent'
        : observeProcessLiveness(intent.incumbent.pid);
    if (liveness !== 'absent') return 'unknown';
    if (!discoveryReleased(runDir)) return 'unknown';
    return (await socketReleased(socketPath)) ? 'retired' : 'unknown';
  }
}

async function launchInstalledTarget(intent: UpgradeIntent, attemptId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(intent.target.pluginRootLabel, 'bridge', 'coral-backend.cjs')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CORAL_STARTUP_ATTEMPT_ID: attemptId },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** An unanswered probe never authorizes retirement or target launch. */
export async function runUpgradeWaiter(options: UpgradeWaiterOptions): Promise<UpgradeWaiterResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const observe =
    options.observeRetirement ??
    ((intent: UpgradeIntent) => observeNaturalRetirement(options.runDir, options.socketPath, intent));
  const launch = options.launchTarget ?? launchInstalledTarget;
  const validate =
    options.validateTarget ?? ((intent: UpgradeIntent) => revalidateUpgradeIntentTarget(intent).kind === 'validated');
  const pollMs = options.pollMs ?? POLL_MS;
  const instanceId = randomUUID();
  const incarnation = probeProcessIncarnation(process.pid);
  const firstDeadline = now() + (options.waitForIntentMs ?? 10_000);
  let requestId: string | null = null;
  let attemptId: string | null = null;
  let launched = false;

  for (;;) {
    const observed = readUpgradeIntent(options.runDir);
    if (observed.kind === 'absent' && requestId === null && now() < firstDeadline) {
      await sleep(pollMs);
      continue;
    }
    if (observed.kind !== 'readable') {
      return {
        kind: 'unobservable',
        reason: observed.kind === 'absent' ? 'upgrade intent was never recorded' : observed.kind,
      };
    }
    const intent = observed.intent;
    if (
      intent.target.pluginRootLabel !== options.targetRoot ||
      (requestId !== null && intent.requestId !== requestId)
    ) {
      if (
        attemptId !== null &&
        intent.attemptId === attemptId &&
        intent.attemptOwner?.instanceId === instanceId &&
        intent.disposition !== 'completed' &&
        intent.disposition !== 'closed'
      ) {
        const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'pending',
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
          retryCondition: { kind: 'target-change', evidence: 'upgrade target was superseded' },
        });
        if (released.kind === 'conflict') continue;
      }
      return { kind: 'superseded' };
    }
    if (intent.disposition === 'completed') return { kind: 'completed' };
    if (intent.disposition === 'closed') {
      if (attemptId !== null && intent.attemptId === attemptId && intent.attemptOwner?.instanceId === instanceId) {
        const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
        });
        if (released.kind === 'conflict') continue;
      }
      return { kind: 'closed' };
    }
    requestId = intent.requestId;
    if (!validate(intent)) {
      if (launched) return { kind: 'target-unavailable' };
      if (attemptId !== null && intent.attemptId === attemptId) {
        const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          blockers: [{ owner: 'target', reason: 'target root no longer validates' }],
          retryCondition: { kind: 'target-change', evidence: 'target root changed or disappeared' },
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
        });
        if (released.kind === 'conflict') continue;
      }
      return { kind: 'target-unavailable' };
    }

    const deadline = intent.attemptDeadline === null ? 0 : Date.parse(intent.attemptDeadline);
    if (attemptId === null) {
      if (intent.attemptOwner !== null && deadline > now()) return { kind: 'lease-held' };
      attemptId = randomUUID();
    } else if (intent.attemptId !== attemptId || intent.attemptOwner?.instanceId !== instanceId) {
      return { kind: 'superseded' };
    }
    if (launched && deadline <= now()) {
      const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        disposition: 'deferred',
        blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
        retryCondition: {
          kind: 'incumbent-retirement',
          evidence: 'legacy incumbent retired; successor attempt expired',
        },
        attemptId: null,
        attemptOwner: null,
        attemptDeadline: null,
      });
      if (released.kind === 'conflict') continue;
      return { kind: 'expired' };
    }
    if (intent.attemptOwner?.instanceId !== instanceId || (!launched && deadline - now() < LEASE_MS / 2)) {
      const claimed = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        attemptId,
        attemptOwner: { kind: 'waiter', instanceId, pid: process.pid, incarnation },
        attemptDeadline: new Date(now() + LEASE_MS).toISOString(),
        retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for verified idle retirement' },
      });
      if (claimed.kind === 'conflict') continue;
      if (claimed.kind !== 'written') return { kind: 'unobservable', reason: claimed.kind };
      await sleep(pollMs);
      continue;
    }
    if (!launched && (await observe(intent)) === 'retired') {
      if (!validate(intent)) continue;
      const claimed = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        disposition: 'attempting',
        retryCondition: null,
      });
      if (claimed.kind === 'conflict') continue;
      if (claimed.kind !== 'written') return { kind: 'unobservable', reason: claimed.kind };
      try {
        await launch(claimed.intent, attemptId);
      } catch {
        const released = await compareAndSwapUpgradeIntent(options.runDir, claimed.intent.revision, {
          ...claimed.intent,
          disposition: 'deferred',
          blockers: [{ owner: 'waiter', reason: 'target process could not be started' }],
          retryCondition: { kind: 'incumbent-retirement', evidence: 'legacy incumbent retired; target spawn failed' },
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
        });
        if (released.kind === 'conflict') continue;
        return { kind: 'unobservable', reason: 'target spawn failed' };
      }
      launched = true;
    }
    await sleep(pollMs);
  }
}
