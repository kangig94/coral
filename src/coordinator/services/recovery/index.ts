import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime } from '../../../jobs/records.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
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
import { releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { SessionLookup } from '../../../sessions/lookup.js';

const RECOVERY_POLL_MS = 500;

type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  adoptedRunningJobCleanups: Map<string, () => void>;
  inflightFinalizations: Map<
    string,
    Readonly<{
      promise: Promise<void>;
      abort(): void;
      commitStarted(): boolean;
    }>
  >;
  teardownRequested: boolean;
};

export interface RecoveryCoordinator {
  runStartupRecovery(ctx: StartupRecoveryContext): Promise<void>;
  getRecoveryRegistry(): RecoveryRegistry | null;
  isIdleBlocked(): boolean;
  teardown(): Promise<void>;
}

type RecoveryCoordinatorContext = {
  progressStore: JobStore;
  runtime: Runtime;
  runtimeState: { setLaunchFenceActive(active: boolean): void };
  eventBus: JobEventBus;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  log: (message: string) => void;
};

type StartupRecoveryContext = {
  namespace: string;
  bundleHash: string;
  runtime: Runtime;
  progressStore: JobStore;
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
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
};

export function createRecoveryCoordinator({
  progressStore,
  runtime,
  runtimeState,
  eventBus,
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
    inflightFinalizations: new Map(),
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

  const startTrackedFinalization = (
    jobId: string,
    parentSignal: AbortSignal,
    run: (fence: { signal: AbortSignal; onCommitStart(): void }) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController();
    let commitStarted = false;
    const forwardAbort = (): void => controller.abort();
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    const promise = run({
      signal: controller.signal,
      onCommitStart: () => {
        commitStarted = true;
      },
    }).finally(() => {
      parentSignal.removeEventListener('abort', forwardAbort);
      if (state.inflightFinalizations.get(jobId)?.promise === promise) {
        state.inflightFinalizations.delete(jobId);
      }
    });
    const tracked = Object.freeze({
      promise,
      abort: () => controller.abort(),
      commitStarted: () => commitStarted,
    });
    state.inflightFinalizations.set(jobId, tracked);
    return promise;
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

  const teardown = async (): Promise<void> => {
    state.teardownRequested = true;

    for (const pollInterval of state.recoveryPollIntervals.values()) {
      runtime.time.clearInterval(pollInterval);
    }
    state.recoveryPollIntervals.clear();

    for (const jobId of [...state.adoptedRunningPids.keys()]) {
      releaseAdoptedJob(jobId);
    }
    for (const finalization of state.inflightFinalizations.values()) {
      finalization.abort();
    }
    await Promise.allSettled(
      [...state.inflightFinalizations.values()]
        .filter((finalization) => finalization.commitStarted())
        .map((finalization) => finalization.promise),
    );
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
    signal,
    coordinatorCommit,
    interruptedAppServerReason,
  }: RecoveryAdoptionContext): Promise<void> {
    /**
     * Persist an unresolvable recovery as a per-job terminal fault, release any
     * matching session claim, and remove registry ownership so startup can continue.
     */
    const recordUnresolvedRecovery = (jobId: string, summary: string, error: unknown): void => {
      const status = progressStore.readStatus(jobId);
      if (status === null) {
        state.recoveryRegistry?.remove(jobId);
        log(
          `${summary} for ${jobId}: ${errorMessage(error)}; job status was unavailable, so no terminal or session claim could be updated.\n`,
        );
        return;
      }

      const alreadyTerminal = isTerminalPhase(status.phase);
      if (!alreadyTerminal) {
        markJobAsError(
          progressStore,
          status,
          {
            kind: 'recovery_parse_failed',
            cause: {
              message: `${summary}: ${errorMessage(error)}`,
              ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
            },
          },
          runtime.time.now(),
          log,
        );
      }

      let releasedSessionClaim = status.sessionId === null;
      try {
        if (status.sessionId !== null) {
          releaseSessionJobClaim({
            projectRoot: status.projectRoot,
            runtime,
            emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
            db: progressStore.getDb(),
            commitEvents: coordinatorCommit,
            sessionId: status.sessionId,
            jobId,
          });
          releasedSessionClaim = true;
        }
      } finally {
        state.recoveryRegistry?.remove(jobId);
        const terminalDisposition = alreadyTerminal
          ? 'job was already terminal'
          : 'terminalized as recovery_parse_failed';
        const sessionDisposition =
          status.sessionId === null
            ? 'no session claim was present'
            : releasedSessionClaim
              ? 'released its session claim'
              : 'could not release its session claim';
        log(
          `${summary} for ${jobId}: ${errorMessage(error)}; ${terminalDisposition}; ${sessionDisposition}. Run coral-cli jobs detail ${jobId} for the recorded reason.\n`,
        );
      }
    };

    queuedJobs.sort((a, b) => a.authority.launchRecord.enqueueSequence - b.authority.launchRecord.enqueueSequence);

    let maxRecoverableSeq: number | null = null;
    for (const job of queuedJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.authority.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.authority.launchRecord.enqueueSequence);
    }
    for (const job of runningJobs) {
      maxRecoverableSeq =
        maxRecoverableSeq === null
          ? job.authority.launchRecord.enqueueSequence
          : Math.max(maxRecoverableSeq, job.authority.launchRecord.enqueueSequence);
    }
    if (maxRecoverableSeq !== null) {
      progressStore.seedEnqueueSequence(maxRecoverableSeq);
    }

    for (const { jobId, authority, runtimeRecord } of runningJobs) {
      const { launchRecord, boundProvider } = authority;
      let cleanup: (() => void) | null = null;
      try {
        if (launchRecord.provider === null || launchRecord.sessionId === null) {
          const status = progressStore.readStatus(jobId);
          if (status !== null) {
            markJobAsError(progressStore, status, { kind: 'wrapper_lost' }, runtime.time.now(), log);
          }
          state.recoveryRegistry?.remove(jobId);
          log(`Skipped adopting non-provider job: ${jobId}\n`);
          continue;
        }

        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        if (isAppServerRuntime(runtimeRecord)) {
          signal.throwIfAborted();
          const finalization = startTrackedFinalization(jobId, signal, (fence) =>
            service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
              reason: interruptedAppServerReason,
              ...fence,
            }),
          );
          try {
            await finalization;
          } catch (error: unknown) {
            if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
            recordUnresolvedRecovery(jobId, 'Interrupted app-server recovery remains incomplete', error);
            continue;
          }
          signal.throwIfAborted();
          state.recoveryRegistry?.remove(jobId);
          log(`Recovered interrupted app-server job: ${jobId}\n`);
          continue;
        }
        if (!isDurableCliRuntime(runtimeRecord)) {
          const status = progressStore.readStatus(jobId);
          if (status !== null) {
            markJobAsError(progressStore, status, { kind: 'wrapper_lost' }, runtime.time.now(), log);
          }
          state.recoveryRegistry?.remove(jobId);
          log(`Skipped adopting unsupported runtime for job: ${jobId}\n`);
          continue;
        }
        const recovery = boundProvider.recovery;

        let adoptedRuntimeRecord = runtimeRecord;
        const drainRecoveredProgress = (): void => {
          if (!recovery?.extractProgress) {
            return;
          }

          try {
            const { messages, newOffset } = recovery.extractProgress({
              stdoutPath: adoptedRuntimeRecord.stdoutPath,
              fromOffset: adoptedRuntimeRecord.tailWatermark ?? 0,
            });

            if (newOffset !== (adoptedRuntimeRecord.tailWatermark ?? 0)) {
              adoptedRuntimeRecord = { ...adoptedRuntimeRecord, tailWatermark: newOffset };
              progressStore.appendRuntimeStarted(jobId, adoptedRuntimeRecord);
            }

            for (const message of messages) {
              progressStore.appendProgress(jobId, launchRecord.sessionId, message);
            }
          } catch (error: unknown) {
            log(`Failed to tail recovered progress for job ${jobId}: ${formatError(error)}\n`);
          }
        };

        if (!runtime.process.isAlive(runtimeRecord.pid)) {
          drainRecoveredProgress();
          try {
            await startTrackedFinalization(jobId, signal, (fence) =>
              finalizeDeadAdoptedJob({
                jobId,
                runtimeRecord: adoptedRuntimeRecord,
                service,
                authority,
                progressStore,
                cancelledJobIds: state.cancelledRecoveryJobIds,
                fence,
              }),
            );
          } catch (error: unknown) {
            if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
            recordUnresolvedRecovery(jobId, 'Interrupted durable recovery remains incomplete', error);
            state.recoveryRegistry?.clearCancelled(jobId);
            continue;
          }
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
          log(`Finalized dead durable recovery job: ${jobId}\n`);
          continue;
        }

        signal.throwIfAborted();
        const adoption = await service.adoptRunningJob(authority, runtimeRecord);
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
          const finalization = startTrackedFinalization(jobId, signal, (fence) =>
            finalizeDeadAdoptedJob({
              jobId,
              runtimeRecord: adoptedRuntimeRecord,
              service,
              authority,
              progressStore,
              cancelledJobIds: state.cancelledRecoveryJobIds,
              fence,
            }),
          )
            .then(() => {
              state.recoveryRegistry?.clearCancelled(jobId);
              retainedCleanup?.();
              maybeReleaseRecoveryRegistry();
            })
            .catch((error: unknown) => {
              if (retainedCleanup !== null) {
                state.adoptedRunningJobCleanups.set(jobId, retainedCleanup);
              }
              state.recoveryRegistry?.register(jobId, launchRecord, adoptedRuntimeRecord);
              runtimeState.setLaunchFenceActive(true);
              log(`Failed to finalize adopted job ${jobId}: ${formatError(error)}\n`);
            });
          void finalization.catch((error: unknown) => {
            log(`Durable finalization cleanup failed for ${jobId}: ${formatError(error)}\n`);
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

    for (const { jobId, authority } of queuedJobs) {
      const { launchRecord } = authority;
      try {
        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        signal.throwIfAborted();
        if (state.cancelledRecoveryJobIds.has(jobId)) {
          finalizeAbortedRecoveredJob({ jobId, authority, service, runtime });
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
          log(`Aborted queued recovery job: ${jobId}\n`);
          continue;
        }
        await service.recoverQueuedJob(authority);
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

      const adoptedCount = adoptOrphanedCrossNamespaceJobs(namespace, progressStore, runtime.time.now(), log);
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
            createInvocationContext,
            getRecoveryService,
            sessionLookup: ctx.sessionLookup,
            emitSessionReleased: (payload) => {
              eventBus.emit('session:released', payload);
            },
            coordinatorCommit: ctx.coordinatorCommit,
            signal,
          });
        } catch (error: unknown) {
          logRecoveryActionFailure(action, error, log);
          if (action.type === 'registerQueued' || action.type === 'registerRunning') {
            throw error;
          }
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
          signal,
          coordinatorCommit: ctx.coordinatorCommit,
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
                runtime.time.now(),
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
