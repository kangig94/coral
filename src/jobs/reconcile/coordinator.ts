import { legacyWrapperCrashedFault } from '../../shared/legacy-terminal-outcome-compat.js';
import { formatError } from '../../shared/utils.js';
import { isTerminalPhase } from '../phase.js';
import { isAppServerRuntime } from '../records.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { MutableRuntimeState } from '../../coordinator/control.js';
import type { ProgressStore } from '../../store/progress-store.js';
import { planRecovery } from './plan.js';
import { RecoveryRegistry } from '../../coordinator/composition/recovery-registry.js';
import type { Runtime, RuntimeTimerHandle } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../coordinator/api.js';
import { adoptOrphanedCrossNamespaceJobs } from './cross-namespace-adoption.js';
import { StartupInterruptedError } from './errors.js';
import { markJobAsError } from './job-helpers.js';
import {
  applyRecoveryAction,
  finalizeDeadAdoptedJob,
  logRecoveryActionFailure,
  type QueuedRecoverableJob,
  type RunningRecoverableJob,
} from './actions.js';
import { buildRecoverySnapshot } from './snapshot.js';

const RECOVERY_POLL_MS = 500;

type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  recoveryPollIntervals: Map<string, RuntimeTimerHandle>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  teardownRequested: boolean;
};

export interface RecoveryCoordinator {
  runStartupRecovery(ctx: StartupRecoveryContext): Promise<void>;
  getRecoveryRegistry(): RecoveryRegistry | null;
  isIdleBlocked(): boolean;
  teardown(): void;
}

type RecoveryCoordinatorContext = {
  progressStore: ProgressStore;
  runtime: Runtime;
  runtimeState: MutableRuntimeState;
  providerRegistry: ProviderRegistry;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  createCallerContext: (projectRoot: string) => CallerContext;
  log: (message: string) => void;
};

type StartupRecoveryContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: ProgressStore;
  providerRegistry: ProviderRegistry;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  createCallerContext: (projectRoot: string) => CallerContext;
  assertStartupStillActive: () => void;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
};

type RecoveryAdoptionContext = RecoveryCoordinatorContext & {
  queuedJobs: QueuedRecoverableJob[];
  runningJobs: RunningRecoverableJob[];
  assertStartupStillActive: () => void;
};

