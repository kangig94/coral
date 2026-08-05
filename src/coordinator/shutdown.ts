import type { Server, ServerResponse } from 'node:http';
import { formatError } from '../infra/error-format.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import type { IdleTimer } from './live/idle.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ProviderHostLifecycle } from './live/provider-hosts/index.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';
import type { RuntimeComponentRegistry } from './runtime-components/registry.js';
import type { KbDaemonSupervisor } from './live/kb-daemon-supervisor.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error
 */
export type ShutdownMode = 'handoff' | 'hard';

function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

interface ShutdownRuntimeState {
  setLifecycle(state: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped'): void;
  readonly components: RuntimeComponentRegistry;
}

type RunShutdownSequenceContext = {
  reason: string;
  state: LifecycleWiringState;
  teardownRecoveryCoordinator: () => Promise<void>;
  runtimeState: ShutdownRuntimeState;
  idleTimer: IdleTimer;
  closeServerFn: (server: Server) => Promise<void>;
  closeIpcServerFn?: (listener: IpcListener) => Promise<void>;
  waitForInflightDrain: (
    idleTimer: IdleTimer,
    timeoutMs: number,
    time: Pick<Runtime['time'], 'clearInterval' | 'now' | 'setInterval'>,
  ) => Promise<void>;
  server: Server;
  ipcServer?: IpcListener;
  streamResponses: Set<ServerResponse>;
  runtime: Runtime;
  markJobsAsErrorFn: (message: string, signal: AbortSignal) => void | Promise<void>;
  providerHostManager: ProviderHostLifecycle;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: () => void;
  handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  disposeLifecycleReactor: () => void | Promise<void>;
  hooks: { onShutdown(mode: ShutdownMode, signal: AbortSignal): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  log: (message: string) => void;
};

/**
 * Run an async finalizer against the remaining drain budget.
 *
 * The `signal` passed to `task` aborts when the budget timer wins the race.
 * Finalizers must honor it at suspension points: the timeout race makes the
 * shutdown sequence return within budget, while signal cooperation prevents
 * the finalizer from continuing as orphan async work until process exit.
 *
 * The timeout sleep uses `time.sleep(ms, { signal })` and is aborted in
 * `finally` so a finalizer that wins the race leaves no pending timer behind
 * (important for fake-timer test discipline).
 */
async function withBudget<T>(
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
  remainingDrain: () => number,
  time: Pick<TimePort, 'sleep'>,
  log: (message: string) => void,
): Promise<T | undefined> {
  const budget = remainingDrain();
  if (budget <= 0) {
    log(`${label}: skipped (drain budget exhausted)\n`);
    return undefined;
  }
  const timedOut = Symbol('timedOut');
  const taskAbort = new AbortController();
  const timeoutAbort = new AbortController();
  try {
    const result = await Promise.race<T | typeof timedOut>([
      task(taskAbort.signal),
      time.sleep(budget, { signal: timeoutAbort.signal }).then(() => timedOut),
    ]);
    if (result === timedOut) {
      taskAbort.abort();
      log(`${label}: exceeded drain budget after ${budget}ms\n`);
      return undefined;
    }
    return result;
  } finally {
    timeoutAbort.abort();
  }
}

type ShutdownFailure = {
  readonly label: string;
  readonly error: unknown;
};

function recordShutdownFailure(
  failures: ShutdownFailure[],
  label: string,
  error: unknown,
  log: (message: string) => void,
): void {
  failures.push({ label, error });
  log(`${label} failed during shutdown: ${formatError(error)}\n`);
}

async function runShutdownStep(
  failures: ShutdownFailure[],
  label: string,
  task: () => unknown | Promise<unknown>,
  log: (message: string) => void,
): Promise<void> {
  try {
    await task();
  } catch (error: unknown) {
    recordShutdownFailure(failures, label, error, log);
  }
}

function observeShutdownTask(
  failures: ShutdownFailure[],
  label: string,
  task: Promise<void>,
  log: (message: string) => void,
): Promise<void> {
  return task.catch((error: unknown) => {
    recordShutdownFailure(failures, label, error, log);
  });
}

function throwShutdownFailures(failures: readonly ShutdownFailure[]): void {
  if (failures.length === 0) return;
  throw new AggregateError(
    failures.map(({ label, error }) => new Error(`${label}: ${formatError(error)}`, { cause: error })),
    `Coral backend shutdown completed with ${failures.length} finalizer failure${failures.length === 1 ? '' : 's'}.`,
  );
}

export async function runShutdownSequence({
  reason,
  state,
  teardownRecoveryCoordinator,
  runtimeState,
  idleTimer,
  closeServerFn,
  closeIpcServerFn,
  waitForInflightDrain,
  server,
  ipcServer,
  streamResponses,
  runtime,
  markJobsAsErrorFn,
  providerHostManager,
  kbDaemonSupervisor,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  disposeLifecycleReactor,
  hooks,
  discussStores,
  log,
}: RunShutdownSequenceContext): Promise<void> {
  const failures: ShutdownFailure[] = [];
  const runStep = (label: string, task: () => unknown | Promise<unknown>): Promise<void> =>
    runShutdownStep(failures, label, task, log);
  const observeTask = (label: string, task: Promise<void>): Promise<void> =>
    observeShutdownTask(failures, label, task, log);
  const mode = shutdownModeFromReason(reason);
  const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();

  const drainDeadline = runtime.time.now() + drainTimeout;
  const remainingDrain = (): number => Math.max(0, drainDeadline - runtime.time.now());
  const waitForObservedShutdownTask = (task: Promise<void>): Promise<void> =>
    Promise.race([task, runtime.time.sleep(remainingDrain())]);
  const runBudgetedStep = (label: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> =>
    runStep(label, () => withBudget(label, task, remainingDrain, runtime.time, log));

  // Stop accepting HTTP/user-facing work first; the IPC socket stays bound
  // until all handoff finalizers complete or consume the budget, so the
  // replacement daemon cannot run startup recovery against partial state.
  const serverClosed = observeTask(
    'server close',
    Promise.resolve().then(() => closeServerFn(server)),
  );
  await runStep('inflight drain', () => waitForInflightDrain(idleTimer, remainingDrain(), runtime.time));
  await runStep('server connection close', () => server.closeAllConnections());
  for (const stream of streamResponses) {
    await runStep('stream response close', () => stream.end());
  }
  await waitForObservedShutdownTask(serverClosed);
  await runStep('recovery coordinator teardown', teardownRecoveryCoordinator);
  await runStep('ownership checker teardown', () => state.ownershipCheckerTeardown?.());
  state.ownershipCheckerTeardown = null;

  if (kbDaemonSupervisor !== undefined) {
    await runBudgetedStep('kb child shutdown', async (signal) => {
      await kbDaemonSupervisor.dispose(reason, { signal });
    });
  }

  if (mode === 'hard') {
    let storeServicesAvailable = false;
    await runStep('store services availability check', () => {
      storeServicesAvailable = storeServicesRef.tryGet() !== null;
    });
    if (storeServicesAvailable) {
      await runBudgetedStep('crashed job terminalization', async (signal) => {
        await markJobsAsErrorFn('Backend shutting down', signal);
      });
    }
    await runBudgetedStep('provider host shutdown', async (signal) => providerHostManager.shutdown(signal));
    await runStep('child termination', terminateAllFn);
  } else {
    // Phase A2 is a durability fence, not a best-effort drain. Admission is
    // closed synchronously, then every write already admitted by the old daemon
    // settles before host shutdown or replacement recovery may proceed.
    let quiescePorts: readonly HandoffQuiescePort[] = [];
    await runStep('app-server handoff quiesce discovery', () => {
      quiescePorts = handoffQuiescePorts();
    });
    for (const port of quiescePorts) {
      await runStep('app-server handoff quiesce', () => port.quiesceAppServerJobsForHandoff());
    }
    await runBudgetedStep('provider host drain for handoff', async (signal) =>
      providerHostManager.drainForHandoff(signal),
    );
  }

  await runBudgetedStep('components disposeAll', async (signal) => runtimeState.components.disposeAll(signal));
  await runBudgetedStep('hooks.onShutdown', async (signal) => hooks.onShutdown(mode, signal));
  for (const [source, store] of discussStores) {
    await runStep(`discuss store '${source}' dispose`, () => store.dispose());
  }
  await runStep('lifecycle reactor dispose', disposeLifecycleReactor);

  // Socket release is the last step before lifecycle stop / process exit.
  // No async work may run between this resolution and `onStopped()`; that
  // structural invariant is what makes "socket bound = old daemon authority"
  // hold across the handoff window.
  if (ipcServer && closeIpcServerFn) {
    const ipcServerClosed = observeTask(
      'IPC socket release',
      Promise.resolve().then(() => closeIpcServerFn(ipcServer)),
    );
    await waitForObservedShutdownTask(ipcServerClosed);
  }

  throwShutdownFailures(failures);
}
