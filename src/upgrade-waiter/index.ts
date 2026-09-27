import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { ProcessLiveness } from '../infra/node-process.js';
import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  revalidateUpgradeIntentTarget,
  type UpgradeIntent,
} from '../infra/upgrade-intent.js';
import type { UpgradeWaiterPorts } from '../runtime/upgrade-waiter.js';
import { createIpcClient } from '../transport/ipc/client.js';

const LEASE_MS = 30_000;

/** Names what a contender deferred for; the waiter that claims the intent is what that deferral waited on. */
export const CONTENDER_DEFERRAL_OWNER = 'upgrade-contender';
const POLL_MS = 2_000;

type RetirementObservation = 'serving' | 'retired' | 'unknown';

export type UpgradeWaiterOptions = Readonly<{
  runDir: string;
  socketPath: string;
  targetRoot: string;
  ports: UpgradeWaiterPorts;
  observeRetirement?: (intent: UpgradeIntent) => Promise<RetirementObservation>;
  launchTarget?: (intent: UpgradeIntent, attemptId: string) => Promise<void>;
  validateTarget?: (intent: UpgradeIntent) => boolean;
  pollMs?: number;
  waitForIntentMs?: number;
}>;

export type UpgradeWaiterResult =
  | Readonly<{
      kind: 'completed' | 'closed' | 'superseded' | 'target-unavailable' | 'lease-held' | 'expired';
    }>
  | Readonly<{ kind: 'unobservable'; reason: string }>;

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

/** Without a matching incarnation, only observed PID absence permits release. */
export function observeRecordedProcess(
  ports: Pick<UpgradeWaiterPorts, 'processIncarnation' | 'processLiveness'>,
  recorded: Pick<UpgradeIntent['incumbent'], 'pid' | 'incarnation'>,
): ProcessLiveness {
  const current = recorded.incarnation === null ? null : ports.processIncarnation(recorded.pid);
  if (current !== null) return current === recorded.incarnation ? 'alive' : 'absent';
  return ports.processLiveness(recorded.pid);
}

/** Only ping and health may poll a legacy incumbent; catalog requests renew its idle timer. */
async function observeNaturalRetirement(
  ports: UpgradeWaiterPorts,
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
    if (sameIncumbent(intent, ping)) return 'serving';
    return observeRecordedProcess(ports, intent.incumbent) === 'absent' ? 'serving' : 'unknown';
  } catch {
    if (observeRecordedProcess(ports, intent.incumbent) !== 'absent') return 'unknown';
    if (!ports.pathAbsent(join(runDir, 'coordinator.json'))) return 'unknown';
    return (await socketReleased(socketPath)) ? 'retired' : 'unknown';
  }
}

async function launchInstalledTarget(
  ports: UpgradeWaiterPorts,
  intent: UpgradeIntent,
  attemptId: string,
): Promise<void> {
  const pid = await ports.launchDetached(join(intent.target.pluginRootLabel, 'bridge', 'coral-backend.cjs'), [], {
    CORAL_STARTUP_ATTEMPT_ID: attemptId,
  });
  if (pid === null) throw new Error('Upgrade target process could not be started.');
}

/** An unanswered probe never authorizes retirement or target launch. */
export async function runUpgradeWaiter(options: UpgradeWaiterOptions): Promise<UpgradeWaiterResult> {
  const { ports } = options;
  const now = (): number => ports.time.now();
  const sleep = (ms: number): Promise<void> => ports.time.sleep(ms);
  const observe =
    options.observeRetirement ??
    ((intent: UpgradeIntent) => observeNaturalRetirement(ports, options.runDir, options.socketPath, intent));
  const launch =
    options.launchTarget ??
    ((intent: UpgradeIntent, attemptId: string) => launchInstalledTarget(ports, intent, attemptId));
  const validate =
    options.validateTarget ?? ((intent: UpgradeIntent) => revalidateUpgradeIntentTarget(intent).kind === 'validated');
  const pollMs = options.pollMs ?? POLL_MS;
  const instanceId = ports.uuid();
  const incarnation = ports.processIncarnation(ports.pid);
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
    const child = intent.attemptChild;
    if (
      intent.disposition === 'deferred' &&
      intent.attemptId !== null &&
      child !== null &&
      child !== undefined &&
      child.attemptId === intent.attemptId
    ) {
      if (intent.attemptDeadline === null || Date.parse(intent.attemptDeadline) > now()) {
        return { kind: 'lease-held' };
      }
      if (observeRecordedProcess(ports, child) !== 'absent') return { kind: 'lease-held' };
      const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        attemptId: null,
        attemptOwner: null,
        attemptChild: null,
        attemptDeadline: null,
      });
      if (released.kind === 'conflict') continue;
      if (released.kind !== 'written') return { kind: 'unobservable', reason: released.kind };
      continue;
    }
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
      attemptId = ports.uuid();
    } else if (intent.attemptId !== attemptId || intent.attemptOwner?.instanceId !== instanceId) {
      return { kind: 'superseded' };
    }
    if (launched && deadline <= now()) {
      const recordedChild = intent.attemptChild?.attemptId === attemptId;
      const released = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        disposition: 'deferred',
        blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
        retryCondition: {
          kind: 'incumbent-retirement',
          evidence: 'legacy incumbent retired; successor attempt expired',
        },
        attemptId: recordedChild ? attemptId : null,
        attemptOwner: recordedChild ? intent.attemptOwner : null,
        attemptDeadline: recordedChild ? intent.attemptDeadline : null,
      });
      if (released.kind === 'conflict') continue;
      if (released.kind !== 'written') return { kind: 'unobservable', reason: released.kind };
      return { kind: 'expired' };
    }
    if (intent.attemptOwner?.instanceId !== instanceId || (!launched && deadline - now() < LEASE_MS / 2)) {
      const claimed = await compareAndSwapUpgradeIntent(options.runDir, intent.revision, {
        ...intent,
        blockers: intent.blockers.filter((entry) => entry.owner !== CONTENDER_DEFERRAL_OWNER),
        attemptId,
        attemptOwner: { kind: 'waiter', instanceId, pid: ports.pid, incarnation },
        attemptDeadline: new Date(now() + LEASE_MS).toISOString(),
        retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for verified idle retirement' },
      });
      if (claimed.kind === 'conflict') continue;
      if (claimed.kind !== 'written') return { kind: 'unobservable', reason: claimed.kind };
      await sleep(pollMs);
      continue;
    }
    const retirement = launched ? null : await observe(intent);
    if (retirement === 'retired') {
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
