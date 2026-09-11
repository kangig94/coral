import { ZodError } from 'zod';

import { errorMessage, formatError } from '../../../infra/error-format.js';
import { StoreDecodeError } from '../../../store/body-codec.js';
import { observeRecordedContainment, type RecordedContainmentObservation } from '../../../infra/process-containment.js';
import { backendLog } from '../../../infra/backend-log.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import type { JobTerminalInput } from '../../../jobs/records.js';
import type { UnreadableProviderOperationAttribution } from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type { JobAdmissionPort, JobLaunchRecoveryPort } from '../../../jobs/contracts/admission.js';
import type {
  ProviderOperationBindingPort,
  SettledUnboundStatusAbsence,
  SettledUnboundStatusHydrationPort,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import { isDurableCliRuntime } from '../../../runtime/durable-runtime.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { JobStore } from '../../../jobs/store.js';
import { planRecovery } from '../../../jobs/reconcile/plan.js';
import { RecoveryRegistry, type RecoveryAbortDisposition } from '../../../jobs/reconcile/registry.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { InterruptedAppServerReason } from '../../../jobs/reconcile/interrupted-reason.js';
import type { CommitEventsFn } from '../../../store/append.js';
import {
  applyRecoveryAction,
  durableOwnershipEvidenceHoldReason,
  logRecoveryActionFailure,
  reapDurableCliProcess,
  COORDINATOR_CLAIM_RELEASE_OBLIGATION,
  COORDINATOR_NOT_APPLICABLE_FACTS,
  COORDINATOR_TERMINAL_OBLIGATION,
  type QueuedRecoverableJob,
  type RunningRecoverableJob,
} from './actions.js';
import { buildRecoverySnapshot, hydrateCoordinatorRecoveryItem, type CoordinatorRecoveryItem } from './snapshot.js';
import { coordinatorJobRecoverySource, type RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import {
  unreadableProviderOperationRecoverySource,
  type RawUnreadableProviderOperationRecoveryRow,
} from './unreadable-provider-operation-recovery-source.js';
import {
  settledUnboundStatusRecoverySource,
  type RawSettledUnboundStatusRecovery,
} from './settled-unbound-status-recovery-source.js';
import { settledUnboundStatusDetail } from './settled-unbound-status.js';
import { unreadableProviderOperationSubject } from '../../../recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type {
  RecoveryDisposition,
  RecoveryFault,
  RecoveryObligationId,
  RecoveryQuarantinePort,
  RecoveryReport,
  RecoverySettlementFact,
  RecoverySubject,
  RecoveryQuarantineWrite,
} from '../../../recovery/containment.js';
import { RecoveryContainment } from '../../../recovery/containment.js';
import {
  COORDINATOR_JOB_RECOVERY_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryRetryPolicy,
  type RecoverySourceFactoryPlan,
} from '../../../recovery/source-registry.js';
import { withImmediate, type Database } from '../../../store/db.js';
import { runCoordinatorJobRecovery } from './startup-recovery.js';
import { createRecoveryAdoption, type CoordinatorRecoveryControls } from './adoption.js';
import {
  createProviderOperationStartupOwnership,
  providerOperationStartupIdentityKey,
  type ProviderOperationStartupRelease,
  type ProviderOperationStartupSnapshot,
  type SupersededProviderOperationRetirementSummary,
  type UnreadableProviderOperationStartupResolution,
} from './provider-operation-startup-ownership.js';
import type { JobLifecycleFault, JobProgressFault } from '../../../jobs/outcome.js';
import type { SettlementRefusalRecorder } from '../../../jobs/contracts/admission.js';
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
import type {
  JobsStartupRecoveryDisposition,
  ProviderOperationStartupHold,
  ProviderOperationStartupOwnership,
  ProviderOperationStartupRecordOwnership,
} from '../../../jobs/startup.js';
import {
  listDurableCliContainmentStatuses,
  readDurableCliContainmentStatus,
  readDurableCliPreReadyOwnershipEvidence,
  readDurableCliProcessRuntimeEvidence,
  writeDurableCliContainmentStatus,
} from '../../../jobs/runtime-meta-store.js';
import type { DurableCliContainmentStatus } from '../../../jobs/runtime-meta.js';
import type { DurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';

/** Abandonment must be able to abort a destructive reap and wait for it, not merely ignore its result. */
type HeldRecoveryReapAttempt = Readonly<{ abort: AbortController; settlement: Promise<void> }>;

type RecoveryCoordinatorState = {
  recoveryRegistry: RecoveryRegistry | null;
  cancelledRecoveryJobIds: Set<string>;
  adoptedRunningPids: Map<string, { pid: number; pool: string }>;
  /** Consecutive ticks whose liveness probe could not answer, per adopted job. Reset by any answer. */
  unansweredAdoptionProbes: Map<string, number>;
  recoveryPollIntervals: Map<string, TimerHandle>;
  heldRecoveryReapGenerations: Map<string, number>;
  heldRecoveryReapAttempts: Map<string, HeldRecoveryReapAttempt>;
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
  teardownState:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'in-flight'; settlement: Promise<void> }>
    | Readonly<{ kind: 'settled' }>;
};

export type ProviderOperationRecoveryAcceptance = Readonly<{
  state: 'accepted';
  jobId: string;
  owner: 'recovery-coordinator';
}>;

export interface RecoveryCoordinator {
  retireAbsentSupersededProviderOperations(): SupersededProviderOperationRetirementSummary;
  snapshotProviderOperationStartupOwnership(): ProviderOperationStartupSnapshot;
  hydrateProviderOperationStartupOwnership(
    snapshot: ProviderOperationStartupSnapshot,
  ): ProviderOperationStartupOwnership;
  adoptRepairedProviderOperationOwnership(
    record: ProviderOperationRecord,
    recordKey?: string,
  ): ProviderOperationStartupRecordOwnership;
  releaseProviderOperationStartupOwnership(
    operation: ProviderOperationRecord['operation'],
  ): ProviderOperationStartupRelease;
  releaseUnreadableProviderOperationStartupOwnership(recordKey: string): UnreadableProviderOperationStartupResolution;
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
  startupOwnership: Pick<
    JobLaunchRecoveryPort,
    'restoreActiveLaunch' | 'holdUndecidedProviderOperationLaunch' | 'reclaimLaunchPermit'
  > &
    Pick<JobAdmissionPort, 'releaseLaunch'> &
    ProviderOperationBindingPort &
    SettledUnboundStatusHydrationPort;
};

export type StartupRecoveryContext = {
  runtime: Runtime;
  progressStore: JobStore;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  signal: AbortSignal;
  log: (message: string) => void;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason?: InterruptedAppServerReason;
};

export type RunCoordinatorStartupRecoveryFn = (ctx: StartupRecoveryContext) => Promise<JobsStartupRecoveryDisposition>;

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

const REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION = 'repaired-provider-operation-adoption' as RecoveryObligationId;

export type RepairedProviderOperationAdoption =
  | Readonly<{ kind: 'accepted'; owner: 'provider-operation-reconciler' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export type UnreadableProviderOperationQuarantineReport = Readonly<{
  materialized: number;
  retained: number;
  failed: readonly Readonly<{ key: string; error: string }>[];
}>;

export async function quarantineUnreadableProviderOperations(
  quarantine: RecoveryQuarantinePort,
  rows: readonly UnreadableProviderOperationAttribution[],
): Promise<UnreadableProviderOperationQuarantineReport> {
  let materialized = 0;
  let retained = 0;
  const failed: { key: string; error: string }[] = [];

  for (const row of rows) {
    const subject = unreadableProviderOperationSubject(row.key, row.revision);
    const write = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject,
      state: 'active' as const,
      stage: 'hydrate' as const,
      errorMessage: 'Provider operation row is unreadable by this build.',
      detail: 'Repair or remove the raw provider operation row, then retry this exact quarantine coordinate.',
    };
    let persisted = false;
    let writeFailure: unknown = null;
    try {
      persisted = await quarantine.upsert(write);
    } catch (error: unknown) {
      writeFailure = error;
    }
    if (persisted) {
      materialized += 1;
      continue;
    }

    try {
      const current = await quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, row.key);
      if (current !== null) {
        retained += 1;
        continue;
      }
    } catch (error: unknown) {
      failed.push({ key: row.key, error: errorMessage(error) });
      continue;
    }

    const failureDetail = writeFailure === null ? 'the quarantine write did not persist' : errorMessage(writeFailure);
    try {
      persisted = await quarantine.upsert({
        ...write,
        errorMessage: 'Provider operation quarantine materialization failed during startup.',
        detail: `${failureDetail}. The raw row remains unreadable; repair or remove it, then retry this exact coordinate.`,
      });
    } catch (error: unknown) {
      failed.push({ key: row.key, error: `${failureDetail}; durable status retry failed: ${errorMessage(error)}` });
      continue;
    }
    if (persisted) {
      materialized += 1;
    } else {
      failed.push({ key: row.key, error: `${failureDetail}; durable status retry did not persist` });
    }
  }

  return Object.freeze({ materialized, retained, failed: Object.freeze(failed) });
}

