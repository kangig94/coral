import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobLaunch, type JobStatus } from '../../../jobs/records.js';
import {
  decodeProjectionJobExecutionOwner,
  decodeProjectionJobStoredRow,
  decodeProjectionJobTerminal,
  PROJECTION_JOB_COLUMNS,
  type ProjectionJobStoredRow,
} from '../../../jobs/projection-row.js';
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
import { describeSessionJobClaimReleaseResult, releaseSessionJobClaim } from '../../../sessions/job-release.js';
import type { SessionJobClaimReleaseResult } from '../../../sessions/contracts.js';
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
  runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobStore>;
  releaseAdoptedJob(jobId: string): void;
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

type RecoveryHydrationFallback = {
  status: JobStatus;
  launchCreatedAt: string;
};

function candidateJobId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || !('job_id' in raw)) {
    return null;
  }
  return typeof raw.job_id === 'string' && raw.job_id.length > 0 ? raw.job_id : null;
}

function recoveryStatusFromProjectionRow(row: ProjectionJobStoredRow): JobStatus {
  const result = decodeProjectionJobTerminal(row);
  return {
    jobId: row.job_id,
    owner: decodeProjectionJobExecutionOwner(row),
    sessionId: row.session_id,
    provider: row.provider,
    projectRoot: row.project_root,
    backendNamespace: row.backend_namespace,
    ...(row.bundle_hash === null ? {} : { bundleHash: row.bundle_hash }),
    jobKind: row.job_kind,
    phase: row.phase,
    updatedAt: row.created_at,
    lastSeq: row.last_seq,
    ...(result === null ? {} : { result }),
  };
}

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

  const maybeReleaseRecoveryRegistry = (): void => {
    if (state.adoptedRunningPids.size === 0 && state.recoveryRegistry?.size === 0) {
      state.recoveryRegistry = null;
    }
  };

  const releaseAdoptedJob = (jobId: string): void => {
    clearRecoveryPoller(jobId);
    state.adoptedRunningPids.delete(jobId);
    state.recoveryRegistry?.clearCancelled(jobId);
    takeAdoptedJobCleanup(jobId)?.();
    maybeReleaseRecoveryRegistry();
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

  const recordUnresolvedRecovery = (
    jobId: string,
    summary: string,
    error: unknown,
    coordinatorCommit: CommitEventsFn,
    hydrationFallback?: RecoveryHydrationFallback,
  ): void => {
    let status: JobStatus | null = hydrationFallback?.status ?? null;
    let statusReadError: unknown = null;
    if (status === null) {
      try {
        status = progressStore.readStatus(jobId);
      } catch (readError: unknown) {
        // Reading the status decodes the persisted projection, so it throws on
        // exactly the malformed row that usually produced `error`. Six of the
        // seven callers pass no fallback, so this is their live path — letting it
        // escape would abandon the rest of the batch and fail the boot, which is
        // the failure this function exists to contain.
        statusReadError = readError;
        status = null;
      }
    }
    if (status === null) {
      try {
        state.recoveryRegistry?.remove(jobId);
      } finally {
        const unavailability =
          statusReadError === null ? '' : ` (status decode failed: ${errorMessage(statusReadError)})`;
        log(
          `${summary} for ${jobId}: ${errorMessage(error)}; job status was unavailable${unavailability}, so no terminal or session claim could be updated.\n`,
        );
      }
      return;
    }

    const alreadyTerminal = isTerminalPhase(status.phase);
    let terminalized = alreadyTerminal;
    let releaseResult: SessionJobClaimReleaseResult | null = null;
    let recoveryUpdateError: unknown = null;
    try {
      if (!alreadyTerminal) {
        const terminalStore =
          hydrationFallback === undefined
            ? progressStore
            : ({
                commit: (cb) => [...(coordinatorCommit(cb) ?? [])],
                readLaunchProjection: () => ({ createdAt: hydrationFallback.launchCreatedAt }) as JobLaunch,
              } satisfies Pick<JobStore, 'commit' | 'readLaunchProjection'>);
        markJobAsError(
          terminalStore,
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
        terminalized = true;
      }

      if (status.sessionId !== null) {
        releaseResult = releaseSessionJobClaim({
          projectRoot: status.projectRoot,
          runtime,
          emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
          db: progressStore.getDb(),
          commitEvents: coordinatorCommit,
          sessionId: status.sessionId,
          jobId,
        });
      }
    } catch (updateError: unknown) {
      // Containment belongs in this frame, not at the call sites. Every caller
      // invokes this from its own `catch` and then continues to the next job, so
      // a throw from here escapes that `catch` and abandons the rest of the
      // batch — and the two unwrapped `hydrateRecoveryJobDetails` calls turn it
      // into a boot failure for every project. The `finally` below reports the
      // incomplete disposition, which is the whole of what a caller could add.
      recoveryUpdateError = updateError;
    } finally {
      const terminalDisposition = alreadyTerminal
        ? 'job was already terminal'
        : terminalized
          ? 'terminalized as recovery_parse_failed'
          : 'could not terminalize as recovery_parse_failed';
      const sessionDisposition =
        status.sessionId === null
          ? 'no session claim was recorded on the job'
          : !terminalized
            ? 'session claim release was not attempted because terminalization failed'
            : releaseResult !== null
              ? `session claim disposition: ${describeSessionJobClaimReleaseResult(releaseResult)}`
              : 'session claim release failed';
      const nextStep =
        recoveryUpdateError === null
          ? hydrationFallback === undefined
            ? `Run coral-cli jobs detail ${jobId} for the recorded reason.`
            : 'The persisted-detail decode failure is included in this log.'
          : `Recovery state disposition did not complete: ${errorMessage(recoveryUpdateError)}. Inspect the persisted state and coordinator log before restarting.`;
      try {
        state.recoveryRegistry?.remove(jobId);
      } finally {
        log(
          `${summary} for ${jobId}: ${errorMessage(error)}; ${terminalDisposition}; ${sessionDisposition}. ${nextStep}\n`,
        );
      }
    }
  };

  const hydrateRecoveryJobDetails = (
    coordinatorCommit: CommitEventsFn,
    excludedJobIds: ReadonlySet<string> = new Set(),
  ): {
    detailsByJob: Map<string, ReturnType<JobStore['loadJobProjectionDetail']>>;
    excludedJobIds: Set<string>;
  } => {
    const detailsByJob = new Map<string, ReturnType<JobStore['loadJobProjectionDetail']>>();
    const excluded = new Set(excludedJobIds);
    const rawRows = progressStore
      .getDb()
      .prepare(`SELECT ${PROJECTION_JOB_COLUMNS} FROM projection_jobs ORDER BY job_id ASC`)
      .all();
    const rows: ProjectionJobStoredRow[] = [];

    for (const raw of rawRows) {
      const possibleJobId = candidateJobId(raw);
      if (possibleJobId !== null && excluded.has(possibleJobId)) {
        continue;
      }

      let row: ProjectionJobStoredRow;
      try {
        row = decodeProjectionJobStoredRow(raw);
      } catch (error: unknown) {
        if (possibleJobId === null) {
          log(`Skipped malformed persisted job projection with no decodable job id: ${errorMessage(error)}\n`);
        } else {
          log(
            `Skipped malformed persisted job projection with unverified job id ${possibleJobId}: ${errorMessage(error)}; recovery authority could not be decoded, so no terminal or session claim was updated.\n`,
          );
          excluded.add(possibleJobId);
        }
        continue;
      }

      rows.push(row);
    }

    for (const row of rows) {
      try {
        detailsByJob.set(row.job_id, progressStore.loadJobProjectionDetail(row.job_id));
      } catch (error: unknown) {
        excluded.add(row.job_id);
        recordUnresolvedRecovery(row.job_id, 'Persisted job recovery hydration failed', error, coordinatorCommit, {
          status: recoveryStatusFromProjectionRow(row),
          launchCreatedAt: row.created_at,
        });
      }
    }

    return { detailsByJob, excludedJobIds: excluded };
  };

  async function runRecoveryAdoption({
    queuedJobs,
    runningJobs,
    signal,
    coordinatorCommit,
    interruptedAppServerReason,
  }: RecoveryAdoptionContext): Promise<void> {
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
            recordUnresolvedRecovery(
              jobId,
              'Interrupted app-server recovery remains incomplete',
              error,
              coordinatorCommit,
            );
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
            recordUnresolvedRecovery(
              jobId,
              'Interrupted durable recovery remains incomplete',
              error,
              coordinatorCommit,
            );
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
              if ((error as { name?: string } | null)?.name === 'AbortError') {
                try {
                  retainedCleanup?.();
                } finally {
                  maybeReleaseRecoveryRegistry();
                }
                return;
              }
              try {
                recordUnresolvedRecovery(
                  jobId,
                  'Adopted durable recovery finalization failed',
                  error,
                  coordinatorCommit,
                );
                state.recoveryRegistry?.clearCancelled(jobId);
              } finally {
                try {
                  retainedCleanup?.();
                } finally {
                  maybeReleaseRecoveryRegistry();
                }
              }
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
        cleanup?.();
        recordUnresolvedRecovery(jobId, 'Running recovery adoption failed', error, coordinatorCommit);
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
        recordUnresolvedRecovery(jobId, 'Queued recovery adoption failed', error, coordinatorCommit);
      }
    }

    signal.throwIfAborted();
    resetRecoveryState();
    log('Recovery adoption complete. Launch fence lifted.\n');
  }

  return {
    async runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobStore> {
      const { namespace, bundleHash, runtime, progressStore, signal, log, cleanupStaleJobs } = ctx;
      const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
      state.teardownRequested = false;
      runtimeState.setLaunchFenceActive(true);
      const recoveryRegistry = new RecoveryRegistry(runtime.process, state.cancelledRecoveryJobIds);
      state.recoveryRegistry = recoveryRegistry;
      const queuedRecoverable: QueuedRecoverableJob[] = [];
      const runningRecoverable: RunningRecoverableJob[] = [];

      const initialHydration = hydrateRecoveryJobDetails(ctx.coordinatorCommit);
      let adoptedCount = 0;
      try {
        adoptedCount = adoptOrphanedCrossNamespaceJobs(namespace, progressStore, runtime.time.now(), log);
      } catch (error: unknown) {
        log(
          `Cross-namespace adoption could not inspect every persisted job projection: ${errorMessage(error)}; startup recovery will continue with the individually hydrated jobs.\n`,
        );
      }
      if (adoptedCount > 0) {
        log(`Adopted ${adoptedCount} orphaned cross-namespace job(s)\n`);
      }

      const { detailsByJob } = hydrateRecoveryJobDetails(ctx.coordinatorCommit, initialHydration.excludedJobIds);
      const hydratedProgressStore = Object.create(progressStore) as JobStore;
      hydratedProgressStore.listJobIds = () => [...detailsByJob.keys()];
      hydratedProgressStore.loadJobProjectionDetail = (jobId) => {
        const detail = detailsByJob.get(jobId);
        if (detail === undefined) {
          throw new Error(`Recovery snapshot requested job ${jobId} outside the hydrated job set.`);
        }
        return detail;
      };
      const snapshot = buildRecoverySnapshot(hydratedProgressStore, namespace, log, ctx.sessionLookup, runtime.process);
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
            if ((error as { name?: string } | null)?.name === 'AbortError') {
              throw error;
            }
            recordUnresolvedRecovery(
              action.jobId,
              action.type === 'registerQueued'
                ? 'Queued recovery registration failed'
                : 'Running recovery registration failed',
              error,
              ctx.coordinatorCommit,
            );
          }
        }
      };

      for (const action of plan.register) {
        await applyPlanAction(action);
      }
      for (const action of plan.cleanup) {
        await applyPlanAction(action);
      }

      try {
        cleanupStaleJobs(bundleHash);
      } catch (error: unknown) {
        log(`Stale job artifact cleanup did not complete: ${errorMessage(error)}; startup recovery will continue.\n`);
      }

      if (queuedRecoverable.length === 0 && runningRecoverable.length === 0) {
        resetRecoveryState();
        return hydratedProgressStore;
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
      return hydratedProgressStore;
    },
    releaseAdoptedJob,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
