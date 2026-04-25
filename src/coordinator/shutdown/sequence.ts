import type { Server, ServerResponse } from 'node:http';
import { errorMessage, formatError } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import { listLiveJobs } from '../../jobs/reconcile/recovery-effects.js';
import { isAppServerRuntime } from '../../jobs/records.js';
import type { ProgressStore } from '../../jobs/job-store.js';
import type { KbRuntime } from '../../kb/contracts.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { DiscussSessionStore } from '../../discuss/shell/session-store.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { ProviderHostManager } from '../live/provider-hosts/pool.js';
import type { EquipmentLifecycleService } from '../equipment/lifecycle.js';
import { shutdownModeFromReason, type ShutdownMode } from './mode.js';
import type { IpcListener } from '../../transport/ipc/server.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

export interface ShutdownRuntimeState {
  setLifecycle(state: 'starting' | 'running' | 'draining' | 'stopped'): void;
  getKbSubsystem(): {
    curateScheduler: { stop?: () => Promise<void> };
    kb: KbRuntime;
  } | null;
}

type FinalizeLiveAppServerJobsForHandoffContext = {
  progressStore: ProgressStore;
  namespace: string;
  pluginRoot: string;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  providerHostManager: ProviderHostManager;
  log: (message: string) => void;
};

async function finalizeLiveAppServerJobsForHandoff({
  progressStore,
  namespace,
  pluginRoot,
  getRecoveryService,
  providerHostManager,
  log,
}: FinalizeLiveAppServerJobsForHandoffContext): Promise<void> {
  for (const status of listLiveJobs(progressStore, namespace)) {
    const launchRecord = progressStore.readLaunchProjection(status.jobId);
    const runtimeRecord = progressStore.readRuntimeProjection(status.jobId);
    if (!launchRecord || !isAppServerRuntime(runtimeRecord)) {
      continue;
    }

    try {
      const service = getRecoveryService({ projectRoot: launchRecord.projectRoot, pluginRoot, coralEnv: {} });
      await service.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, { reason: 'handoff' });
      log(`Finalized interrupted app-server job during handoff: ${status.jobId}\n`);
    } catch (error: unknown) {
      log(`Failed to finalize interrupted app-server job ${status.jobId} during handoff: ${formatError(error)}\n`);
    }
  }

  try {
    await providerHostManager.drainForHandoff();
  } catch (error: unknown) {
    log(`Failed to drain provider servers during handoff: ${formatError(error)}\n`);
  }
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
  equipmentLifecycleService?: EquipmentLifecycleService | null;
  terminateAllFn: () => void;
  progressStore: ProgressStore;
  pluginRoot: string;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  hooks: { onShutdown(mode: ShutdownMode): Promise<void> };
  discussStores: Map<string, DiscussSessionStore>;
  log: (message: string) => void;
};

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
  equipmentLifecycleService,
  terminateAllFn,
  progressStore,
  pluginRoot,
  getRecoveryService,
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

  const serverClosed = closeServerFn(server);
  const ipcClosed = ipcServer && closeIpcServerFn ? closeIpcServerFn(ipcServer) : Promise.resolve();
  await waitForInflightDrain(idleTimer, remainingDrain(), runtime.time);
  server.closeAllConnections?.();
  for (const stream of streamResponses) {
    stream.end();
  }
  await Promise.all([
    Promise.race([serverClosed, runtime.time.sleep(remainingDrain())]),
    Promise.race([ipcClosed, runtime.time.sleep(remainingDrain())]),
  ]);
  teardownRecoveryCoordinator();
  state.ownershipCheckerTeardown?.();
  state.ownershipCheckerTeardown = null;

  if (mode === 'hard') {
    markJobsAsErrorFn(namespace, 'Backend shutting down');
    await providerHostManager.shutdown();
    terminateAllFn();
  } else {
    await finalizeLiveAppServerJobsForHandoff({
      progressStore,
      namespace,
      pluginRoot,
      getRecoveryService,
      providerHostManager,
      log,
    });
  }

  const kbSubsystem = runtimeState.getKbSubsystem();
  const curateSchedulerStop = kbSubsystem?.curateScheduler.stop?.bind(kbSubsystem.curateScheduler);
  const kbStopBudgetMs = remainingDrain();
  if (curateSchedulerStop && kbStopBudgetMs >= 500) {
    await Promise.race([curateSchedulerStop(), runtime.time.sleep(kbStopBudgetMs)]);
  }
  await equipmentLifecycleService?.shutdownActiveEquipment().catch((error: unknown) => {
    backendLog.warn(`equipment shutdown failed: ${errorMessage(error)}`);
  });
  await hooks.onShutdown(mode);
  for (const store of discussStores.values()) {
    store.dispose();
  }
}
