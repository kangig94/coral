import { formatError } from '../../../infra/error-format.js';
import { isAppServerRuntime } from '../../../jobs/records.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { ProviderBindingCatalog } from '../../../providers/catalog.js';
import type { JobStore } from '../../../jobs/store.js';
import { planRecovery } from '../../../jobs/reconcile/plan.js';
import { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import { adoptOrphanedCrossNamespaceJobs } from '../../../jobs/reconcile/cross-namespace-adoption.js';
import { markJobAsError } from '../../../jobs/reconcile/recovery-effects.js';
import { writeResultArtifact } from '../../../jobs/terminal/export.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../../../store/append.js';
import {
  applyRecoveryAction,
  finalizeAbortedRecoveredJob,
  finalizeDeadAdoptedJob,
  logRecoveryActionFailure,
  type QueuedRecoverableJob,
  type RunningRecoverableJob,
} from './actions.js';
import { buildRecoverySnapshot } from './snapshot.js';
import type { SessionLookup } from '../../../sessions/lookup.js';

const RECOVERY_POLL_MS = 500;

type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  recoveryPollIntervals: Map<string, TimerHandle>;
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
  progressStore: JobStore;
  runtime: Runtime;
  runtimeState: { setLaunchFenceActive(active: boolean): void };
  eventBus: JobEventBus;
  providerRegistry: ProviderBindingCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  log: (message: string) => void;
};

type StartupRecoveryContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: JobStore;
  providerRegistry: ProviderBindingCatalog;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  cleanupStaleJobs: (currentBundleHash: string) => void;
  sessionLookup: SessionLookup;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason?: InterruptedAppServerReason;
};

type RecoveryAdoptionContext = {
  queuedJobs: QueuedRecoverableJob[];
  runningJobs: RunningRecoverableJob[];
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>;
  signal: AbortSignal;
  interruptedAppServerReason: InterruptedAppServerReason;
};