export function createUnreadableProviderOperationRetryPlan(
  db: Database,
  subject: RecoverySubject,
  adopt: (
    record: ProviderOperationRecord,
    recordKey: string,
  ) => RepairedProviderOperationAdoption | Promise<RepairedProviderOperationAdoption>,
): RecoverySourceFactoryPlan<RawUnreadableProviderOperationRecoveryRow, RawUnreadableProviderOperationRecoveryRow> {
  return {
    source: unreadableProviderOperationRecoverySource(db, subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => raw,
      requiredObligations: (item) =>
        item.kind === 'readable' ? [REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION] : [],
      settle: async (item) => {
        if (item.kind === 'unreadable') {
          return {
            kind: 'quarantine',
            detail: `Provider operation row ${item.key} remains unreadable at revision ${item.currentRevision}.`,
          };
        }

        const adoption = await adopt(item.record, item.key);
        if (adoption.kind === 'refused') {
          return {
            kind: 'quarantine',
            detail:
              `Provider operation row ${item.key} is readable, but this coordinator did not accept ownership: ` +
              `${adoption.reason}. Restart the coordinator to initialize the repaired row at boot, then retry this coordinate.`,
          };
        }
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: [
            {
              obligation: REPAIRED_PROVIDER_OPERATION_ADOPTION_OBLIGATION,
              outcome: 'done',
              authorityRef: adoption.owner,
            },
          ],
          detail: `Provider operation row ${item.key} was accepted by ${adoption.owner}.`,
        };
      },
      onFault: (fault) => ({
        kind: 'quarantine',
        detail: `Provider operation unreadable-row retry failed during ${fault.stage}.`,
      }),
    },
  };
}

