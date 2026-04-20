import type { Server, ServerResponse } from 'node:http';
import { errorMessage, formatError } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import { isAppServerRuntime, listLiveJobs, type ProgressStore } from '../../jobs/api.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { MutableRuntimeState } from '../control.js';
import type { DiscussSessionStore } from '../../discuss/api.js';
import type { IdleTimer } from '../live/idle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../contracts.js';
import type { ProviderHostManager } from '../live/provider-hosts/pool.js';
import { closeNeedleBackend } from '../../kb/search/needle-backend.js';
import { shutdownModeFromReason, type ShutdownMode } from './mode.js';
import type { IpcListener } from '../../transport/ipc/server.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_TIMEOUT_MS = 30_000;
export const SHUTDOWN_POLL_MS = 50;

export type LifecycleWiringState = {
  ownershipCheckerTeardown: (() => void) | null;
};

type FinalizeLiveAppServerJobsForHandoffContext = {
  progressStore: ProgressStore;
  namespace: string;
  pluginRoot: string;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
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
    const launchRecord = progressStore.readLaunchRecord(status.jobId);
    const runtimeRecord = progressStore.readRuntimeRecord(status.jobId);
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
  runtimeState: MutableRuntimeState;
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
  terminateAllFn: () => void;
  progressStore: ProgressStore;
  pluginRoot: string;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
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
  await (kbSubsystem === null ? Promise.resolve() : closeNeedleBackend(kbSubsystem.kb)).catch((error: unknown) => {
    backendLog.warn(`closeNeedleBackend failed during shutdown: ${errorMessage(error)}`);
  });
  await hooks.onShutdown(mode);
  for (const store of discussStores.values()) {
    store.dispose();
  }
}