export function createRecoveryCoordinator({
  progressStore,
  runtime,
  runtimeState,
  eventBus,
  providerRegistry,
  getRecoveryService,
  createInvocationContext,
  log,
}: RecoveryCoordinatorContext): RecoveryCoordinator {
  const state: RecoveryCoordinatorState = {
    recoveryRegistry: null,
    cancelledRecoveryJobIds: new Set<string>(),
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    recoveryPollIntervals: new Map<string, TimerHandle>(),
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
    state.recoveryRegistry?.clearCancelled(jobId);
    takeAdoptedJobCleanup(jobId)?.();
  };

  const maybeReleaseRecoveryRegistry = (): void => {
    if (state.adoptedRunningPids.size === 0 && state.recoveryRegistry?.size === 0) {
      state.recoveryRegistry = null;
    }
  };

  const resetRecoveryState = (options: { forceRegistryRelease?: boolean } = {}): void => {
    if (options.forceRegistryRelease) {
      state.recoveryRegistry = null;
    } else {
      maybeReleaseRecoveryRegistry();
    }
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
    // If a queued job ACKed aborted but was not finalized before teardown clears
    // this set, next boot re-recovers it. That narrow fallback is safe: it
    // reverts to the pre-abort queued recovery behavior.
    state.cancelledRecoveryJobIds.clear();
    resetRecoveryState({ forceRegistryRelease: true });
  };

  async function runRecoveryAdoption({
    queuedJobs,
    runningJobs,
    sessionLookup,
    signal,
    interruptedAppServerReason,
  }: RecoveryAdoptionContext): Promise<void> {
    queuedJobs.sort((a, b) => a.launchRecord.enqueueSequence - b.launchRecord.enqueueSequence);

    let maxRecoverableSeq: number | null = null;
    for (const job of queuedJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.launchRecord.enqueueSequence);
    }
    for (const job of runningJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.launchRecord.enqueueSequence);
    }
    if (maxRecoverableSeq !== null) {
      progressStore.seedEnqueueSequence(maxRecoverableSeq);
    }

    for (const { jobId, launchRecord, runtimeRecord } of runningJobs) {
      let cleanup: (() => void) | null = null;
      try {
        if (launchRecord.provider === null || launchRecord.sessionId === null) {
          const status = progressStore.readStatus(jobId);
          if (status !== null) {
            markJobAsError(progressStore, status, { kind: 'wrapper_lost' }, log);
          }
          state.recoveryRegistry?.remove(jobId);
          log(`Skipped adopting non-provider job: ${jobId}\n`);
          continue;
        }

        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        const recovery = providerRegistry.get(launchRecord.provider)?.recovery;
        if (isAppServerRuntime(runtimeRecord)) {
          signal.throwIfAborted();
          await service.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, {
            reason: interruptedAppServerReason,
          });
          signal.throwIfAborted();
          state.recoveryRegistry?.remove(jobId);
          log(`Recovered interrupted app-server job: ${jobId}\n`);
          continue;
        }
        if (!isDurableCliRuntime(runtimeRecord)) {
          const status = progressStore.readStatus(jobId);
          if (status !== null) {
            markJobAsError(progressStore, status, { kind: 'wrapper_lost' }, log);
          }
          state.recoveryRegistry?.remove(jobId);
          log(`Skipped adopting unsupported runtime for job: ${jobId}\n`);
          continue;
        }

        let adoptedRuntimeRecord = runtimeRecord;
        signal.throwIfAborted();
        const adoption = await service.adoptRunningJob(launchRecord, runtimeRecord);
        cleanup = adoption.cleanup;
        if (!adoption.adopted) {
          state.recoveryRegistry?.remove(jobId);
          log(`Rejected running recovery before adoption: ${jobId}\n`);
          continue;
        }
        signal.throwIfAborted();

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
              progressStore.appendRuntimeStarted(jobId, adoptedRuntimeRecord);
            }

            if (messages.length === 0) {
              return;
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
          void finalizeDeadAdoptedJob({
            jobId,
            launchRecord,
            runtimeRecord: adoptedRuntimeRecord,
            service,
            provider: recovery,
            progressStore,
            runtime,
            sessionLookup,
            cancelledJobIds: state.cancelledRecoveryJobIds,
            log,
          })
            .catch((error: unknown) => {
              log(`Failed to finalize adopted job ${jobId}: ${formatError(error)}\n`);
            })
            .finally(() => {
              state.recoveryRegistry?.clearCancelled(jobId);
              retainedCleanup?.();
              maybeReleaseRecoveryRegistry();
            });
        }, RECOVERY_POLL_MS);
        pollInterval.unref?.();
        state.recoveryPollIntervals.set(jobId, pollInterval);

        state.recoveryRegistry?.remove(jobId);
        log(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
      } catch (error: unknown) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
          cleanup?.();
          throw error;
        }
        log(`Failed to adopt running job ${jobId}: ${formatError(error)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    for (const { jobId, launchRecord } of queuedJobs) {
      try {
        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        signal.throwIfAborted();
        if (!(await service.validateProviderRecoveryAuthority(launchRecord))) {
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
          log(`Rejected queued recovery with invalid provider authority: ${jobId}\n`);
          continue;
        }
        if (state.cancelledRecoveryJobIds.has(jobId)) {
          finalizeAbortedRecoveredJob({ jobId, launchRecord, service, progressStore, log });
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
          log(`Aborted queued recovery job: ${jobId}\n`);
          continue;
        }
        await service.recoverQueuedJob(launchRecord);
        state.recoveryRegistry?.remove(jobId);
        log(`Recovered queued job: ${jobId}\n`);
      } catch (error: unknown) {
        if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
        log(`Failed to recover queued job ${jobId}: ${formatError(error)}\n`);
        state.recoveryRegistry?.remove(jobId);
      }
    }

    signal.throwIfAborted();
    resetRecoveryState();
    log('Recovery adoption complete. Launch fence lifted.\n');
  }

  return {
    async runStartupRecovery(ctx: StartupRecoveryContext): Promise<void> {
      const { namespace, bundleHash, runtime, progressStore, signal, log, cleanupStaleJobs } = ctx;
      const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
      state.teardownRequested = false;
      runtimeState.setLaunchFenceActive(true);
      const recoveryRegistry = new RecoveryRegistry(runtime.process, state.cancelledRecoveryJobIds);
      state.recoveryRegistry = recoveryRegistry;
      const queuedRecoverable: QueuedRecoverableJob[] = [];
      const runningRecoverable: RunningRecoverableJob[] = [];

      const adoptedCount = adoptOrphanedCrossNamespaceJobs(namespace, progressStore, log);
      if (adoptedCount > 0) {
        log(`Adopted ${adoptedCount} orphaned cross-namespace job(s)\n`);
      }

      const snapshot = buildRecoverySnapshot(progressStore, namespace, log, ctx.sessionLookup, runtime.process);
      const plan = planRecovery(snapshot);

      const applyPlanAction = async (action: Parameters<typeof applyRecoveryAction>[0]): Promise<void> => {
        try {
          await applyRecoveryAction(action, {
            progressStore,
            recoveryRegistry,
            queuedRecoverable,
            runningRecoverable,
            log,
            runtime,
            providerRegistry,
            createInvocationContext,
            getRecoveryService,
            sessionLookup: ctx.sessionLookup,
            emitSessionReleased: (payload) => {
              eventBus.emit('session:released', payload);
            },
            coordinatorCommit: ctx.coordinatorCommit,
          });
        } catch (error: unknown) {
          logRecoveryActionFailure(action, error, log);
        }
      };

      for (const action of plan.register) {
        await applyPlanAction(action);
      }
      for (const action of plan.cleanup) {
        await applyPlanAction(action);
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
          sessionLookup: ctx.sessionLookup,
          signal,
          interruptedAppServerReason,
        });
      } catch (error: unknown) {
        if ((error as { name?: string } | null)?.name === 'AbortError') {
          throw error;
        }
        log(`Recovery adoption failed: ${formatError(error)}\n`);
        const markRecoverableAsError = (jobId: string): void => {
          try {
            const status = progressStore.readStatus(jobId);
            if (status) {
              markJobAsError(
                progressStore,
                status,
                {
                  kind: 'wrapper_crashed',
                  cause: { message: `Recovery adoption failed: ${formatError(error)}` },
                },
                log,
              );
              if (status.jobKind === 'workflow') {
                try {
                  writeResultArtifact(runtime.storage, runtime.paths.coral.exports.jobsRoot, status.jobId, '');
                } catch (artifactError: unknown) {
                  log(`Failed to write result artifact for ${status.jobId}: ${formatError(artifactError)}\n`);
                }
              }
            }
          } catch {
            // best-effort
          }
        };
        for (const { jobId } of queuedRecoverable) {
          markRecoverableAsError(jobId);
        }
        for (const { jobId } of runningRecoverable) {
          markRecoverableAsError(jobId);
        }
        resetRecoveryState({ forceRegistryRelease: true });
      }
    },
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
