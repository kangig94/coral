import type { Server, ServerResponse } from 'node:http';
import { formatError } from '../infra/error-format.js';
import type { KbRuntime } from '../kb/contract.js';
import type { DiscussSessionStore } from '../discuss/shell/session-store.js';
import type { IdleTimer } from './live/idle.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import type { ProviderHostManager } from './live/provider-hosts/index.js';
import type { IpcListener } from '../transport/ipc/server.js';
import type { HandoffQuiescePort } from './execution-service.js';
import type { StoreServicesRef } from './composition/store-services-ref.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error
 */
export type ShutdownMode = 'handoff' | 'hard';

export function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

export interface ShutdownRuntimeState {
  setLifecycle(state: 'starting' | 'running' | 'draining' | 'stopped'): void;
  getKbStatus():
    | { kind: 'ok'; subsystem: { curateScheduler: { stop?: () => Promise<void> }; kb: KbRuntime } }
    | { kind: 'unavailable'; reason: string };
}

type RunShutdownSequenceContext = {
  reason: string;
  state: LifecycleWiringState;
  teardownRecoveryCoordinator: () => void;
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
  namespace: string;
  markJobsAsErrorFn: (namespace: string, message: string) => void;
  providerHostManager: ProviderHostManager;
  storeServicesRef: StoreServicesRef;
  terminateAllFn: () => void;
  handoffQuiescePorts: () => readonly HandoffQuiescePort[];
  hooks: { onShutdown(mode: ShutdownMode): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  log: (message: string) => void;
};

/**
 * Run an async finalizer against the remaining drain budget.
 *
 * The `signal` passed to `task` aborts when the budget timer wins the race;
 * callers MUST honor it on every suspension point if they want real
 * cancellation. Legacy finalizers (`curateScheduler.stop`,
 * `shutdownActiveExpansions`, `hooks.onShutdown`) ignore the signal — for
 * those, `taskAbort.abort()` is a no-op and the orphan task continues running
 * until `process.exit(0)` terminates the process. AC5's "returns within
 * budget" guarantee holds because the race resolves on the timeout symbol.
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
  namespace,
  markJobsAsErrorFn,
  providerHostManager,
  storeServicesRef,
  terminateAllFn,
  handoffQuiescePorts,
  hooks,
  discussStores,
  log,
}: RunShutdownSequenceContext): Promise<void> {
  const mode = shutdownModeFromReason(reason);
  const drainTimeout = mode === 'handoff' ? HANDOFF_DRAIN_TIMEOUT_MS : SHUTDOWN_DRAIN_TIMEOUT_MS;

  log(`Coral backend shutting down (${reason}, mode=${mode})...\n`);
  runtimeState.setLifecycle('draining');
  idleTimer.stopWatching();

  const drainDeadline = runtime.time.now() + drainTimeout;
  const remainingDrain = (): number => Math.max(0, drainDeadline - runtime.time.now());

  // Stop accepting HTTP/user-facing work first; the IPC socket stays bound
  // until all handoff finalizers complete or consume the budget, so the
  // replacement daemon cannot run startup recovery against partial state.
  const serverClosed = closeServerFn(server);
  await waitForInflightDrain(idleTimer, remainingDrain(), runtime.time);
  server.closeAllConnections();
  for (const stream of streamResponses) {
    stream.end();
  }
  await Promise.race([serverClosed, runtime.time.sleep(remainingDrain())]);
  teardownRecoveryCoordinator();
  state.ownershipCheckerTeardown?.();
  state.ownershipCheckerTeardown = null;

  if (mode === 'hard') {
    if (storeServicesRef.tryGet() !== null) {
      markJobsAsErrorFn(namespace, 'Backend shutting down');
    }
    await providerHostManager.shutdown();
    terminateAllFn();
  } else {
    // Phase A2: detach durable terminal/completion side effects for active
    // app-server jobs before provider-host drain closes their leases.
    // Quiesce is structurally bounded — synchronous detach completes before
    // the budget can fire, so subsequent transport closure cannot reach
    // `recordTerminal` or admission/session release. Replacement startup
    // recovery owns the durable finalization sequence under the new daemon's
    // socket ownership.
    await withBudget(
      'app-server handoff quiesce',
      async (signal) => {
        for (const port of handoffQuiescePorts()) {
          try {
            await port.quiesceAppServerJobsForHandoff(signal);
          } catch (error: unknown) {
            log(`app-server handoff quiesce failed: ${formatError(error)}\n`);
          }
        }
      },
      remainingDrain,
      runtime.time,
      log,
    );
    await withBudget(
      'provider host drain for handoff',
      async () => providerHostManager.drainForHandoff(),
      remainingDrain,
      runtime.time,
      log,
    );
  }

  const kbStatus = runtimeState.getKbStatus();
  const kbSubsystem = kbStatus.kind === 'ok' ? kbStatus.subsystem : null;
  const curateSchedulerStop = kbSubsystem?.curateScheduler.stop?.bind(kbSubsystem.curateScheduler);
  if (curateSchedulerStop) {
    await withBudget('kb curate scheduler stop', async () => curateSchedulerStop(), remainingDrain, runtime.time, log);
  }
  const expansionLifecycleService = storeServicesRef.tryGet()?.expansionLifecycleService ?? null;
  if (expansionLifecycleService) {
    await withBudget(
      'expansion shutdown',
      async () =>
        expansionLifecycleService.shutdownActiveExpansions().catch((error: unknown) => {
          log(`expansion shutdown failed: ${formatError(error)}\n`);
        }),
      remainingDrain,
      runtime.time,
      log,
    );
  }
  await withBudget('hooks.onShutdown', async () => hooks.onShutdown(mode), remainingDrain, runtime.time, log);
  for (const store of discussStores.values()) {
    store.dispose();
  }

  // Socket release is the last step before lifecycle stop / process exit.
  // No async work may run between this resolution and `onStopped()`; that
  // structural invariant is what makes "socket bound = old daemon authority"
  // hold across the handoff window.
  if (ipcServer && closeIpcServerFn) {
    await Promise.race([closeIpcServerFn(ipcServer), runtime.time.sleep(remainingDrain())]);
  }
}