export function createSettledUnboundStatusRetryPlan(
  db: Database,
  subject: RecoverySubject,
  quarantine: RecoveryQuarantinePort,
  releaseAbsent: (absence: SettledUnboundStatusAbsence) => boolean,
): RecoverySourceFactoryPlan<RawSettledUnboundStatusRecovery, RawSettledUnboundStatusRecovery> {
  return {
    source: settledUnboundStatusRecoverySource(db, subject),
    policy: {
      processLocalCleanup: {
        kind: 'boundary-required',
        release: async (item) => {
          if (item.kind === 'present') return { kind: 'released' };
          const retained = await quarantine.read(item.subject.boundary, item.subject.key);
          if (retained !== null || releaseAbsent(item.absence)) return { kind: 'released' };
          return {
            kind: 'incomplete',
            error: new Error('The rehydrated settled-unbound ownership could not be released.'),
          };
        },
      },
      hydrate: (raw) => raw,
      requiredObligations: () => [],
      settle: (item) =>
        item.kind === 'absent'
          ? {
              kind: 'advanced',
              outcome: 'settled',
              facts: [],
              detail: 'The exact provider-operation identity is absent from the journal.',
            }
          : {
              kind: 'quarantine',
              detail: settledUnboundStatusDetail(item.recordKeys, null),
            },
      onFault: (fault) => ({
        kind: 'quarantine',
        detail: settledUnboundStatusDetail(null, errorMessage(fault.error)),
      }),
    },
  };
}

const coordinatorJobRetryPolicies = new WeakMap<
  Database,
  (
    signal: AbortSignal,
    quarantine: RecoveryQuarantinePort,
  ) => RecoveryRetryPolicy<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem>