export function createRecoveryCoordinator({
  progressStore,
  runtime,
  runtimeState,
  providerRegistry,
  getRecoveryService,
  createCallerContext,
  log,
}: RecoveryCoordinatorContext): RecoveryCoordinator {
  const state: RecoveryCoordinatorState = {
    recoveryRegistry: null,
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    recoveryPollIntervals: new Map<string, RuntimeTimerHandle>(),
    adoptedRunningJobCleanups: new Map<string, () => void>(),
    teardownRequested: false,
  };

  const clearRecoveryPoller = (jobId: string): void => {
    const pollInterval = state.recoveryPollIntervals.get(jobId);
    if (!pollInterval) {
      return;
    }
    runtime.time.clearInterval(pollInterval);
    state.recoveryPollIntervals.delete(jobId);
  };

  const takeAdoptedJobCleanup = (jobId: string): (() => void) | null => {
    const cleanup = state.adoptedRunningJobCleanups.get(jobId) ?? null;
    state.adoptedRunningJobCleanups.delete(jobId);
    return cleanup;
  };

  const releaseAdoptedJob = (jobId: string): void => {
    clearRecoveryPoller(jobId);
    state.adoptedRunningPids.delete(jobId);
    takeAdoptedJobCleanup(jobId)?.();
  };

  const resetRecoveryState = (): void => {
    state.recoveryRegistry = null;
    runtimeState.setLaunchFenceActive(false);
  };

  const teardown = (): void => {
    state.teardownRequested = true;

    for (const pollInterval of state.recoveryPollIntervals.values()) {
      runtime.time.clearInterval(pollInterval);
    }
    state.recoveryPollIntervals.clear();

    for (const jobId of [...state.adoptedRunningPids.keys()]) {
      releaseAdoptedJob(jobId);
    }
    // Safety net: drain any cleanups whose PID entry was removed by the poller
    // (poller-detected-death) before teardown ran. Normally empty — cleanups are
    // idempotent, so double-invoking is safe if this ever overlaps.
    for (const cleanup of state.adoptedRunningJobCleanups.values()) {
      cleanup();
    }
    state.adoptedRunningJobCleanups.clear();
    state.adoptedRunningPids.clear();
    resetRecoveryState();
  };

  async function runRecoveryAdoption({
    queuedJobs,
    runningJobs,
    assertStartupStillActive,
  }: RecoveryAdoptionContext): Promise<void> {
    queuedJobs.sort((a, b) => a.launchRecord.enqueueSequence - b.launchRecord.enqueueSequence);

    const allRecoverableSeqs = [...queuedJobs, ...runningJobs].map((job) => job.launchRecord.enqueueSequence);
    if (allRecoverableSeqs.length > 0) {
      progressStore.seedEnqueueSequence(Math.max(...allRecoverableSeqs));
    }

    for (const { jobId, launchRecord, runtimeRecord } of runningJobs) {
      let cleanup: (() => void) | null = null;
      try {
        const service = getRecoveryService(createCallerContext(launchRecord.projectRoot));
        const recovery = providerRegistry.getArtifactRecovery(launchRecord.provider);
        if (isAppServerRuntime(runtimeRecord)) {
          assertStartupStillActive();
          await service.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, { reason: 'restart' });
          assertStartupStillActive();
          state.recoveryRegistry?.remove(jobId);
          log(`Recovered interrupted app-server job: ${jobId}\n`);
          continue;
        }

        let adoptedRuntimeRecord = runtimeRecord;
        assertStartupStillActive();
        ({ cleanup } = service.adoptRunningJob(launchRecord, runtimeRecord));
        assertStartupStillActive();

        let cleaned = false;
        const cleanupOnce = (): void => {
          if (cleaned) {
            return;
          }
          cleaned = true;
          cleanup?.();
        };

        state.adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });
        state.adoptedRunningJobCleanups.set(jobId, cleanupOnce);

        const drainRecoveredProgress = (): void => {
          if (!recovery?.extractProgress) {
            return;
          }

          try {
            const { messages, newOffset } = recovery.extractProgress({
              stdoutPath: adoptedRuntimeRecord.stdoutPath,
              fromOffset: adoptedRuntimeRecord.tailWatermark ?? 0,
              providerMeta: adoptedRuntimeRecord.providerMeta,
            });

            if (newOffset !== (adoptedRuntimeRecord.tailWatermark ?? 0)) {
              adoptedRuntimeRecord = { ...adoptedRuntimeRecord, tailWatermark: newOffset };
              progressStore.writeRuntimeRecord(jobId, adoptedRuntimeRecord);
            }

            if (messages.length === 0) {
              return;
            }

            const status = progressStore.readStatus(jobId);
            if (status && !isTerminalPhase(status.phase) && status.launch.state !== 'ready') {
              progressStore.updateLaunchState(jobId, 'ready');
              progressStore.updatePhase(jobId, 'running');
            }

            for (const message of messages) {
              progressStore.appendProgress(jobId, launchRecord.sessionId, message);
            }
          } catch (error: unknown) {
            log(`Failed to tail recovered progress for job ${jobId}: ${formatError(error)}\n`);
          }
        };

        const pollInterval = runtime.time.setInterval(() => {
          drainRecoveredProgress();

          if (runtime.process.isAlive(runtimeRecord.pid)) {
            return;
          }

          clearRecoveryPoller(jobId);
          state.adoptedRunningPids.delete(jobId);
          const retainedCleanup = takeAdoptedJobCleanup(jobId);

          if (state.teardownRequested) {
            retainedCleanup?.();
            return;
          }

          drainRecoveredProgress();
          finalizeDeadAdoptedJob({
            jobId,
            launchRecord,
            runtimeRecord,
            service,
            provider: recovery,
            progressStore,
            log,
          });
          retainedCleanup?.();
        }, RECOVERY_POLL_MS);
        pollInterval.unref?.();
        state.recoveryPollIntervals.set(jobId, pollInterval);

        state.recoveryRegistry?.remove(jobId);
        log(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      } catch (error: unknown) {
        if (error instanceof StartupInterruptedError) {
          cleanup?.();
          throw error;
        }
        log(`Failed to adopt running job ${jobId}: ${formatError(error)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    for (const { jobId, launchRecord } of queuedJobs) {
      try {
        const service = getRecoveryService(createCallerContext(launchRecord.projectRoot));
        assertStartupStillActive();
        service.recoverQueuedJob(launchRecord);
        state.recoveryRegistry?.remove(jobId);
        log(`Recovered queued job: ${jobId}\n`);
      } catch (error: unknown) {
        if (error instanceof StartupInterruptedError) throw error;
        log(`Failed to recover queued job ${jobId}: ${formatError(error)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    assertStartupStillActive();
    resetRecoveryState();
    log('Recovery adoption complete. Launch fence lifted.\n');
  }

  return {
    async runStartupRecovery(ctx: StartupRecoveryContext): Promise<void> {
      const {
        namespace,
        bundleHash,
        runtime,
        progressStore,
        assertStartupStillActive,
        log,
        cleanupStaleJobs,
      } = ctx;
      state.teardownRequested = false;
      runtimeState.setLaunchFenceActive(true);
      const recoveryRegistry = new RecoveryRegistry(runtime.process);
      state.recoveryRegistry = recoveryRegistry;
      const queuedRecoverable: QueuedRecoverableJob[] = [];
      const runningRecoverable: RunningRecoverableJob[] = [];

      const adoptedCount = adoptOrphanedCrossNamespaceJobs(namespace, runtime, log);
      if (adoptedCount > 0) {
        log(`Adopted ${adoptedCount} orphaned cross-namespace job(s)\n`);
      }

      const snapshot = buildRecoverySnapshot(progressStore, namespace, runtime, log);
      const plan = planRecovery(snapshot);

      for (const action of [...plan.register, ...plan.cleanup]) {
        try {
          applyRecoveryAction(action, {
            progressStore,
            recoveryRegistry,
            queuedRecoverable,
            runningRecoverable,
            log,
            runtime,
            createCallerContext,
            getRecoveryService,
          });
        } catch (error: unknown) {
          logRecoveryActionFailure(action, error, log);
        }
      }

      cleanupStaleJobs(bundleHash);

      if (queuedRecoverable.length === 0 && runningRecoverable.length === 0) {
        resetRecoveryState();
        return;
      }

      try {
        await runRecoveryAdoption({
          queuedJobs: queuedRecoverable,
          runningJobs: runningRecoverable,
          assertStartupStillActive,
          progressStore,
          runtime,
          runtimeState,
          providerRegistry,
          getRecoveryService,
          createCallerContext,
          log,
        });
      } catch (error: unknown) {
        if (error instanceof StartupInterruptedError) {
          throw error;
        }
        log(`Recovery adoption failed: ${formatError(error)}\n`);
        const allRecoverable = [...queuedRecoverable, ...runningRecoverable];
        for (const { jobId } of allRecoverable) {
          try {
            const status = progressStore.readStatus(jobId);
            if (status) {
              markJobAsError(
                progressStore,
                status,
                legacyWrapperCrashedFault(`Recovery adoption failed: ${formatError(error)}`),
                log,
              );
            }
          } catch {
            // best-effort
          }
        }
        resetRecoveryState();
      }
    },
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
