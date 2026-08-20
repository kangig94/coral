import { ZodError } from 'zod';

import { errorMessage, formatError } from '../../../infra/error-format.js';
import { StoreDecodeError } from '../../../store/body-codec.js';
import { ProcessContainmentError } from '../../../infra/process-containment.js';
import { backendLog } from '../../../infra/backend-log.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobTerminalInput } from '../../../jobs/records.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
  readSupersededProviderOperations,
  retireSupersededProviderOperation,
} from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
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
import type { ProviderOperationStartupOwnership } from '../../../jobs/startup.js';

const RECOVERY_POLL_MS = 500;

type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  /** Consecutive ticks whose liveness probe could not answer, per adopted job. Reset by any answer. */
  unansweredAdoptionProbes: Map<string, number>;
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
  providerOperationRecoveries: Map<string, Promise<ProviderOperationRecoveryAcceptance>>;
  teardownRequested: boolean;
};

export type ProviderOperationRecoveryAcceptance = Readonly<{
  state: 'accepted';
  jobId: string;
  owner: 'recovery-coordinator';
}>;

export interface RecoveryCoordinator {
  retireAbsentSupersededProviderOperations(): void;
  snapshotProviderOperationStartupOwnership(): ProviderOperationStartupOwnership;
  recoverProviderOperationJob(
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecoveryAcceptance>;
  completeProviderOperationJobRecovery(jobId: string): void;
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
  runtime: Runtime;
  progressStore: JobStore;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  coordinatorCommit: CommitEventsFn;
  providerOperationStartupOwnership: ProviderOperationStartupOwnership;
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

/** How many consecutive unanswerable probes before an adopted job's stuck liveness is reported once. */
const UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD = 10;

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
    unansweredAdoptionProbes: new Map<string, number>(),
    recoveryPollIntervals: new Map<string, TimerHandle>(),
    adoptedRunningJobCleanups: new Map<string, () => void>(),
    inflightFinalizations: new Map(),
    providerOperationRecoveries: new Map<string, Promise<ProviderOperationRecoveryAcceptance>>(),
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
    state.providerOperationRecoveries.clear();
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

  /**
   * A record this build cannot read is not a job that failed. The provider process and its session
   * outlive the coordinator on purpose — adoption exists so a wrapper lost across a restart or an
   * upgrade reattaches instead of destroying the work it was supervising. When two builds disagree
   * about a durable shape, the honest answer is that this coordinator cannot speak for the subject,
   * which is what the quarantine boundary already holds. Terminalizing instead spends the provider's
   * work to settle a question about our own schema.
   */
  const isUninterpretableRecord = (error: unknown): boolean =>
    error instanceof StoreDecodeError || error instanceof ZodError;

  const settleUnexpectedRecoveryFailure = (
    item: CoordinatorRecoveryItem,
    jobId: string,
    summary: string,
    error: unknown,
    coordinatorCommit: CommitEventsFn,
    report: (message: string) => void,
  ): RecoveryDisposition => {
    if (isUninterpretableRecord(error)) {
      report(`${summary} for ${jobId}: ${errorMessage(error)}. Left for a build that can read it.\n`);
      return { kind: 'quarantine', detail: `${summary}: record unreadable by this build` };
    }

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

  const recoverQueuedItem = async (
    item: CoordinatorRecoveryItem,
    { jobId, authority }: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    controls: CoordinatorRecoveryControls,
  ): Promise<RecoveryDisposition> => {
    const { launchRecord } = authority;
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
  };

  const acceptQueuedRecovery = async (
    job: QueuedRecoverableJob,
    signal: AbortSignal,
    coordinatorCommit: CommitEventsFn,
    failureMode: 'settle' | 'retry',
  ): Promise<void> => {
    const { jobId } = job;
    let acceptanceError: Error | null = null;
    await runCoordinatorWalk({
      subjectKey: jobId,
      signal,
      coordinatorCommit,
      summary: `Queued recovery adoption for ${jobId}`,
      settle: async (item, controls) => {
        try {
          return await recoverQueuedItem(item, job, signal, coordinatorCommit, controls);
        } catch (error: unknown) {
          acceptanceError = error instanceof Error ? error : new Error(errorMessage(error));
          throw acceptanceError;
        }
      },
      ...(failureMode === 'settle'
        ? {
            settleFailure: (item: CoordinatorRecoveryItem, error: unknown, controls: CoordinatorRecoveryControls) =>
              settleUnexpectedRecoveryFailure(
                item,
                jobId,
                'Queued recovery adoption failed',
                error,
                coordinatorCommit,
                controls.report,
              ),
          }
        : {}),
    });
    if (failureMode === 'retry' && acceptanceError !== null) {
      throw new Error(errorMessage(acceptanceError));
    }
  };

  async function runRecoveryAdoption(
    { queuedJobs, runningJobs, signal, coordinatorCommit, interruptedAppServerReason }: RecoveryAdoptionContext,
    direct?: Readonly<{ item: CoordinatorRecoveryItem; controls: CoordinatorRecoveryControls }>,
  ): Promise<RecoveryDisposition | void> {
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
      const settleRunningRecovery = async (
        item: CoordinatorRecoveryItem,
        controls: CoordinatorRecoveryControls,
      ): Promise<RecoveryDisposition> => {
        controls.setProcessLocalCleanup(() => state.recoveryRegistry?.remove(jobId));
        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        if (isAppServerRuntime(runtimeRecord)) {
          signal.throwIfAborted();
          try {
            await startTrackedFinalization(jobId, signal, (fence) =>
              service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
                reason: interruptedAppServerReason,
                ...fence,
              }),
            );
          } catch (error: unknown) {
            // Carrier-detached recovery could not confirm its committed provider proxy set is gone within
            // budget. That is honestly fatal for this job alone: finalizing anyway risks a second local
            // kernel racing a carrier that may still be live, so this job is quarantined nonterminal rather
            // than settled — unaffected jobs continue, and a later boot retries once the recorded
            // saga row changes (see `coordinatorJobRecoverySubject`'s revision).
            if (error instanceof ProcessContainmentError) {
              controls.report(
                `Carrier reap unconfirmed for interrupted app-server job: ${jobId}: ${errorMessage(error)}\n`,
              );
              return { kind: 'quarantine', detail: error.message };
            }
            throw error;
          }
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

        // Only an observed absence finalizes.
        if (runtime.process.observeLiveness(runtimeRecord.pid) === 'absent') {
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
          // Only an observed absence finalizes. Unknown re-asks — but silently re-asking forever is how an
          // adoption never settles, so a run of them is reported once and the job stays visibly adopted
          // rather than quietly stuck.
          const liveness = runtime.process.observeLiveness(runtimeRecord.pid);
          if (liveness === 'unknown') {
            const unanswered = (state.unansweredAdoptionProbes.get(jobId) ?? 0) + 1;
            state.unansweredAdoptionProbes.set(jobId, unanswered);
            if (unanswered === UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD) {
              // Not `controls.report`: that appends to the recovery walk's own message array, which is
              // flushed once at the end of startup — long before ten poll ticks. The report would never have
              // been seen, which is exactly the silence this counter exists to break.
              backendLog.warn(
                `Liveness of adopted job ${jobId} (pid ${runtimeRecord.pid}) has been unobservable for ` +
                  `${unanswered} checks; it stays adopted until a probe answers.`,
              );
            }
            return;
          }
          state.unansweredAdoptionProbes.delete(jobId);
          if (liveness === 'alive') return;

          clearRecoveryPoller(jobId);
          state.adoptedRunningPids.delete(jobId);
          state.unansweredAdoptionProbes.delete(jobId);
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
      };
      if (direct?.item.jobId === jobId) {
        return settleRunningRecovery(direct.item, direct.controls);
      }
      await runCoordinatorWalk({
        subjectKey: jobId,
        signal,
        coordinatorCommit,
        summary: `Running recovery adoption for ${jobId}`,
        settle: settleRunningRecovery,
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

    for (const job of queuedJobs) {
      await acceptQueuedRecovery(job, signal, coordinatorCommit, 'settle');
    }

    signal.throwIfAborted();
  }

  type PlanActionOptions = Readonly<{
    itemsByJobId: ReadonlyMap<string, CoordinatorRecoveryItem>;
    itemsBySessionId: ReadonlyMap<string, CoordinatorRecoveryItem>;
    recoveryRegistry: RecoveryRegistry;
    queuedRecoverable: QueuedRecoverableJob[];
    runningRecoverable: RunningRecoverableJob[];
    signal: AbortSignal;
    coordinatorCommit: CommitEventsFn;
  }>;

  const applyActionToItem = async (
    action: Parameters<typeof applyRecoveryAction>[0],
    item: CoordinatorRecoveryItem,
    controls: CoordinatorRecoveryControls,
    options: PlanActionOptions,
  ): Promise<RecoveryDisposition> => {
    try {
      return await applyRecoveryAction(action, {
        progressStore,
        recoveryRegistry: options.recoveryRegistry,
        queuedRecoverable: options.queuedRecoverable,
        runningRecoverable: options.runningRecoverable,
        log: controls.report,
        runtime,
        createInvocationContext,
        getRecoveryService,
        signal: options.signal,
        settleFault: (fault, content) => settleFault(item, action.jobId, fault, options.coordinatorCommit, content),
        settleClaim: (jobId) => settleClaim(item, jobId, options.coordinatorCommit),
        setProcessLocalCleanup: controls.setProcessLocalCleanup,
        clearProcessLocalCleanup: controls.clearProcessLocalCleanup,
      });
    } catch (error: unknown) {
      logRecoveryActionFailure(action, error, controls.report);
      throw error;
    }
  };

  const applyPlanAction = async (
    action: Parameters<typeof applyRecoveryAction>[0],
    options: PlanActionOptions,
  ): Promise<void> => {
    const item =
      options.itemsByJobId.get(action.jobId) ??
      (action.type === 'releaseSessionClaim' ? options.itemsBySessionId.get(action.sessionId) : undefined);
    if (item === undefined) {
      throw new Error(`Recovery plan action '${action.type}' has no raw coordinator item for ${action.jobId}.`);
    }
    await runCoordinatorWalk({
      subjectKey: item.jobId,
      signal: options.signal,
      coordinatorCommit: options.coordinatorCommit,
      summary: `Coordinator recovery action ${action.type} for ${action.jobId}`,
      settle: (freshItem, controls) => applyActionToItem(action, freshItem, controls, options),
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
                options.coordinatorCommit,
                controls.report,
              ),
          }
        : {}),
    });
  };

  const recoverProviderOperationJobOnce = async (
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecoveryAcceptance> => {
    const jobId = record.operation.jobId;
    const coordinatorCommit: CommitEventsFn = (callback) => progressStore.commit(callback);
    const freshItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      subjectKey: jobId,
      signal,
      coordinatorCommit,
      summary: `Provider operation exact-job recovery hydration for ${jobId}`,
      settle: (item) => {
        freshItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'provider operation recovery job hydrated',
        };
      },
    });
    const item = freshItems[0];
    if (item === undefined) {
      throw new Error(`Provider operation recovery job '${jobId}' is absent from the coordinator journal.`);
    }