>();

export function createCoordinatorJobSettlementRefusalRecorder(
  deps: Readonly<{
    getDb(): Database;
    isBoundaryRegistered(boundary: string): boolean;
    upsert(write: RecoveryQuarantineWrite): boolean;
  }>,
): SettlementRefusalRecorder {
  const untrackedQuarantine: RecoveryQuarantinePort = {
    read: () => null,
    upsert: () => false,
    delete: () => false,
  };

  return {
    async record(input): Promise<boolean> {
      if (!deps.isBoundaryRegistered(COORDINATOR_JOB_RECOVERY_BOUNDARY)) {
        throw new Error(`${COORDINATOR_JOB_RECOVERY_BOUNDARY} is not registered.`);
      }

      const report = await RecoveryContainment.each(
        coordinatorJobRecoverySource(deps.getDb(), { subjectKey: input.jobId }),
        {
          signal: new AbortController().signal,
          quarantine: untrackedQuarantine,
          processLocalCleanup: { kind: 'not-required' },
          hydrate: (raw) => raw,
          requiredObligations: () => [],
          settle: (raw) => {
            const recorded = deps.upsert({
              boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY,
              subject: raw.subject,
              state: 'active',
              stage: 'settle',
              errorMessage: input.failure,
              detail: `Job settlement refused after ${input.cause}.`,
            });
            if (!recorded) throw new Error('The recovery quarantine write did not persist.');
            return {
              kind: 'advanced',
              outcome: 'settled',
              facts: [],
              detail: 'Job settlement refusal was recorded for recovery.',
            };
          },
          onFault: (fault) => ({ kind: 'fatal', error: fault.error }),
        },
      );
      return report.advanced === 1;
    },
  };
}

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
    startupOwnership,
  }: RecoveryCoordinatorContext,
  bound: BoundCoordinator | null,
): RecoveryCoordinator {
  const state: RecoveryCoordinatorState = {
    recoveryRegistry: null,
    cancelledRecoveryJobIds: new Set<string>(),
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    unansweredAdoptionProbes: new Map<string, number>(),
    recoveryPollIntervals: new Map<string, TimerHandle>(),
    heldRecoveryReapGenerations: new Map<string, number>(),
    heldRecoveryReapAttempts: new Map(),
    adoptedRunningJobCleanups: new Map<string, () => void>(),
    inflightFinalizations: new Map(),
    providerOperationRecoveries: new Map<string, Promise<ProviderOperationRecoveryAcceptance>>(),
    teardownRequested: false,
    teardownState: { kind: 'pending' },
  };

  const providerOperationStartupOwnership = createProviderOperationStartupOwnership({
    progressStore,
    runtime,
    log,
    binding: startupOwnership,
  });
  const reclaimTerminalUndecidedProviderOperationOwnership = providerOperationStartupOwnership.reclaimTerminalUndecided;
  eventBus.on('job:phase_changed', reclaimTerminalUndecidedProviderOperationOwnership);

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
    if (state.recoveryRegistry?.has(jobId)) return;
    clearRecoveryPoller(jobId);
    state.adoptedRunningPids.delete(jobId);
    state.recoveryRegistry?.remove(jobId);
    takeAdoptedJobCleanup(jobId)?.();
    maybeReleaseRecoveryRegistry();
  };

  const observeDurableRecoveryContainment = (
    jobId: string,
    runtimeRecord: Extract<RunningRecoverableJob['runtimeRecord'], { transport: 'durable-cli' }>,
  ): Readonly<{
    evidence: DurableCliPreReadyOwnershipEvidence;
    observation: RecordedContainmentObservation;
  }> => {
    const evidence = readDurableCliPreReadyOwnershipEvidence(progressStore.getDb(), jobId, runtimeRecord.pid);
    const observation =
      evidence.kind === 'current' || evidence.kind === 'provisional'
        ? observeRecordedContainment(
            {
              ...evidence.record,
              childRoot: evidence.kind === 'current' ? evidence.record.childRoot : null,
            },
            {
              process: runtime.process,
              platform: runtime.env.platform() as NodeJS.Platform,
              readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
            },
          )
        : { kind: 'unobservable' as const, reason: durableOwnershipEvidenceHoldReason(evidence) };
    return { evidence, observation };
  };

  const cancelHeldRecoveryReap = (jobId: string): Promise<void> | null => {
    state.heldRecoveryReapGenerations.set(jobId, (state.heldRecoveryReapGenerations.get(jobId) ?? 0) + 1);
    const attempt = state.heldRecoveryReapAttempts.get(jobId);
    attempt?.abort.abort();
    return attempt?.settlement ?? null;
  };

  const runHeldRecoveryReap = async (
    jobId: string,
    record: Parameters<typeof reapDurableCliProcess>[1],
    parentSignal: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof reapDurableCliProcess>> | Readonly<{ kind: 'superseded' }>> => {
    const priorSettlement = cancelHeldRecoveryReap(jobId);
    if (priorSettlement !== null) await priorSettlement;
    const generation = (state.heldRecoveryReapGenerations.get(jobId) ?? 0) + 1;
    state.heldRecoveryReapGenerations.set(jobId, generation);
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', forwardAbort, { once: true });
    let markSettled!: () => void;
    const attempt: HeldRecoveryReapAttempt = {
      abort: controller,
      settlement: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    state.heldRecoveryReapAttempts.set(jobId, attempt);
    try {
      const result = await reapDurableCliProcess(runtime, record, controller.signal);
      return state.heldRecoveryReapGenerations.get(jobId) === generation && !controller.signal.aborted
        ? result
        : { kind: 'superseded' };
    } finally {
      parentSignal.removeEventListener('abort', forwardAbort);
      if (state.heldRecoveryReapAttempts.get(jobId) === attempt) {
        state.heldRecoveryReapAttempts.delete(jobId);
      }
      markSettled();
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

  const performTeardown = async (): Promise<void> => {
    eventBus.off('job:phase_changed', reclaimTerminalUndecidedProviderOperationOwnership);
    state.teardownRequested = true;

    for (const pollInterval of state.recoveryPollIntervals.values()) {
      runtime.time.clearInterval(pollInterval);
    }
    state.recoveryPollIntervals.clear();
    const heldRecoveryReapSettlements = [...state.heldRecoveryReapAttempts].flatMap(([jobId]) => {
      const settlement = cancelHeldRecoveryReap(jobId);
      return settlement === null ? [] : [settlement];
    });
    await Promise.allSettled(heldRecoveryReapSettlements);
    state.heldRecoveryReapGenerations.clear();

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
    if (state.recoveryRegistry !== null) {
      for (const [jobId] of [...state.recoveryRegistry]) {
        state.recoveryRegistry.remove(jobId);
      }
    }
    state.cancelledRecoveryJobIds.clear();
    state.providerOperationRecoveries.clear();
    providerOperationStartupOwnership.releaseAll();
    resetRecoveryState({ forceRegistryRelease: true });
  };

  const teardown = (): Promise<void> => {
    if (state.teardownState.kind === 'settled') return Promise.resolve();
    if (state.teardownState.kind === 'in-flight') return state.teardownState.settlement;

    const settlement = performTeardown().then(
      () => {
        state.teardownState = { kind: 'settled' };
      },
      (error: unknown) => {
        state.teardownState = { kind: 'pending' };
        throw error;
      },
    );
    state.teardownState = { kind: 'in-flight', settlement };
    return settlement;
  };

  const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);
  let abandonHeldRecoveryJob = (_jobId: string): RecoveryAbortDisposition => ({
    kind: 'refused',
    reason: 'durable containment abandonment is unavailable before recovery initialization',
  });

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

  const deleteCoordinatorRecoveryQuarantine = (jobId: string): boolean => {
    const record = quarantine.read(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId);
    if (record === null) return true;
    return quarantine.delete({ boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY, subject: record.subject });
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

  const recoveryAdoption = createRecoveryAdoption({
    state,
    progressStore,
    runtime,
    eventBus,
    getRecoveryService,
    createInvocationContext,
    log,
    clearRecoveryPoller,
    startTrackedFinalization,
    observeDurableRecoveryContainment,
    runHeldRecoveryReap,
    deleteCoordinatorRecoveryQuarantine,
    runCoordinatorWalk,
    settleUnexpectedRecoveryFailure,
    settleFault,
    takeAdoptedJobCleanup,
    maybeReleaseRecoveryRegistry,
    settleCoordinatorRecoveryItem,
  });

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
        abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
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
    const recoveryRegistry = state.recoveryRegistry ?? new RecoveryRegistry(state.cancelledRecoveryJobIds);
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
      await recoveryAdoption.run({
        queuedJobs: [],
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit,
        interruptedAppServerReason: 'restart',
        abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
      });
    }
    for (const queued of queuedRecoverable) {
      progressStore.seedEnqueueSequence(queued.authority.launchRecord.enqueueSequence);
      await recoveryAdoption.acceptQueued(queued, signal, coordinatorCommit, 'retry');
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
    providerOperationStartupOwnership.completeRecovery(jobId);
  };

  async function runStartupRecovery(ctx: StartupRecoveryContext): Promise<JobsStartupRecoveryDisposition> {
    const { runtime, progressStore, signal } = ctx;
    const interruptedAppServerReason: InterruptedAppServerReason = ctx.interruptedAppServerReason ?? 'restart';
    state.teardownRequested = false;
    runtimeState.setLaunchFenceActive(true);
    const recoveryRegistry = new RecoveryRegistry(state.cancelledRecoveryJobIds);
    state.recoveryRegistry = recoveryRegistry;
    const queuedRecoverable: QueuedRecoverableJob[] = [];
    const runningRecoverable: RunningRecoverableJob[] = [];

    const retryCoordinatorItem = async (
      item: CoordinatorRecoveryItem,
      controls: CoordinatorRecoveryControls,
      retrySignal: AbortSignal,
    ): Promise<RecoveryDisposition> => {
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
      const runningDisposition = await recoveryAdoption.run(
        {
          queuedJobs: [],
          runningJobs: retryRunning,
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          interruptedAppServerReason,
          abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
        },
        { item, controls },
      );
      if (runningDisposition !== undefined) return runningDisposition;
      const queued = retryQueued[0];
      if (queued !== undefined) {
        return recoveryAdoption.recoverQueued(item, queued, retrySignal, ctx.coordinatorCommit, controls);
      }
      return {
        kind: 'advanced',
        outcome: 'settled',
        facts,
        detail: 'coordinator job retry reconciled',
      };
    };

    abandonHeldRecoveryJob = (jobId): RecoveryAbortDisposition => {
      const statusRead = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
      const runtimeRecord = progressStore.readRuntimeProjection(jobId);
      if (
        statusRead.kind === 'missing' ||
        (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') ||
        (statusRead.kind === 'corrupt' && (runtimeRecord === null || !isDurableCliRuntime(runtimeRecord)))
      ) {
        return { kind: 'refused', reason: 'no active durable containment hold is recorded for this job' };
      }

      const activeReapSettlement = cancelHeldRecoveryReap(jobId);
      if (activeReapSettlement !== null) {
        clearRecoveryPoller(jobId);
        return {
          kind: 'held',
          reason: 'the active durable containment reap is still settling',
          nextStep: 'Wait for containment reap settlement; abandonment will resume automatically.',
          settlement: activeReapSettlement.then(async () => {
            const resumed = abandonHeldRecoveryJob(jobId);
            if (resumed.settlement !== undefined) return resumed.settlement;
            return resumed;
          }),
        };
      }

      let abandonedStatus: DurableCliContainmentStatus;
      if (statusRead.kind === 'valid') {
        abandonedStatus = {
          ...statusRead.status,
          disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
        };
      } else {
        if (runtimeRecord === null || !isDurableCliRuntime(runtimeRecord)) {
          return { kind: 'refused', reason: 'no durable runtime identity is recorded for this job' };
        }
        abandonedStatus = {
          jobId,
          evidence: readDurableCliProcessRuntimeEvidence(progressStore.getDb(), jobId, runtimeRecord.pid),
          disposition: { kind: 'operator-abandoned', processAbsenceProven: false },
        };
      }

      try {
        withImmediate(progressStore.getDb(), () => {
          writeDurableCliContainmentStatus(progressStore.getDb(), abandonedStatus);
          if (!deleteCoordinatorRecoveryQuarantine(jobId)) {
            throw new Error('coordinator job recovery already owns this hold retry');
          }
        });
      } catch (error: unknown) {
        return {
          kind: 'refused',
          reason: `durable containment abandonment could not be recorded: ${errorMessage(error)}`,
        };
      }
      clearRecoveryPoller(jobId);

      const jobStatus = progressStore.readStatus(jobId);
      if (jobStatus !== null) {
        try {
          progressStore.appendProgress(
            jobId,
            jobStatus.sessionId,
            'Durable containment was abandoned without proof of process absence and without sending a signal.',
          );
        } catch (error: unknown) {
          backendLog.warn(`Failed to append durable containment abandonment for ${jobId}: ${errorMessage(error)}`);
        }
      }
      if (jobStatus !== null && !isTerminalPhase(jobStatus.phase)) {
        recoveryRegistry.markCancelled(jobId);
        const finalization = runCoordinatorWalk({
          subjectKey: jobId,
          signal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: `Operator-abandoned durable recovery finalization for ${jobId}`,
          settle: (item, controls) => retryCoordinatorItem(item, controls, signal),
        });
        void finalization.catch((error: unknown) => {
          backendLog.warn(
            `Operator-abandoned durable recovery finalization failed for ${jobId}: ${errorMessage(error)}`,
          );
        });
      }
      return {
        kind: 'abandoned',
        reason: 'recovery ownership was released without proof of recorded containment absence',
        nextStep:
          `Run coral-cli jobs detail ${jobId}; the recorded containment may still be live and is no longer ` +
          'owned by recovery.',
      };
    };

    for (const statusRead of listDurableCliContainmentStatuses(progressStore.getDb())) {
      if (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') continue;
      const jobId = statusRead.kind === 'valid' ? statusRead.status.jobId : statusRead.jobId;
      const launchRecord = progressStore.readLaunchProjection(jobId);
      const runtimeRecord = progressStore.readRuntimeProjection(jobId);
      const jobStatus = progressStore.readStatus(jobId);
      if (
        launchRecord === null ||
        runtimeRecord === null ||
        !isDurableCliRuntime(runtimeRecord) ||
        jobStatus === null
      ) {
        continue;
      }
      if (statusRead.kind === 'valid' && !deleteCoordinatorRecoveryQuarantine(jobId)) continue;
      recoveryRegistry.register(jobId, launchRecord, runtimeRecord, () => abandonHeldRecoveryJob(jobId));
    }

    coordinatorJobRetryPolicies.set(progressStore.getDb(), (retrySignal) =>
      createCoordinatorJobRecoveryPolicy(
        {
          signal: retrySignal,
          coordinatorCommit: ctx.coordinatorCommit,
          summary: 'Coordinator job operator retry',
          settle: (item, controls) => retryCoordinatorItem(item, controls, retrySignal),
        },
        [],
      ),
    );
    const walkedRecoveryItems: CoordinatorRecoveryItem[] = [];
    await runCoordinatorWalk({
      signal,
      coordinatorCommit: ctx.coordinatorCommit,
      summary: 'Coordinator recovery snapshot hydration',
      settle: (item) => {
        walkedRecoveryItems.push(item);
        return {
          kind: 'advanced',
          outcome: 'settled',
          facts: COORDINATOR_NOT_APPLICABLE_FACTS,
          detail: 'raw coordinator job hydrated',
        };
      },
    });
    const providerOperationFenceSnapshot = providerOperationStartupOwnership.snapshot();
    const sagaOwnedJobIds = new Set([
      ...providerOperationFenceSnapshot.records.map((record) => record.operation.jobId),
      ...providerOperationFenceSnapshot.unreadable.flatMap((attribution) =>
        attribution.jobs.kind === 'known'
          ? attribution.jobs.values.filter((jobId) => {
              const status = progressStore.readStatus(jobId);
              return status === null || !isTerminalPhase(status.phase);
            })
          : [],
      ),
    ]);
    const recoveryItems = walkedRecoveryItems.filter((item) => !sagaOwnedJobIds.has(item.jobId));
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
      await recoveryAdoption.run({
        queuedJobs: queuedRecoverable,
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit: ctx.coordinatorCommit,
        interruptedAppServerReason,
        abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
      });
    }
    const postReconciliationSnapshot = providerOperationStartupOwnership.snapshot();
    const postReconciliationOwnership = providerOperationStartupOwnership.hydrate(postReconciliationSnapshot);
    const startupLocalRecoveryOperations = new Set(
      postReconciliationOwnership.records.flatMap((ownership) =>
        ownership.phase === 'local-recovery-pending' &&
        ownership.bindingDisposition.kind === 'not-required' &&
        ownership.bindingDisposition.owner === 'generic-job-recovery'
          ? [providerOperationStartupIdentityKey(ownership.operation)]
          : [],
      ),
    );
    const localRecoveryRecords = postReconciliationSnapshot.records.filter(
      (record): record is Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }> =>
        record.phase === 'local-recovery-pending' &&
        startupLocalRecoveryOperations.has(providerOperationStartupIdentityKey(record.operation)),
    );
    const providerOperationHolds: ProviderOperationStartupHold[] =
      postReconciliationOwnership.completion.kind === 'held' ? [...postReconciliationOwnership.completion.holds] : [];
    for (const record of localRecoveryRecords) {
      try {
        await recoverProviderOperationJob(record, signal);
      } catch (error: unknown) {
        const reason =
          `Provider operation exact-job recovery for ${record.operation.jobId} failed: ` + formatError(error);
        const ownership = providerOperationStartupOwnership.holdRecoveryFailure(record, reason);
        if (ownership.bindingDisposition.kind === 'refused') {
          providerOperationHolds.push({
            kind: 'operation',
            jobId: ownership.operation.jobId,
            operationId: ownership.operation.operationId,
            reason: ownership.bindingDisposition.reason,
            exit: ownership.bindingDisposition.exit,
          });
        }
        log(`${reason}\n`);
      }
    }
    signal.throwIfAborted();
    resetRecoveryState();
    const durableHoldRemains = listDurableCliContainmentStatuses(progressStore.getDb()).some((statusRead) => {
      if (statusRead.kind === 'valid' && statusRead.status.disposition.kind !== 'held') return false;
      const jobId = statusRead.kind === 'valid' ? statusRead.status.jobId : statusRead.jobId;
      return recoveryRegistry.has(jobId);
    });
    if (providerOperationHolds.length > 0 || durableHoldRemains) {
      const heldSubjects = providerOperationHolds.map((hold) => {
        const subject =
          hold.kind === 'operation' ? `operation=${hold.operationId}` : `record=${JSON.stringify(hold.recordKey)}`;
        return (
          `provider operation job=${hold.jobId} ${subject} reason=${JSON.stringify(hold.reason)} ` +
          `exit=${JSON.stringify(hold.exit)}`
        );
      });
      if (durableHoldRemains) {
        heldSubjects.push('durable containment awaiting repair or operator abandonment');
      }
      log(`Recovery reconciliation remains held: ${heldSubjects.join('; ')}. Launch fence lifted.\n`);
      return {
        kind: 'held',
        progressStore,
        providerOperationHolds,
        durableContainmentHeld: durableHoldRemains,
      };
    }
    log('Recovery adoption complete. Launch fence lifted.\n');
    return { kind: 'complete', progressStore };
  }

  if (bound !== null) {
    registerCoordinatorStartupRecovery(bound, runStartupRecovery);
  }
  return {
    retireAbsentSupersededProviderOperations:
      providerOperationStartupOwnership.retireAbsentSupersededProviderOperations,
    snapshotProviderOperationStartupOwnership: providerOperationStartupOwnership.snapshot,
    hydrateProviderOperationStartupOwnership: providerOperationStartupOwnership.hydrate,
    adoptRepairedProviderOperationOwnership: providerOperationStartupOwnership.adoptRepaired,
    releaseProviderOperationStartupOwnership: providerOperationStartupOwnership.release,
    releaseUnreadableProviderOperationStartupOwnership: providerOperationStartupOwnership.releaseUnreadable,
    recoverProviderOperationJob,
    completeProviderOperationJobRecovery,
    releaseAdoptedJob,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
