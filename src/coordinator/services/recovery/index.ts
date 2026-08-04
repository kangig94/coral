import { errorMessage, formatError } from '../../../infra/error-format.js';
import { isLivePhase, isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobTerminalInput } from '../../../jobs/records.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { JobStore } from '../../../jobs/store.js';
import { planRecovery } from '../../../jobs/reconcile/plan.js';
import { RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../../../store/append.js';
import {
  applyRecoveryAction,
  finalizeDeadAdoptedJob,
  logRecoveryActionFailure,
  COORDINATOR_CLAIM_RELEASE_OBLIGATION,
  COORDINATOR_NOT_APPLICABLE_FACTS,
  COORDINATOR_TERMINAL_OBLIGATION,
  type QueuedRecoverableJob,
  type RunningRecoverableJob,
} from './actions.js';
import { buildRecoverySnapshot, hydrateCoordinatorRecoveryItem, type CoordinatorRecoveryItem } from './snapshot.js';
import { coordinatorJobRecoverySource, type RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type {
  RecoveryDisposition,
  RecoveryFault,
  RecoveryQuarantinePort,
  RecoveryReport,
  RecoverySettlementFact,
  RecoverySubject,
} from '../../../recovery/containment.js';
import type { RecoveryRetryPolicy, RecoverySourceFactoryPlan } from '../../../recovery/source-registry.js';
import type { Database } from '../../../store/db.js';
import { runCoordinatorJobRecovery } from './startup-recovery.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import { appendJobRecoveryFaultTerminalInCommit } from '../terminal-materializer.js';
import { appendJobTerminalRecorded } from '../../../jobs/terminal/recording.js';
import { elapsedDurationMs } from '../../../jobs/duration.js';
import type { CommitContext } from '../../../store/append.js';
import type { ProviderSession, ClaimedContinuationLease, ClearedContinuationLease } from '../../../sessions/entry.js';
import { sessionContinuationLeaseClearedEvent } from '../../../sessions/continuation-lease-events.js';
import type { SessionClaimReleasedBody } from '../../../sessions/event-bodies.js';
import type { CoralEventInput } from '../../../store/envelope.js';
import { normalizeProviderSession } from '../../../sessions/entry-normalization.js';
import { InterruptedRecoveryCommitError, RecoveryOwnershipReleaseError } from './interrupted-finalizer.js';
import { registerCoordinatorStartupRecovery, type BoundCoordinator } from '../../handoff.js';

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

export type StartupRecoveryContext = {
  namespace: string;
  runtime: Runtime;
  progressStore: JobStore;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason?: InterruptedAppServerReason;
};

export type RunCoordinatorStartupRecoveryFn = (ctx: StartupRecoveryContext) => Promise<JobStore>;

type RecoveryAdoptionContext = {
  queuedJobs: QueuedRecoverableJob[];
  runningJobs: RunningRecoverableJob[];
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
};

type CoordinatorRecoveryControls = {
  report(message: string): void;
  setProcessLocalCleanup(cleanup: () => void): void;
  clearProcessLocalCleanup(): void;
};

type CoordinatorWalkOptions = {
  subjectKey?: string;
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  summary: string;
  settle(
    item: CoordinatorRecoveryItem,
    controls: CoordinatorRecoveryControls,
  ): RecoveryDisposition | Promise<RecoveryDisposition>;
  settleFailure?(
    item: CoordinatorRecoveryItem,
    error: unknown,
    controls: CoordinatorRecoveryControls,
  ): RecoveryDisposition | Promise<RecoveryDisposition>;
};

const coordinatorJobRetryPolicies = new WeakMap<
  Database,
  (
    signal: AbortSignal,
    quarantine: RecoveryQuarantinePort,
  ) => RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>
>();

/** Returns the exact-subject coordinator-job retry plan. */
export function createCoordinatorJobRecoveryRetryPlan(
  db: Database,
  subject: RecoverySubject,
  signal: AbortSignal,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> {
  let resolvedPolicy: RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> | undefined;
  const policy = (): RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> => {
    if (resolvedPolicy === undefined) {
      const createPolicy = coordinatorJobRetryPolicies.get(db);
      if (createPolicy === undefined) throw new Error('Coordinator job recovery retry policy is not initialized.');
      resolvedPolicy = createPolicy(signal, quarantine);
    }
    return resolvedPolicy;
  };
  return {
    source: coordinatorJobRecoverySource(db, { subject }),
    policy: {
      processLocalCleanup: {
        kind: 'boundary-required',
        release: (item) => {
          const cleanup = policy().processLocalCleanup;
          if (cleanup.kind !== 'boundary-required') {
            throw new Error('Coordinator job retry policy lost its cleanup contract.');
          }
          return cleanup.release(item);
        },
      },
      hydrate: (raw) => policy().hydrate(raw),
      requiredObligations: (item) => policy().requiredObligations(item),
      settle: (item) => policy().settle(item),
      onFault: (fault) => policy().onFault(fault),
    },
  };
}

type CoordinatorTerminalSettlement =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'fault'; fault: JobLifecycleFault | JobProgressFault; content: string }>
  | Readonly<{ kind: 'terminal'; terminal: JobTerminalInput }>;

type CoordinatorSettlementOptions = Readonly<{
  jobId: string;
  terminal: CoordinatorTerminalSettlement;
  coordinatorCommit: CommitEventsFn;
  nowMs: number;
  emitSessionReleased(payload: { sessionId: string; jobId: string }): void;
}>;

class CoordinatorRecoveryCommitError extends Error {
  constructor(jobId: string, cause: unknown) {
    super(`Coordinator recovery settlement commit failed for ${jobId}.`, { cause });
    this.name = 'CoordinatorRecoveryCommitError';
  }
}

function clearClaimedContinuationLease(
  lease: ClaimedContinuationLease,
  jobId: string,
  now: string,
): ClearedContinuationLease {
  return {
    staleJobId: lease.staleJobId,
    workflowId: lease.workflowId,
    workflowSlotId: lease.workflowSlotId,
    replacementGeneration: lease.replacementGeneration,
    reason: lease.reason,
    expiresAt: lease.expiresAt,
    recordedAt: lease.recordedAt,
    status: 'cleared',
    resumedJobId: lease.resumedJobId,
    claimedAt: lease.claimedAt,
    clearedAt: now,
    clearedByJobId: jobId,
    outcome: 'resumed_released',
  };
}

function appendSessionClaimRelease<Scope>(
  commit: CommitContext<Scope>,
  session: ProviderSession,
  jobId: string,
  now: string,
): void {
  const { activeJobId: _activeJobId, ...withoutActiveJob } = session;
  const releasedEntry = normalizeProviderSession({
    ...withoutActiveJob,
    lastUsedAt: now,
    version: session.version + 1,
  });
  const releasedEvent: CoralEventInput<SessionClaimReleasedBody> = {
    type: 'session.claim.released',
    stream: { kind: 'session', id: session.sessionId },
    refs: { sessionId: session.sessionId, jobId },
    body: { entry: releasedEntry, jobId },
  };
  commit.append(releasedEvent);

  const lease = session.continuationLease;
  if (lease?.status !== 'claimed' || lease.resumedJobId !== jobId) return;
  const clearedLease = clearClaimedContinuationLease(lease, jobId, now);
  const clearedEntry = normalizeProviderSession({
    ...releasedEntry,
    continuationLease: clearedLease,
    version: releasedEntry.version + 1,
  });
  commit.append(sessionContinuationLeaseClearedEvent(clearedEntry, clearedLease));
}

function settleCoordinatorRecoveryItem(
  item: CoordinatorRecoveryItem,
  options: CoordinatorSettlementOptions,
): readonly RecoverySettlementFact[] {
  const { detail, claimedSession } = item;
  const status = detail?.status.jobId === options.jobId ? detail.status : null;
  const terminalRequired = options.terminal.kind !== 'none' && status !== null && !isTerminalPhase(status.phase);
  const claimRequired = claimedSession?.activeJobId === options.jobId;

  if (terminalRequired || claimRequired) {
    const now = new Date(options.nowMs).toISOString();
    try {
      options.coordinatorCommit((commit) => {
        if (terminalRequired && status !== null) {
          if (options.terminal.kind === 'fault') {
            const launchCreatedAt = detail?.launch?.createdAt;
            const durationMs =
              launchCreatedAt === undefined
                ? options.terminal.fault.kind === 'missing_launch_record'
                  ? 0
                  : (() => {
                      throw new Error(
                        `Cannot record recovery terminal for ${options.jobId} without its launch record.`,
                      );
                    })()
                : elapsedDurationMs(launchCreatedAt, options.nowMs, `job ${options.jobId}`);
            appendJobRecoveryFaultTerminalInCommit(
              commit,
              options.terminal.fault,
              {
                jobId: options.jobId,
                sessionId: status.sessionId,
                namespace: status.backendNamespace,
                project: status.projectRoot,
              },
              { content: options.terminal.content, durationMs },
            );
          } else if (options.terminal.kind === 'terminal') {
            appendJobTerminalRecorded(commit, {
              jobId: options.jobId,
              sessionId: status.sessionId,
              namespace: status.backendNamespace,
              project: status.projectRoot,
              terminal: options.terminal.terminal,
            });
          }
        }
        if (claimRequired && claimedSession !== null) {
          appendSessionClaimRelease(commit, claimedSession, options.jobId, now);
        }
        return undefined;
      });
    } catch (error: unknown) {
      throw new CoordinatorRecoveryCommitError(options.jobId, error);
    }
    if (claimRequired && claimedSession !== null) {
      options.emitSessionReleased({ sessionId: claimedSession.sessionId, jobId: options.jobId });
    }
  }

  return Object.freeze([
    Object.freeze({
      obligation: COORDINATOR_TERMINAL_OBLIGATION,
      outcome: terminalRequired ? ('done' as const) : ('not-applicable' as const),
      ...(terminalRequired ? { authorityRef: `job:${options.jobId}:terminal` } : {}),
    }),
    Object.freeze({
      obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
      outcome: claimRequired ? ('done' as const) : ('not-applicable' as const),
      ...(claimRequired && claimedSession !== null
        ? { authorityRef: `session:${claimedSession.sessionId}:claim:${options.jobId}` }
        : {}),
    }),
  ]);
}

export function createRecoveryCoordinator(
  {
    progressStore,
    runtime,
    runtimeState,
    eventBus,
    getRecoveryService,
    createInvocationContext,
    log,
  }: RecoveryCoordinatorContext,
  bound: BoundCoordinator | null,
): RecoveryCoordinator {
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

  const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);

  const reportCoordinatorRecovery = (
    summary: string,
    report: RecoveryReport<CoordinatorRecoveryItem>,
    messages: readonly string[],
  ): void => {
    try {
      for (const message of messages) log(message);
      if (report.quarantined > 0) {
        log(`${summary}: quarantined ${report.quarantined} item(s); unaffected jobs continued.\n`);
      }
    } catch {
      // Reporting is derived output and never selects the recovery disposition.
    }
  };

  const faultDisposition = (
    fault: RecoveryFault<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>,
  ): RecoveryDisposition => {
    if (fault.stage === 'scan' || fault.error instanceof RecoveryOwnershipReleaseError) {
      return { kind: 'fatal', error: fault.error };
    }
    return {
      kind: 'quarantine',
      detail: `${fault.stage} failed for coordinator job recovery: ${errorMessage(fault.error)}`,
    };
  };

  const createCoordinatorJobRecoveryPolicy = (
    options: CoordinatorWalkOptions,
    messages: string[],
  ): RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> => {
    let processLocalCleanup: (() => void) | null = null;
    return {
      processLocalCleanup: {
        kind: 'boundary-required',
        release: () => {
          try {
            processLocalCleanup?.();
            return { kind: 'released' as const };
          } catch (error: unknown) {
            return { kind: 'incomplete' as const, error };
          } finally {
            processLocalCleanup = null;
          }
        },
      },
      hydrate: (raw) => hydrateCoordinatorRecoveryItem(raw, progressStore),
      requiredObligations: () => [COORDINATOR_TERMINAL_OBLIGATION, COORDINATOR_CLAIM_RELEASE_OBLIGATION],
      settle: async (item) => {
        const controls: CoordinatorRecoveryControls = {
          report: (message: string) => messages.push(message),
          setProcessLocalCleanup: (cleanup: () => void) => {
            processLocalCleanup = cleanup;
          },
          clearProcessLocalCleanup: () => {
            processLocalCleanup = null;
          },
        };
        try {
          return await options.settle(item, controls);
        } catch (error: unknown) {
          if (
            options.signal.aborted ||
            options.settleFailure === undefined ||
            error instanceof CoordinatorRecoveryCommitError ||
            error instanceof InterruptedRecoveryCommitError ||
            error instanceof RecoveryOwnershipReleaseError
          ) {
            throw error;
          }
          return options.settleFailure(item, error, controls);
        }
      },
      onFault: faultDisposition,
    };
  };

  const runCoordinatorWalk = async (
    options: CoordinatorWalkOptions,
  ): Promise<RecoveryReport<CoordinatorRecoveryItem>> => {
    const messages: string[] = [];
    const report = await runCoordinatorJobRecovery({
      source: coordinatorJobRecoverySource(progressStore.getDb(), {
        ...(options.subjectKey === undefined ? {} : { subjectKey: options.subjectKey }),
      }),
      policy: {
        signal: options.signal,
        quarantine,
        ...createCoordinatorJobRecoveryPolicy(options, messages),
      },
    });
    reportCoordinatorRecovery(options.summary, report, messages);
    return report;
  };

  const settleFault = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    fault: JobLifecycleFault | JobProgressFault,
    coordinatorCommit: CommitEventsFn,
    content = '',
  ): readonly RecoverySettlementFact[] =>
    settleCoordinatorRecoveryItem(item, {
      jobId,
      terminal: { kind: 'fault', fault, content },
      coordinatorCommit,
      nowMs: runtime.time.now(),
      emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
    });

  const settleClaim = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    coordinatorCommit: CommitEventsFn,
  ): readonly RecoverySettlementFact[] =>
    settleCoordinatorRecoveryItem(item, {
      jobId,
      terminal: { kind: 'none' },
      coordinatorCommit,
      nowMs: runtime.time.now(),
      emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
    });

  const settleUnexpectedRecoveryFailure = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    summary: string,
    error: unknown,
    coordinatorCommit: CommitEventsFn,
    report: (message: string) => void,
  ): RecoveryDisposition => {
    const facts = settleFault(
      item,
      jobId,
      {
        kind: 'recovery_parse_failed',
        cause: {
          message: `${summary}: ${errorMessage(error)}`,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      },
      coordinatorCommit,
    );
    report(`${summary} for ${jobId}: ${errorMessage(error)}.\n`);
    return { kind: 'advanced', outcome: 'settled', facts, detail: summary };
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
      await runCoordinatorWalk({
        subjectKey: jobId,
        signal,
        coordinatorCommit,
        summary: `Running recovery adoption for ${jobId}`,
        settle: async (item, controls) => {
          controls.setProcessLocalCleanup(() => state.recoveryRegistry?.remove(jobId));
          const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
          if (isAppServerRuntime(runtimeRecord)) {
            signal.throwIfAborted();
            await startTrackedFinalization(jobId, signal, (fence) =>
              service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
                reason: interruptedAppServerReason,
                ...fence,
              }),
            );
            signal.throwIfAborted();
            controls.report(`Recovered interrupted app-server job: ${jobId}\n`);
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts: [
                { obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done', authorityRef: `job:${jobId}:terminal` },
                {
                  obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
                  outcome: item.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
                  ...(item.claimedSession?.activeJobId === jobId
                    ? { authorityRef: `session:${item.claimedSession.sessionId}:claim:${jobId}` }
                    : {}),
                },
              ],
              detail: 'interrupted app-server job finalized',
            };
          }
          if (!isDurableCliRuntime(runtimeRecord)) {
            const facts = settleFault(item, jobId, { kind: 'wrapper_lost' }, coordinatorCommit);
            controls.report(`Skipped adopting unsupported runtime for job: ${jobId}\n`);
            return { kind: 'advanced', outcome: 'settled', facts, detail: 'unsupported runtime finalized' };
          }

          const recovery = boundProvider.recovery;
          let adoptedRuntimeRecord = runtimeRecord;
          const drainRecoveredProgress = (): void => {
            if (!recovery?.extractProgress) return;
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
              controls.report(`Failed to tail recovered progress for job ${jobId}: ${formatError(error)}\n`);
            }
          };

          if (!runtime.process.isAlive(runtimeRecord.pid)) {
            drainRecoveredProgress();
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
            controls.setProcessLocalCleanup(() => {
              state.recoveryRegistry?.remove(jobId);
              state.recoveryRegistry?.clearCancelled(jobId);
            });
            controls.report(`Finalized dead durable recovery job: ${jobId}\n`);
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts: [
                { obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done', authorityRef: `job:${jobId}:terminal` },
                {
                  obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
                  outcome: item.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
                  ...(item.claimedSession?.activeJobId === jobId
                    ? { authorityRef: `session:${item.claimedSession.sessionId}:claim:${jobId}` }
                    : {}),
                },
              ],
              detail: 'dead durable job finalized',
            };
          }

          signal.throwIfAborted();
          const adoption = await service.adoptRunningJob(authority, runtimeRecord);
          if (!adoption.adopted) {
            controls.report(`Rejected running recovery before adoption: ${jobId}\n`);
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts: COORDINATOR_NOT_APPLICABLE_FACTS,
              detail: 'running adoption rejected',
            };
          }
          if (signal.aborted) {
            adoption.cleanup();
            throw signal.reason;
          }

          let cleaned = false;
          const cleanupOnce = (): void => {
            if (cleaned) return;
            cleaned = true;
            adoption.cleanup();
          };
          state.adoptedRunningPids.set(jobId, { pid: runtimeRecord.pid, pool: launchRecord.pool });
          state.adoptedRunningJobCleanups.set(jobId, cleanupOnce);

          const pollInterval = runtime.time.setInterval(() => {
            drainRecoveredProgress();
            if (runtime.process.isAlive(runtimeRecord.pid)) return;

            clearRecoveryPoller(jobId);
            state.adoptedRunningPids.delete(jobId);
            const retainedCleanup = takeAdoptedJobCleanup(jobId);
            if (state.teardownRequested) {
              retainedCleanup?.();
              return;
            }

            drainRecoveredProgress();
            const finalization = startTrackedFinalization(jobId, signal, async (fence) => {
              await runCoordinatorWalk({
                subjectKey: jobId,
                signal,
                coordinatorCommit,
                summary: `Adopted durable recovery finalization for ${jobId}`,
                settle: async (finalItem, finalControls) => {
                  finalControls.setProcessLocalCleanup(() => {
                    state.recoveryRegistry?.clearCancelled(jobId);
                    retainedCleanup?.();
                    maybeReleaseRecoveryRegistry();
                  });
                  await finalizeDeadAdoptedJob({
                    jobId,
                    runtimeRecord: adoptedRuntimeRecord,
                    service,
                    authority,
                    progressStore,
                    cancelledJobIds: state.cancelledRecoveryJobIds,
                    fence,
                  });
                  return {
                    kind: 'advanced',
                    outcome: 'settled',
                    facts: [
                      {
                        obligation: COORDINATOR_TERMINAL_OBLIGATION,
                        outcome: 'done',
                        authorityRef: `job:${jobId}:terminal`,
                      },
                      {
                        obligation: COORDINATOR_CLAIM_RELEASE_OBLIGATION,
                        outcome: finalItem.claimedSession?.activeJobId === jobId ? 'done' : 'not-applicable',
                        ...(finalItem.claimedSession?.activeJobId === jobId
                          ? { authorityRef: `session:${finalItem.claimedSession.sessionId}:claim:${jobId}` }
                          : {}),
                      },
                    ],
                    detail: 'adopted durable job finalized',
                  };
                },
                settleFailure: (item, error, controls) =>
                  settleUnexpectedRecoveryFailure(
                    item,
                    jobId,
                    'Adopted durable recovery finalization failed',
                    error,
                    coordinatorCommit,
                    controls.report,
                  ),
              });
            });
            void finalization.catch((error: unknown) => {
              try {
                log(`Durable finalization cleanup failed for ${jobId}: ${formatError(error)}\n`);
              } catch {
                // Reporting remains best-effort after the async cleanup frame.
              }
              throw error;
            });
          }, RECOVERY_POLL_MS);
          pollInterval.unref?.();
          state.recoveryPollIntervals.set(jobId, pollInterval);
          controls.report(`Adopted running job: ${jobId} (pid=${runtimeRecord.pid})\n`);
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts: COORDINATOR_NOT_APPLICABLE_FACTS,
            detail: 'running job adopted',
          };
        },
        settleFailure: (item, error, controls) =>
          settleUnexpectedRecoveryFailure(
            item,
            jobId,
            'Running recovery adoption failed',
            error,
            coordinatorCommit,
            controls.report,
          ),
      });
    }

    for (const { jobId, authority } of queuedJobs) {
      const { launchRecord } = authority;
      await runCoordinatorWalk({
        subjectKey: jobId,
        signal,
        coordinatorCommit,
        summary: `Queued recovery adoption for ${jobId}`,
        settle: async (item, controls) => {
          controls.setProcessLocalCleanup(() => {
            state.recoveryRegistry?.remove(jobId);
            state.recoveryRegistry?.clearCancelled(jobId);
          });
          const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
          signal.throwIfAborted();
          if (state.cancelledRecoveryJobIds.has(jobId)) {
            const facts = settleCoordinatorRecoveryItem(item, {
              jobId,
              terminal: {
                kind: 'terminal',
                terminal: {
                  content: '',
                  durationMs: elapsedDurationMs(launchRecord.createdAt, runtime.time.now(), `job ${jobId}`),
                  outcome: { kind: 'aborted', reason: 'user_abort' },
                },
              },
              coordinatorCommit,
              nowMs: runtime.time.now(),
              emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
            });
            controls.report(`Aborted queued recovery job: ${jobId}\n`);
            return { kind: 'advanced', outcome: 'settled', facts, detail: 'queued recovery aborted' };
          }
          await service.recoverQueuedJob(authority);
          controls.report(`Recovered queued job: ${jobId}\n`);
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts: COORDINATOR_NOT_APPLICABLE_FACTS,
            detail: 'queued job recovered',
          };
        },
        settleFailure: (item, error, controls) =>
          settleUnexpectedRecoveryFailure(
            item,
            jobId,
            'Queued recovery adoption failed',
            error,
            coordinatorCommit,
            controls.report,
          ),
      });
    }

    signal.throwIfAborted();
    resetRecoveryState();
    log('Recovery adoption complete. Launch fence lifted.\n');
  }

  async function runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobStore> {
    const { namespace, runtime, progressStore, signal } = ctx;
    coordinatorJobRetryPolicies.set(progressStore.getDb(), (retrySignal) =>
      createCoordinatorJobRecoveryPolicy(
        {
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: 'Coordinator job operator retry',
          settle: () => ({
            kind: 'quarantine',
            detail: 'coordinator job requires a fresh recovery reconciliation',
          }),
        },
        [],
      ),
    );
    const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
    state.teardownRequested = false;
    runtimeState.setLaunchFenceActive(true);
    const recoveryRegistry = new RecoveryRegistry(runtime.process, state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];

    let adoptedCount = 0;
    await runCoordinatorWalk({
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      summary: 'Cross-namespace coordinator recovery',
      settle: (item, controls) => {
        const status = item.detail?.status ?? null;
        if (
          status !== null &&
          isLivePhase(status.phase) &&
          item.launchEventNamespace !== null &&
          item.launchEventNamespace !== namespace
        ) {
          const facts = settleFault(item, status.jobId, { kind: 'wrapper_lost' }, ctx.coordinatorCommit);
          adoptedCount += 1;
          controls.report(`Finalized foreign-namespace job ${status.jobId} from ${item.launchEventNamespace}\n`);
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts,
            detail: 'foreign-namespace job finalized',
          };
        }
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'job belongs to the current coordinator namespace',
        };
      },
    });
    if (adoptedCount > 0) {
      reportCoordinatorRecovery(
        'Cross-namespace coordinator recovery',
        { advanced: 0, quarantined: 0, deferred: 0, skipped: 0, receipts: [] },
        [`Adopted ${adoptedCount} orphaned cross-namespace job(s)\n`],
      );
    }

    const recoveryItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      summary: 'Coordinator recovery snapshot hydration',
      settle: (item) => {
        recoveryItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'raw coordinator job hydrated',
        };
      },
    });
    const snapshot = buildRecoverySnapshot(recoveryItems, namespace, runtime.process);
    const plan = planRecovery(snapshot);
    const itemsByJobId = new Map(recoveryItems.map((item) => [item.jobId, item]));
    const itemsBySessionId = new Map(
      recoveryItems.flatMap((item) =>
        item.claimedSession === null ? [] : [[item.claimedSession.sessionId, item] as const],
      ),
    );

    const applyPlanAction = async (action: Parameters<typeof applyRecoveryAction>[0]): Promise<void> => {
      const item =
        itemsByJobId.get(action.jobId) ??
        (action.type === 'releaseSessionClaim' ? itemsBySessionId.get(action.sessionId) : undefined);
      if (item === undefined) {
        throw new Error(`Recovery plan action '${action.type}' has no raw coordinator item for ${action.jobId}.`);
      }
      await runCoordinatorWalk({
        subjectKey: item.jobId,
        signal,
        coordinatorCommit: ctx.coordinatorCommit,
        summary: `Coordinator recovery action ${action.type} for ${action.jobId}`,
        settle: async (freshItem, controls) => {
          let facts: readonly RecoverySettlementFact[];
          try {
            facts = await applyRecoveryAction(action, {
              progressStore,
              recoveryRegistry,
              queuedRecoverable,
              runningRecoverable,
              log: controls.report,
              runtime,
              createInvocationContext,
              getRecoveryService,
              signal,
              settleFault: (fault, content) =>
                settleFault(freshItem, action.jobId, fault, ctx.coordinatorCommit, content),
              settleClaim: (jobId) => settleClaim(freshItem, jobId, ctx.coordinatorCommit),
              setProcessLocalCleanup: controls.setProcessLocalCleanup,
              clearProcessLocalCleanup: controls.clearProcessLocalCleanup,
            });
          } catch (error: unknown) {
            logRecoveryActionFailure(action, error, controls.report);
            throw error;
          }
          return {
            kind: 'advanced',
            outcome: 'settled',
            facts,
            detail: `coordinator recovery action ${action.type} completed`,
          };
        },
        ...(action.type === 'registerQueued' || action.type === 'registerRunning'
          ? {
              settleFailure: (
                freshItem: CoordinatorRecoveryItem,
                error: unknown,
                controls: { report(message: string): void },
              ) =>
                settleUnexpectedRecoveryFailure(
                  freshItem,
                  action.jobId,
                  action.type === 'registerQueued'
                    ? 'Queued recovery registration failed'
                    : 'Running recovery registration failed',
                  error,
                  ctx.coordinatorCommit,
                  controls.report,
                ),
            }
          : {}),
      });
    };

    for (const action of plan.register) {
      await applyPlanAction(action);
    }
    for (const action of plan.cleanup) {
      await applyPlanAction(action);
    }

    if (queuedRecoverable.length === 0 && runningRecoverable.length === 0) {
      resetRecoveryState();
      return progressStore;
    }

    await runRecoveryAdoption({
      queuedJobs: queuedRecoverable,
      runningJobs: runningRecoverable,
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      interruptedAppServerReason,
    });
    return progressStore;
  }

  if (bound !== null) {
    registerCoordinatorStartupRecovery(bound, runStartupRecovery);
  }
  return {
    releaseAdoptedJob,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
