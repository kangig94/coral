import type { Server, ServerResponse } from 'node:http';
import { errorMessage, formatError } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import { isAppServerRuntime, listLiveJobs } from '../../jobs/api.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { MutableRuntimeState } from '../control.js';
import type { DiscussSessionStore } from '../../discuss/api.js';
import type { IdleTimer } from '../live/idle.js';
import type { ProgressStore } from '../../execution/progress-store.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../api.js';
import type { ProviderHostManager } from '../live/provider-hosts/pool.js';
import { shutdownModeFromReason, type ShutdownMode } from './mode.js';

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
  waitForInflightDrain: (
    idleTimer: IdleTimer,
    timeoutMs: number,
    time: Pick<Runtime['time'], 'clearInterval' | 'now' | 'setInterval'>,
  ) => Promise<void>;
  server: Server;
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
  waitForInflightDrain,
  server,
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

  const serverClosed = closeServerFn(server);
  await waitForInflightDrain(idleTimer, drainTimeout, runtime.time);
  server.closeAllConnections?.();
  for (const stream of streamResponses) {
    stream.end();
  }
  await Promise.race([serverClosed, runtime.time.sleep(drainTimeout)]);
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

  await Promise.race([runtimeState.getKbSubsystem()?.curateScheduler.stop?.(), runtime.time.sleep(5_000)]);
  await runtimeState.getKbSubsystem()?.kb.closeVectorStores().catch((error: unknown) => {
    backendLog.warn(`closeVectorStores failed during shutdown: ${errorMessage(error)}`);
  });
  await hooks.onShutdown(mode);
  for (const store of discussStores.values()) {
    store.dispose();
  }
}