    const plan = planRecovery(buildRecoverySnapshot([item], runtime.process));
    const recoveryRegistry =
      state.recoveryRegistry ?? new RecoveryRegistry(runtime.process, state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];
    const planActionOptions = {
      itemsByJobId: new Map([[item.jobId, item]]),
      itemsBySessionId: new Map(item.claimedSession === null ? [] : ([[item.claimedSession.sessionId, item]] as const)),
      recoveryRegistry,
      queuedRecoverable,
      runningRecoverable,
      signal,
      coordinatorCommit,
    } as const;

    for (const action of plan.register) {
      if (action.jobId === jobId) await applyPlanAction(action, planActionOptions);
    }
    for (const action of plan.cleanup) {
      if (action.jobId === jobId) await applyPlanAction(action, planActionOptions);
    }

    if (runningRecoverable.length > 0) {
      await runRecoveryAdoption({
        queuedJobs: [],
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit,
        interruptedAppServerReason: 'restart',
      });
    }
    for (const queued of queuedRecoverable) {
      progressStore.seedEnqueueSequence(queued.authority.launchRecord.enqueueSequence);
      await acceptQueuedRecovery(queued, signal, coordinatorCommit, 'retry');
    }
    maybeReleaseRecoveryRegistry();
    return { state: 'accepted', jobId, owner: 'recovery-coordinator' };
  };

  const recoverProviderOperationJob = (
    record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>,
    signal: AbortSignal,
  ): Promise<ProviderOperationRecoveryAcceptance> => {
    const jobId = record.operation.jobId;
    const existing = state.providerOperationRecoveries.get(jobId);
    if (existing !== undefined) return existing;

    const recovery = recoverProviderOperationJobOnce(record, signal).catch((error: unknown) => {
      if (state.providerOperationRecoveries.get(jobId) === recovery) {
        state.providerOperationRecoveries.delete(jobId);
      }
      throw error;
    });
    state.providerOperationRecoveries.set(jobId, recovery);
    return recovery;
  };

  const completeProviderOperationJobRecovery = (jobId: string): void => {
    state.providerOperationRecoveries.delete(jobId);
  };

  /**
   * Retires the superseded rows whose processes are all gone, before the fence is computed from what is left.
   *
   * The fence keeps a job this build cannot read away from generic recovery, which is what stops an
   * undecodable row from turning a stalled operation into a failed startup. But a fence with nothing behind it
   * is a job that never settles: nothing decodes the row, so nothing terminalizes it, and it stays live in
   * `jobs` and unending under `wait` for as long as the store exists. That is the cost of the fence, and this
   * is what pays it.
   *
   * A dead process target is dead regardless of which generation recorded it, and that is the one observation
   * available here. Every retained generation carries the same three process locators and containment group,
   * so the signalable targets are readable without trusting anything whose meaning changed. If **none** of
   * them is alive the set is gone, the row is removed, and the job reaches ordinary recovery and is interrupted
   * like any other — this build never has to interpret a shape it cannot read, only to stop claiming a set that
   * no longer exists.
   *
   * **Never signal.** These processes belong to a build this one has no authority over; their pids may only be
   * observed. Anything short of "all absent" — one target alive, a row that cannot be walked, or a row naming
   * no signalable target — keeps the fence, because absence is the sole conclusion this path may draw.
   */
  const retireAbsentSupersededProviderOperations = (): void => {
    for (const row of readSupersededProviderOperations(progressStore.getDb())) {
      if (row.processTargets === null || row.processTargets.length === 0) continue;
      // Every target observed absent, and nothing short of it: an unanswerable probe did not observe absence,
      // so the row keeps its fence and the next boot asks again.
      if (!row.processTargets.every((target) => runtime.process.observeLiveness(target) === 'absent')) continue;
      retireSupersededProviderOperation(progressStore.getDb(), row.key);
      backendLog.warn(
        `Retired a provider operation record this build cannot read whose processes are all absent: ${row.key}`,
      );
    }
  };

  const snapshotProviderOperationStartupOwnership = (): ProviderOperationStartupOwnership => {
    const scan = readProviderOperations(progressStore.getDb());
    // A row this build cannot read still names a job the provider saga owns. Fencing only the decoded ones
    // hands that job to generic recovery, which then does a keyed strict read of the same row and throws —
    // turning a stalled operation back into a failed startup.
    //
    // Both names, not just the key's. `decodeCanonicalValue` rejects a row whose payload identity disagrees
    // with its key, so those are exactly the rows where the two differ — fencing the key's job alone would
    // hand the payload's job to generic recovery, which can terminalize it while its operation is live. This
    // is the sibling of the proxy-set fence in `provider-proxy-set/inheritance.ts`.
    const attributions = attributeUnreadableProviderOperations(progressStore.getDb(), scan.unreadableKeys);
    const unreadableJobIds = attributions.flatMap((attribution) =>
      attribution.jobs.kind === 'known' ? attribution.jobs.values : [],
    );
    return Object.freeze({
      jobIds: Object.freeze([
        ...new Set([...scan.records.map((record) => record.operation.jobId), ...unreadableJobIds]),
      ]),
    });
  };

  async function runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobStore> {
    const { runtime, progressStore, signal } = ctx;
    const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
    state.teardownRequested = false;
    runtimeState.setLaunchFenceActive(true);
    const recoveryRegistry = new RecoveryRegistry(runtime.process, state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];
    coordinatorJobRetryPolicies.set(progressStore.getDb(), (retrySignal) =>
      createCoordinatorJobRecoveryPolicy(
        {
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: 'Coordinator job operator retry',
          settle: async (item, controls) => {
            const retryQueued: QueuedRecoverableJob[] = [];
            const retryRunning: RunningRecoverableJob[] = [];
            const retryOptions: PlanActionOptions = {
              itemsByJobId: new Map([[item.jobId, item]]),
              itemsBySessionId: new Map(
                item.claimedSession === null ? [] : ([[item.claimedSession.sessionId, item]] as const),
              ),
              recoveryRegistry,
              queuedRecoverable: retryQueued,
              runningRecoverable: retryRunning,
              signal: retrySignal,
              coordinatorCommit: ctx.coordinatorCommit,
            };
            const retryPlan = planRecovery(buildRecoverySnapshot([item], runtime.process));
            let facts: readonly RecoverySettlementFact[] = [];
            for (const action of [...retryPlan.register, ...retryPlan.cleanup]) {
              if (action.jobId !== item.jobId) continue;
              const disposition = await applyActionToItem(action, item, controls, retryOptions);
              if (disposition.kind !== 'advanced') return disposition;
              facts = [...facts, ...disposition.facts];
            }
            const runningDisposition = await runRecoveryAdoption(
              {
                queuedJobs: [],
                runningJobs: retryRunning,
                signal: retrySignal,
                coordinatorCommit: ctx.coordinatorCommit,
                interruptedAppServerReason,
              },
              { item, controls },
            );
            if (runningDisposition !== undefined) return runningDisposition;
            const queued = retryQueued[0];
            if (queued !== undefined) {
              return recoverQueuedItem(item, queued, retrySignal, ctx.coordinatorCommit, controls);
            }
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts,
              detail: 'coordinator job retry reconciled',
            };
          },
        },
        [],
      ),
    );
    const sagaOwnedJobIds = new Set(ctx.providerOperationStartupOwnership.jobIds);

    const recoveryItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      summary: 'Coordinator recovery snapshot hydration',
      settle: (item) => {
        if (!sagaOwnedJobIds.has(item.jobId)) recoveryItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'raw coordinator job hydrated',
        };
      },
    });
    const snapshot = buildRecoverySnapshot(recoveryItems, runtime.process);
    const plan = planRecovery(snapshot);
    const itemsByJobId = new Map(recoveryItems.map((item) => [item.jobId, item]));
    const itemsBySessionId = new Map(
      recoveryItems.flatMap((item) =>
        item.claimedSession === null ? [] : [[item.claimedSession.sessionId, item] as const],
      ),
    );

    const planActionOptions = {
      itemsByJobId,
      itemsBySessionId,
      recoveryRegistry,
      queuedRecoverable,
      runningRecoverable,
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
    } as const;

    for (const action of plan.register) {
      await applyPlanAction(action, planActionOptions);
    }
    for (const action of plan.cleanup) {
      await applyPlanAction(action, planActionOptions);
    }

    if (queuedRecoverable.length > 0 || runningRecoverable.length > 0) {
      await runRecoveryAdoption({
        queuedJobs: queuedRecoverable,
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit: ctx.coordinatorCommit,
        interruptedAppServerReason,
      });
    }
    const localRecoveryRecords = readProviderOperations(progressStore.getDb()).records.filter(
      (record): record is Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }> =>
        record.phase === 'local-recovery-pending',
    );
    for (const record of localRecoveryRecords) {
      try {
        await recoverProviderOperationJob(record, signal);
      } catch (error: unknown) {
        log(`Provider operation exact-job recovery failed for ${record.operation.jobId}: ${formatError(error)}\n`);
      }
    }
    signal.throwIfAborted();
    resetRecoveryState();
    log('Recovery adoption complete. Launch fence lifted.\n');
    return progressStore;
  }

  if (bound !== null) {
    registerCoordinatorStartupRecovery(bound, runStartupRecovery);
  }
  return {
    retireAbsentSupersededProviderOperations,
    snapshotProviderOperationStartupOwnership,
    recoverProviderOperationJob,
    completeProviderOperationJobRecovery,
    releaseAdoptedJob,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
