import { ZodError } from 'zod';

import { assertNever, errorMessage, formatError } from '../../../infra/error-format.js';
import { StoreDecodeError } from '../../../store/body-codec.js';
import {
  observeRecordedContainment,
  ProcessContainmentError,
  type RecordedContainmentObservation,
} from '../../../infra/process-containment.js';
import { backendLog } from '../../../infra/backend-log.js';
import { isTerminalPhase, type JobPhase } from '../../../jobs/phase.js';
import { isAppServerRuntime, type JobTerminalInput } from '../../../jobs/records.js';
import {
  attributeUnreadableProviderOperations,
  compareAndSwapProviderOperation,
  providerOperationRecordKeyPrefix,
  readProviderOperation,
  readProviderOperations,
  readSupersededProviderOperations,
  retireSupersededProviderOperation,
  type UnreadableProviderOperationAttribution,
} from '../../../store/provider-operation-journal.js';
import {
  encodeProviderOperationRecord,
  providerOperationRecordSchema,
  type ProviderOperationRecord,
} from '../../../store/provider-operation-record.js';
import { readProviderOperationJobLaunch } from '../../../jobs/provider-operation-state.js';
import type {
  JobAdmissionPort,
  JobLaunchRecoveryPort,
  LaunchPermit,
  LaunchRelease,
} from '../../../jobs/contracts/admission.js';
import type { ProviderOperationBindingPort } from '../../../jobs/contracts/provider-operation-lifecycle.js';
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
  durableOwnershipStatusEvidence,
  finalizeDeadAdoptedJob,
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
import { sha256Hex } from '../../../infra/hash.js';

const RECOVERY_POLL_MS = 500;

/** Abandonment must be able to abort a destructive reap and wait for it, not merely ignore its result. */
type HeldRecoveryReapAttempt = Readonly<{ abort: AbortController; settlement: Promise<void> }>;

type ProviderOperationStartupPermitOwnership =
  | Readonly<{ kind: 'operation'; permit: LaunchPermit; operationId: string }>
  | Readonly<{
      kind: 'undecided-provider-operation';
      permit: LaunchPermit;
      recordKeys: readonly string[];
    }>;

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
  providerOperationStartupPermits: Map<string, ProviderOperationStartupPermitOwnership>;
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

export type ProviderOperationStartupRelease = LaunchRelease | Readonly<{ kind: 'not-owned' }>;

type ProviderOperationStartupSnapshot = Readonly<{
  records: readonly ProviderOperationRecord[];
  unreadable: readonly UnreadableProviderOperationAttribution[];
}>;

type UnreadableProviderOperationStartupResolution = Readonly<{
  released: number;
  readableRecords: readonly Readonly<{ recordKey: string; record: ProviderOperationRecord }>[];
}>;

type ProviderOperationStartupHoldDisposition =
  | Readonly<{ kind: 'fenced'; record: ProviderOperationRecord }>
  | Readonly<{ kind: 'record-absent' }>
  | Readonly<{
      kind: 'settlement-pending';
      record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>;
    }>;

function providerOperationPhaseRestoresStartupPermit(phase: ProviderOperationRecord['phase']): boolean {
  return (
    phase === 'prepare-pending' ||
    phase === 'guardian-activation-pending' ||
    phase === 'proxy-activation-pending' ||
    phase === 'activation-resolution-pending' ||
    phase === 'executing' ||
    phase === 'prestart-cleanup-pending'
  );
}

function providerOperationStartupIdentityKey(operation: ProviderOperationRecord['operation']): string {
  return (
    `${operation.jobId}\u0000${operation.operationId}\u0000` +
    `${operation.proxyInstanceId}\u0000${operation.buildSetId}`
  );
}

function providerOperationStartupRecordKey(operation: ProviderOperationRecord['operation']): string {
  return (
    `${providerOperationRecordKeyPrefix(operation.jobId)}${operation.operationId}:` +
    `${operation.proxyInstanceId}:${operation.buildSetId}`
  );
}

function providerOperationRecordFingerprint(record: ProviderOperationRecord): string {
  return `sha256:${sha256Hex(encodeProviderOperationRecord(record))}`;
}

export interface RecoveryCoordinator {
  retireAbsentSupersededProviderOperations(): void;
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
    ProviderOperationBindingPort;
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

type RecoveryAdoptionContext = {
  queuedJobs: QueuedRecoverableJob[];
  runningJobs: RunningRecoverableJob[];
  signal: AbortSignal;
  coordinatorCommit: CommitEventsFn;
  interruptedAppServerReason: InterruptedAppServerReason;
  abandonHeldJob(jobId: string): RecoveryAbortDisposition;
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
    providerOperationStartupPermits: new Map(),
    teardownRequested: false,
    teardownState: { kind: 'pending' },
  };

  const reclaimTerminalUndecidedProviderOperationOwnership = ({
    jobId,
    phase,
  }: Readonly<{ jobId: string; phase: JobPhase; previousPhase: JobPhase }>): void => {
    if (!isTerminalPhase(phase)) return;
    const owned = state.providerOperationStartupPermits.get(jobId);
    if (owned?.kind !== 'undecided-provider-operation') return;
    if (startupOwnership.reclaimLaunchPermit(owned.permit)) {
      state.providerOperationStartupPermits.delete(jobId);
    }
  };
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
    for (const { permit } of state.providerOperationStartupPermits.values()) {
      void startupOwnership.releaseLaunch(permit);
    }
    state.providerOperationStartupPermits.clear();
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
    {
      queuedJobs,
      runningJobs,
      signal,
      coordinatorCommit,
      interruptedAppServerReason,
      abandonHeldJob,
    }: RecoveryAdoptionContext,
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
        controls.setProcessLocalCleanup(() => {
          state.recoveryRegistry?.remove(jobId);
          state.recoveryRegistry?.clearCancelled(jobId);
        });
        const service = getRecoveryService(createInvocationContext(launchRecord.projectRoot));
        const pendingAbort = state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement;
        if (pendingAbort !== undefined) {
          void (await pendingAbort.catch(() => undefined));
          signal.throwIfAborted();
        }
        if (isAppServerRuntime(runtimeRecord)) {
          const abortDisposition = state.recoveryRegistry?.getAbortDisposition(jobId);
          const userCancelled = abortDisposition?.kind === 'finalization-pending';
          if (abortDisposition !== undefined && !userCancelled) {
            controls.clearProcessLocalCleanup();
            const detail = `${abortDisposition.reason}. ${abortDisposition.nextStep}`;
            controls.report(`Held recovered app-server abort for ${jobId}: ${abortDisposition.reason}\n`);
            return { kind: 'quarantine', detail };
          }
          if (!userCancelled) {
            state.recoveryRegistry?.setAbortHandler(jobId, () => ({
              kind: 'refused',
              reason: 'startup recovery already owns app-server finalization',
              nextStep:
                `Wait for startup recovery to finish, then run coral-cli jobs detail ${jobId} before retrying ` +
                'an abort.',
            }));
          }
          signal.throwIfAborted();
          try {
            await startTrackedFinalization(jobId, signal, (fence) =>
              service.finalizeInterruptedAppServerJob(authority, runtimeRecord, {
                reason: userCancelled ? 'user_abort' : interruptedAppServerReason,
                ...fence,
              }),
            );
          } catch (error: unknown) {
            if (userCancelled) {
              controls.clearProcessLocalCleanup();
              const detail = `User-abort terminal finalization failed after provider acknowledgment: ${errorMessage(error)}`;
              controls.report(`Held acknowledged recovered app-server abort for ${jobId}: ${errorMessage(error)}\n`);
              return { kind: 'quarantine', detail };
            }
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
          controls.report(
            userCancelled
              ? `Finalized user-aborted recovered app-server job: ${jobId}\n`
              : `Recovered interrupted app-server job: ${jobId}\n`,
          );
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
            detail: userCancelled ? 'user-aborted app-server job finalized' : 'interrupted app-server job finalized',
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

        const persistedContainment = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
        if (persistedContainment.kind === 'corrupt') {
          const reason = 'The durable containment status is corrupt.';
          progressStore.appendProgress(
            jobId,
            launchRecord.sessionId,
            `${reason} Repair or remove the status row and retry the coordinator-job-recovery quarantine, or run ` +
              `coral-cli abort jobs ${jobId} to abandon job ownership without proving process absence or sending a signal.`,
          );
          state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
          controls.clearProcessLocalCleanup();
          controls.report(`Held durable recovery job with corrupt containment status: ${jobId}\n`);
          return {
            kind: 'quarantine',
            detail:
              `${reason} Repair or remove the status row and retry this quarantine, or run coral-cli abort jobs ` +
              `${jobId} to abandon job ownership without proving process absence or sending a signal.`,
          };
        }

        const containment = observeDurableRecoveryContainment(jobId, runtimeRecord);
        let operatorAbandoned =
          persistedContainment.kind === 'valid' &&
          persistedContainment.status.disposition.kind === 'operator-abandoned';
        let absenceConfirmed = containment.observation.kind === 'absent';
        if (
          persistedContainment.kind === 'valid' &&
          persistedContainment.status.disposition.kind === 'held' &&
          !absenceConfirmed
        ) {
          const retryIntervalMs = persistedContainment.status.disposition.retryIntervalMs;
          const cleanup =
            containment.evidence.kind === 'current' || containment.evidence.kind === 'provisional'
              ? await runHeldRecoveryReap(jobId, containment.evidence.record, signal)
              : { kind: 'held' as const, reason: durableOwnershipEvidenceHoldReason(containment.evidence) };
          if (cleanup.kind === 'superseded') {
            signal.throwIfAborted();
            return {
              kind: 'deferred',
              authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
              detail: 'durable containment reap ownership transferred',
            };
          }
          const statusAfterCleanup = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
          operatorAbandoned =
            statusAfterCleanup.kind === 'valid' && statusAfterCleanup.status.disposition.kind === 'operator-abandoned';
          if (cleanup.kind === 'absence-confirmed') {
            absenceConfirmed = true;
          } else if (!operatorAbandoned) {
            writeDurableCliContainmentStatus(progressStore.getDb(), {
              jobId,
              evidence: durableOwnershipStatusEvidence(containment.evidence),
              disposition: {
                kind: 'held',
                reason: cleanup.reason,
                retryIntervalMs,
                abandonment: 'abort-job',
              },
            });
            if (!state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId))) {
              throw new Error('Durable containment hold was not accepted by the recovery registry.');
            }
            if (!state.recoveryPollIntervals.has(jobId)) {
              let retryInFlight = false;
              const retryHeldCleanup = async (): Promise<void> => {
                if (state.teardownRequested) return;
                const currentStatus = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
                if (currentStatus.kind === 'valid' && currentStatus.status.disposition.kind === 'operator-abandoned') {
                  clearRecoveryPoller(jobId);
                  return;
                }

                const currentContainment = observeDurableRecoveryContainment(jobId, runtimeRecord);
                const retryCleanup =
                  currentContainment.observation.kind === 'absent'
                    ? ({ kind: 'absence-confirmed' } as const)
                    : currentContainment.evidence.kind === 'current' ||
                        currentContainment.evidence.kind === 'provisional'
                      ? await runHeldRecoveryReap(jobId, currentContainment.evidence.record, signal)
                      : {
                          kind: 'held' as const,
                          reason: durableOwnershipEvidenceHoldReason(currentContainment.evidence),
                        };
                if (retryCleanup.kind === 'superseded') return;
                const statusAfterCleanup = readDurableCliContainmentStatus(progressStore.getDb(), jobId);
                if (
                  statusAfterCleanup.kind === 'valid' &&
                  statusAfterCleanup.status.disposition.kind === 'operator-abandoned'
                ) {
                  clearRecoveryPoller(jobId);
                  return;
                }
                if (retryCleanup.kind === 'held') {
                  writeDurableCliContainmentStatus(progressStore.getDb(), {
                    jobId,
                    evidence: durableOwnershipStatusEvidence(currentContainment.evidence),
                    disposition: {
                      kind: 'held',
                      reason: retryCleanup.reason,
                      retryIntervalMs,
                      abandonment: 'abort-job',
                    },
                  });
                  if (
                    currentStatus.kind !== 'valid' ||
                    currentStatus.status.disposition.kind !== 'held' ||
                    currentStatus.status.disposition.reason !== retryCleanup.reason
                  ) {
                    progressStore.appendProgress(
                      jobId,
                      launchRecord.sessionId,
                      `Durable recovery cleanup remains held (${retryCleanup.reason}).`,
                    );
                  }
                  return;
                }

                clearRecoveryPoller(jobId);
                if (!deleteCoordinatorRecoveryQuarantine(jobId)) return;
                await runCoordinatorWalk({
                  subjectKey: jobId,
                  signal,
                  coordinatorCommit,
                  summary: `Held durable recovery finalization for ${jobId}`,
                  settle: settleRunningRecovery,
                  settleFailure: (item, error, controls) =>
                    settleUnexpectedRecoveryFailure(
                      item,
                      jobId,
                      'Held durable recovery finalization failed',
                      error,
                      coordinatorCommit,
                      controls.report,
                    ),
                });
              };
              const pollInterval = runtime.time.setInterval(() => {
                if (retryInFlight) return;
                retryInFlight = true;
                void retryHeldCleanup()
                  .catch((error: unknown) => {
                    log(`Held durable recovery retry failed for ${jobId}: ${formatError(error)}\n`);
                  })
                  .finally(() => {
                    retryInFlight = false;
                  });
              }, retryIntervalMs);
              pollInterval.unref?.();
              state.recoveryPollIntervals.set(jobId, pollInterval);
            }
            if (!state.recoveryPollIntervals.has(jobId)) {
              throw new Error('Durable containment retry was not accepted by the recovery coordinator.');
            }
            controls.clearProcessLocalCleanup();
            progressStore.appendProgress(
              jobId,
              launchRecord.sessionId,
              `Durable recovery cleanup remains held (${cleanup.reason}). Identity-safe reaping continues every ` +
                `${retryIntervalMs}ms until absence is confirmed, or run coral-cli abort jobs ${jobId} to abandon ` +
                'job ownership without proving process absence or sending another signal.',
            );
            controls.report(`Held durable recovery cleanup: ${jobId}: ${cleanup.reason}\n`);
            return {
              kind: 'deferred',
              continuation: { kind: 'durable-containment-reap', key: jobId },
              detail:
                `${cleanup.reason}. Identity-safe reaping continues every ${retryIntervalMs}ms until absence is ` +
                `confirmed, or run coral-cli abort jobs ${jobId} to abandon job ownership without proving process ` +
                'absence or sending another signal.',
            };
          }
        }

        if (absenceConfirmed || operatorAbandoned) {
          if (operatorAbandoned) state.cancelledRecoveryJobIds.add(jobId);
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
          controls.report(
            operatorAbandoned
              ? `Finalized operator-abandoned durable recovery job: ${jobId}\n`
              : `Finalized dead durable recovery job: ${jobId}\n`,
          );
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
            detail: operatorAbandoned
              ? 'operator-abandoned durable job finalized without process absence proof'
              : 'dead durable job finalized',
          };
        }

        if (containment.observation.kind === 'unobservable') {
          const reason = containment.observation.reason;
          writeDurableCliContainmentStatus(progressStore.getDb(), {
            jobId,
            evidence: durableOwnershipStatusEvidence(containment.evidence),
            disposition: {
              kind: 'held',
              reason,
              retryIntervalMs: RECOVERY_POLL_MS,
              abandonment: 'abort-job',
            },
          });
          progressStore.appendProgress(
            jobId,
            launchRecord.sessionId,
            `Durable recovery containment pid=${runtimeRecord.pid} is held (${reason}). ` +
              `Repair the recorded containment and retry the coordinator-job-recovery quarantine, or run ` +
              `coral-cli abort jobs ${jobId} to abandon job ownership without proving process absence or sending a signal.`,
          );
          state.recoveryRegistry?.setAbortHandler(jobId, () => abandonHeldJob(jobId));
          controls.clearProcessLocalCleanup();
          controls.report(`Held durable recovery job: ${jobId}: ${reason}\n`);
          return {
            kind: 'quarantine',
            detail:
              `${reason}. Repair the recorded containment and retry this quarantine, or run coral-cli abort jobs ` +
              `${jobId} to abandon job ownership without proving process absence or sending a signal.`,
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
          const observation = observeDurableRecoveryContainment(jobId, runtimeRecord).observation;
          if (observation.kind === 'unobservable') {
            const unanswered = (state.unansweredAdoptionProbes.get(jobId) ?? 0) + 1;
            state.unansweredAdoptionProbes.set(jobId, unanswered);
            if (unanswered === UNANSWERED_ADOPTION_PROBE_REPORT_THRESHOLD) {
              // Not `controls.report`: that appends to the recovery walk's own message array, which is
              // flushed once at the end of startup — long before ten poll ticks. The report would never have
              // been seen, which is exactly the silence this counter exists to break.
              backendLog.warn(
                `Containment of adopted job ${jobId} (pid ${runtimeRecord.pid}) has been unobservable for ` +
                  `${unanswered} checks; it stays adopted until a probe answers.`,
              );
            }
            return;
          }
          state.unansweredAdoptionProbes.delete(jobId);
          if (observation.kind === 'alive') return;
          if (state.recoveryRegistry?.getAbortDisposition(jobId)?.settlement !== undefined) return;

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
                  state.recoveryRegistry?.remove(jobId);
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
        controls.clearProcessLocalCleanup();
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
      await runRecoveryAdoption({
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
    const owned = state.providerOperationStartupPermits.get(jobId);
    if (owned !== undefined) {
      state.providerOperationStartupPermits.delete(jobId);
      const release = startupOwnership.releaseLaunch(owned.permit);
      if (release.kind === 'transferred') {
        throw new Error(`Launch ownership transferred to ${JSON.stringify(release.holder)}.`);
      }
    }
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

  const snapshotProviderOperationStartupOwnership = (): ProviderOperationStartupSnapshot => {
    const scan = readProviderOperations(progressStore.getDb());
    // A row this build cannot read still names a job the provider saga owns. Fencing only the decoded ones
    // hands that job to generic recovery, which then does a keyed strict read of the same row and throws —
    // turning a stalled operation back into a failed startup.
    //
    // Both names, not just the key's. `decodeCanonicalValue` rejects a row whose payload identity disagrees
    // with its key, so those are exactly the rows where the two differ — fencing the key's job alone would
    // hand the payload's job to generic recovery, which can terminalize it while its operation is live. This
    // is the sibling of the proxy-set fence in `provider-proxy-set/containment-proof.ts`.
    return Object.freeze({
      records: Object.freeze([...scan.records]),
      unreadable: Object.freeze(attributeUnreadableProviderOperations(progressStore.getDb(), scan.unreadableKeys)),
    });
  };

  const restoreProviderOperationStartupPermit = (
    jobId: string,
    ownership:
      | Readonly<{ kind: 'operation'; operationId: string }>
      | Readonly<{ kind: 'undecided-provider-operation'; recordKeys: readonly string[] }>,
  ): LaunchPermit | null => {
    const existing = state.providerOperationStartupPermits.get(jobId);
    if (existing !== undefined) {
      if (
        existing.kind === 'operation' &&
        ownership.kind === 'operation' &&
        existing.operationId !== ownership.operationId
      ) {
        log(`Provider operation startup ownership conflict for ${jobId}: more than one operation claims its permit.\n`);
        return null;
      }
      if (existing.kind === 'undecided-provider-operation' && ownership.kind === 'operation') {
        state.providerOperationStartupPermits.set(jobId, {
          kind: 'operation',
          permit: existing.permit,
          operationId: ownership.operationId,
        });
      } else if (ownership.kind === 'undecided-provider-operation') {
        const existingRecordKeys =
          existing.permit.holder.kind === 'undecided-provider-operation' ? existing.permit.holder.recordKeys : [];
        const recordKeys = [...new Set([...existingRecordKeys, ...ownership.recordKeys])];
        const permit = startupOwnership.holdUndecidedProviderOperationLaunch(existing.permit, recordKeys);
        if (permit === null) return null;
        state.providerOperationStartupPermits.set(jobId, {
          kind: 'undecided-provider-operation',
          permit,
          recordKeys,
        });
        return permit;
      }
      return existing.permit;
    }

    const status = progressStore.readStatus(jobId);
    if (status === null) return null;
    try {
      const launch = readProviderOperationJobLaunch(progressStore, jobId);
      const permit = startupOwnership.restoreActiveLaunch(
        jobId,
        launch.provider,
        launch.owner,
        launch.pool,
        ownership.kind === 'operation'
          ? { kind: 'recovery' }
          : { kind: 'undecided-provider-operation', recordKeys: ownership.recordKeys },
      );
      state.providerOperationStartupPermits.set(
        jobId,
        ownership.kind === 'operation'
          ? { kind: 'operation', permit, operationId: ownership.operationId }
          : { kind: 'undecided-provider-operation', permit, recordKeys: ownership.recordKeys },
      );
      return permit;
    } catch (error: unknown) {
      log(`Provider operation startup permit restoration failed for ${jobId}: ${formatError(error)}\n`);
      return null;
    }
  };

  const releaseProviderOperationStartupOwnership = (
    operation: ProviderOperationRecord['operation'],
  ): ProviderOperationStartupRelease => {
    const owned = state.providerOperationStartupPermits.get(operation.jobId);
    if (owned?.kind !== 'operation' || owned.operationId !== operation.operationId) {
      return { kind: 'not-owned' };
    }
    state.providerOperationStartupPermits.delete(operation.jobId);
    return startupOwnership.releaseLaunch(owned.permit);
  };

  const releaseUnreadableProviderOperationStartupOwnership = (
    recordKey: string,
  ): UnreadableProviderOperationStartupResolution => {
    let released = 0;
    const readableRecords: Array<Readonly<{ recordKey: string; record: ProviderOperationRecord }>> = [];
    for (const [jobId, owned] of state.providerOperationStartupPermits) {
      if (owned.kind !== 'undecided-provider-operation' || !owned.recordKeys.includes(recordKey)) continue;
      const retainRecordKeys = (recordKeys: readonly string[]): boolean => {
        const permit = startupOwnership.holdUndecidedProviderOperationLaunch(owned.permit, recordKeys);
        if (permit === null) return false;
        state.providerOperationStartupPermits.set(jobId, { ...owned, permit, recordKeys });
        return true;
      };
      const scan = readProviderOperations(progressStore.getDb());
      const remainingUnreadableKeys = attributeUnreadableProviderOperations(
        progressStore.getDb(),
        scan.unreadableKeys,
      ).flatMap((attribution) =>
        attribution.jobs.kind === 'known' && attribution.jobs.values.includes(jobId) ? [attribution.key] : [],
      );
      const readableForJob = scan.records.filter((record) => record.operation.jobId === jobId);
      const readableRecordKeys = readableForJob.map((record) => providerOperationStartupRecordKey(record.operation));
      if (remainingUnreadableKeys.length > 0) {
        retainRecordKeys([...remainingUnreadableKeys, ...readableRecordKeys]);
        continue;
      }
      const soleReadable = readableForJob.length === 1 ? readableForJob[0] : undefined;
      if (soleReadable !== undefined) {
        retainRecordKeys(readableRecordKeys);
        readableRecords.push({
          recordKey: providerOperationStartupRecordKey(soleReadable.operation),
          record: soleReadable,
        });
        continue;
      }
      if (readableForJob.length > 1) {
        retainRecordKeys(readableRecordKeys);
        continue;
      }
      state.providerOperationStartupPermits.delete(jobId);
      const disposition = startupOwnership.releaseLaunch(owned.permit);
      switch (disposition.kind) {
        case 'released':
          released += 1;
          continue;
        case 'already-released':
        case 'transferred':
          continue;
      }
      assertNever(disposition);
    }
    return Object.freeze({ released, readableRecords: Object.freeze(readableRecords) });
  };

  const settleProviderOperationStartupBinding = (
    operation: ProviderOperationRecord['operation'],
  ): ProviderOperationStartupRecordOwnership['bindingDisposition'] => {
    const disposition = startupOwnership.settleProviderOperationBinding(operation);
    if (
      disposition.kind === 'settled-unbound' ||
      disposition.kind === 'settled' ||
      disposition.kind === 'already-settled'
    ) {
      return disposition;
    }
    const reason =
      disposition.kind === 'refused'
        ? disposition.reason
        : `Provider operation startup settlement returned unexpected disposition '${disposition.kind}'.`;
    return { kind: 'refused', reason, exit: 'remote-settlement' };
  };

  const releaseRestoredPermitThroughSettlement = (
    permit: LaunchPermit,
    operation: ProviderOperationRecord['operation'],
  ): ProviderOperationStartupRecordOwnership['bindingDisposition'] => {
    const settlement = settleProviderOperationStartupBinding(operation);
    if (settlement.kind === 'refused') return settlement;
    const disposition = startupOwnership.prepareProviderOperationBinding(permit, operation);
    if (disposition.kind === 'already-settled') {
      state.providerOperationStartupPermits.delete(operation.jobId);
      return disposition;
    }
    const reason =
      disposition.kind === 'refused'
        ? disposition.reason
        : `Provider operation settlement binding returned unexpected disposition '${disposition.kind}'.`;
    return { kind: 'refused', reason, exit: 'remote-settlement' };
  };

  const holdProviderOperationStartupOwnership = (
    record: ProviderOperationRecord,
    reason: string,
  ): ProviderOperationStartupHoldDisposition => {
    const message = (reason.trim() || 'Provider operation startup ownership was refused.').slice(0, 4096);
    let current: ProviderOperationRecord | null = record;
    while (current !== null) {
      if (current.phase === 'settlement-pending') return { kind: 'settlement-pending', record: current };
      const next = providerOperationRecordSchema.parse({
        ...current,
        revision: current.revision + 1,
        retryNotBeforeMs: Number.MAX_SAFE_INTEGER,
        retryCount: current.retryCount + 1,
        lastError: {
          observedAtMs: runtime.time.now(),
          code: 'provider_operation_startup_ownership_refused',
          message,
        },
      });
      const result = compareAndSwapProviderOperation(progressStore.getDb(), current, next);
      if (result.kind === 'updated') return { kind: 'fenced', record: next };
      current = result.current;
    }
    return { kind: 'record-absent' };
  };

  const settleProviderOperationStartupOwnership = (
    record: Extract<ProviderOperationRecord, { phase: 'settlement-pending' }>,
    restoredPermit: LaunchPermit | null,
  ): ProviderOperationStartupRecordOwnership => {
    const bindingDisposition =
      restoredPermit === null
        ? settleProviderOperationStartupBinding(record.operation)
        : releaseRestoredPermitThroughSettlement(restoredPermit, record.operation);
    return { phase: record.phase, operation: record.operation, restoredPermit, bindingDisposition };
  };

  const releaseAbsentProviderOperationStartupOwnership = (
    record: ProviderOperationRecord,
    restoredPermit: LaunchPermit | null,
  ): ProviderOperationStartupRecordOwnership => {
    let transferredHolder: LaunchPermit['holder'] | null = null;
    let bindingCanRetire = true;
    if (restoredPermit !== null) {
      const disposition = releaseRestoredPermitThroughSettlement(restoredPermit, record.operation);
      if (disposition.kind === 'refused') {
        state.providerOperationStartupPermits.delete(record.operation.jobId);
        const release = startupOwnership.releaseLaunch(restoredPermit);
        if (release.kind === 'transferred') transferredHolder = release.holder;
      }
    } else {
      bindingCanRetire = settleProviderOperationStartupBinding(record.operation).kind !== 'refused';
    }
    if (
      bindingCanRetire &&
      transferredHolder === null &&
      !state.providerOperationStartupPermits.has(record.operation.jobId)
    ) {
      startupOwnership.retireProviderOperationBinding(record.operation);
    }
    return {
      phase: record.phase,
      operation: record.operation,
      restoredPermit: null,
      bindingDisposition:
        transferredHolder === null
          ? {
              kind: 'not-reconciled',
              reason: 'record-absent',
              owner: { kind: 'generic-job-recovery' },
            }
          : {
              kind: 'not-reconciled',
              reason: 'record-absent',
              owner: { kind: 'transferred-launch', holder: transferredHolder },
            },
    };
  };

  const resolveProviderOperationStartupHold = (
    record: ProviderOperationRecord,
    restoredPermit: LaunchPermit | null,
    hold: ProviderOperationStartupHoldDisposition,
    refusal: Extract<ProviderOperationStartupRecordOwnership['bindingDisposition'], { kind: 'refused' }>,
  ): ProviderOperationStartupRecordOwnership => {
    switch (hold.kind) {
      case 'fenced':
        return {
          phase: hold.record.phase,
          operation: hold.record.operation,
          restoredPermit,
          bindingDisposition: refusal,
        };
      case 'record-absent':
        return releaseAbsentProviderOperationStartupOwnership(record, restoredPermit);
      case 'settlement-pending':
        return settleProviderOperationStartupOwnership(hold.record, restoredPermit);
    }
    return assertNever(hold);
  };

  const quarantineAmbiguousReadableProviderOperation = (record: ProviderOperationRecord): void => {
    const key = providerOperationStartupRecordKey(record.operation);
    const subject = unreadableProviderOperationSubject(key, providerOperationRecordFingerprint(record));
    const persisted = quarantine.upsert({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject,
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'More than one readable provider operation row claims this job.',
      detail:
        'Discarding readable data requires an operator decision. Run the printed discard-provider-operation command with --allow-readable for one row, then inspect recovery-quarantine list again.',
    });
    if (!persisted && quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key) === null) {
      log(`Provider operation ambiguity quarantine failed for ${key}.\n`);
    }
  };

  const clearResolvedReadableAmbiguity = (record: ProviderOperationRecord): void => {
    const key = providerOperationStartupRecordKey(record.operation);
    const entry = quarantine
      .list()
      .find(
        (candidate) =>
          candidate.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY &&
          candidate.subject.key === key &&
          candidate.errorMessage === 'More than one readable provider operation row claims this job.',
      );
    if (entry?.state !== 'active') return;
    quarantine.delete({ boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY, subject: entry.subject });
  };

  const prepareProviderOperationStartupBinding = (
    permit: LaunchPermit,
    record: ProviderOperationRecord,
  ): ProviderOperationStartupRecordOwnership => {
    const disposition = startupOwnership.prepareProviderOperationBinding(permit, record.operation);
    if (disposition.kind === 'prepared' || disposition.kind === 'bound' || disposition.kind === 'already-settled') {
      state.providerOperationStartupPermits.delete(record.operation.jobId);
      return {
        phase: record.phase,
        operation: record.operation,
        restoredPermit: permit,
        bindingDisposition: disposition,
      };
    }
    const reason =
      disposition.kind === 'refused'
        ? disposition.reason
        : `Provider operation startup binding returned unexpected disposition '${disposition.kind}'.`;
    const hold = holdProviderOperationStartupOwnership(record, reason);
    return resolveProviderOperationStartupHold(record, permit, hold, {
      kind: 'refused',
      reason,
      exit: 'restart-or-operator-repair',
    });
  };

  const hydrateProviderOperationStartupRecord = (
    snapshotRecord: ProviderOperationRecord,
  ): ProviderOperationStartupRecordOwnership => {
    const snapshotRestoresPermit = providerOperationPhaseRestoresStartupPermit(snapshotRecord.phase);
    let existingPermit = state.providerOperationStartupPermits.get(snapshotRecord.operation.jobId);
    if (snapshotRecord.phase === 'local-recovery-pending' && existingPermit?.kind === 'undecided-provider-operation') {
      state.providerOperationStartupPermits.delete(snapshotRecord.operation.jobId);
      const release = startupOwnership.releaseLaunch(existingPermit.permit);
      if (release.kind === 'transferred') {
        return {
          phase: snapshotRecord.phase,
          operation: snapshotRecord.operation,
          restoredPermit: null,
          bindingDisposition: {
            kind: 'refused',
            reason: `Launch ownership transferred to ${JSON.stringify(release.holder)}.`,
            exit: 'remote-settlement',
          },
        };
      }
      existingPermit = undefined;
    }
    if (!snapshotRestoresPermit && existingPermit?.kind === 'undecided-provider-operation') {
      state.providerOperationStartupPermits.set(snapshotRecord.operation.jobId, {
        kind: 'operation',
        permit: existingPermit.permit,
        operationId: snapshotRecord.operation.operationId,
      });
    }
    const reusableExistingPermit =
      existingPermit !== undefined &&
      (existingPermit.kind === 'undecided-provider-operation' ||
        existingPermit.operationId === snapshotRecord.operation.operationId);
    const restoredPermit = snapshotRestoresPermit
      ? restoreProviderOperationStartupPermit(snapshotRecord.operation.jobId, {
          kind: 'operation',
          operationId: snapshotRecord.operation.operationId,
        })
      : reusableExistingPermit && existingPermit !== undefined
        ? existingPermit.permit
        : null;
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) {
      return releaseAbsentProviderOperationStartupOwnership(snapshotRecord, restoredPermit);
    }
    clearResolvedReadableAmbiguity(current);

    if (current.phase === 'settlement-pending') {
      return settleProviderOperationStartupOwnership(current, restoredPermit);
    }
    if (current.phase === 'local-recovery-pending') {
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition: { kind: 'not-required', owner: 'generic-job-recovery' },
      };
    }
    if (current.phase === 'prestart-cleanup-pending') {
      if (restoredPermit === null) {
        const reason = 'The provider prestart cleanup has no restored recovery permit.';
        const hold = holdProviderOperationStartupOwnership(current, reason);
        return resolveProviderOperationStartupHold(current, restoredPermit, hold, {
          kind: 'refused',
          reason,
          exit: 'restart-or-operator-repair',
        });
      }
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition: { kind: 'not-required', owner: 'prestart-cleanup' },
      };
    }
    if (restoredPermit === null) {
      const reason = 'The provider operation has no restored recovery permit.';
      const hold = holdProviderOperationStartupOwnership(current, reason);
      return resolveProviderOperationStartupHold(current, restoredPermit, hold, {
        kind: 'refused',
        reason,
        exit: 'restart-or-operator-repair',
      });
    }

    return prepareProviderOperationStartupBinding(restoredPermit, current);
  };

  const refuseAmbiguousProviderOperation = (
    snapshotRecord: ProviderOperationRecord,
    reason: string,
  ): ProviderOperationStartupRecordOwnership => {
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) {
      const restoredPermit = state.providerOperationStartupPermits.get(snapshotRecord.operation.jobId)?.permit ?? null;
      return {
        phase: snapshotRecord.phase,
        operation: snapshotRecord.operation,
        restoredPermit,
        bindingDisposition: {
          kind: 'not-reconciled',
          reason: 'record-absent',
          owner:
            restoredPermit === null
              ? { kind: 'generic-job-recovery' }
              : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
        },
      };
    }
    const hold = holdProviderOperationStartupOwnership(current, reason);
    const restoredPermit = state.providerOperationStartupPermits.get(current.operation.jobId)?.permit ?? null;
    switch (hold.kind) {
      case 'record-absent':
        return {
          phase: current.phase,
          operation: current.operation,
          restoredPermit,
          bindingDisposition: {
            kind: 'not-reconciled',
            reason: 'record-absent',
            owner:
              restoredPermit === null
                ? { kind: 'generic-job-recovery' }
                : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
          },
        };
      case 'settlement-pending':
        return {
          phase: hold.record.phase,
          operation: hold.record.operation,
          restoredPermit,
          bindingDisposition: settleProviderOperationStartupBinding(hold.record.operation),
        };
      case 'fenced':
        quarantineAmbiguousReadableProviderOperation(hold.record);
        return {
          phase: hold.record.phase,
          operation: hold.record.operation,
          restoredPermit,
          bindingDisposition: {
            kind: 'refused',
            reason,
            exit: 'coral-cli backend recovery-quarantine discard-provider-operation --allow-readable',
          },
        };
    }
    return assertNever(hold);
  };

  const holdReadableProviderOperationBesideUnreadable = (
    snapshotRecord: ProviderOperationRecord,
  ): ProviderOperationStartupRecordOwnership => {
    const current = readProviderOperation(progressStore.getDb(), snapshotRecord.operation);
    if (current === null) {
      const restoredPermit = state.providerOperationStartupPermits.get(snapshotRecord.operation.jobId)?.permit ?? null;
      return {
        phase: snapshotRecord.phase,
        operation: snapshotRecord.operation,
        restoredPermit,
        bindingDisposition: {
          kind: 'not-reconciled',
          reason: 'record-absent',
          owner:
            restoredPermit === null
              ? { kind: 'generic-job-recovery' }
              : { kind: 'provider-operation-recovery', holder: restoredPermit.holder },
        },
      };
    }
    if (current.phase === 'settlement-pending') {
      const owned = state.providerOperationStartupPermits.get(current.operation.jobId);
      const restoredPermit = owned?.kind === 'undecided-provider-operation' ? owned.permit : null;
      return {
        phase: current.phase,
        operation: current.operation,
        restoredPermit,
        bindingDisposition:
          restoredPermit === null
            ? settleProviderOperationStartupBinding(current.operation)
            : releaseRestoredPermitThroughSettlement(restoredPermit, current.operation),
      };
    }
    const reason = 'The job is also named by an unreadable provider operation record.';
    return refuseAmbiguousProviderOperation(current, reason);
  };

  const hydrateProviderOperationStartupOwnership = (
    snapshot: ProviderOperationStartupSnapshot,
  ): ProviderOperationStartupOwnership => {
    const readableSnapshotJobIds = new Set(snapshot.records.map((record) => record.operation.jobId));
    const settlementSnapshotJobIds = new Set(
      snapshot.records
        .filter((record) => record.phase === 'settlement-pending')
        .map((record) => record.operation.jobId),
    );
    const unreadableSubjects = snapshot.unreadable.flatMap((attribution) =>
      attribution.jobs.kind === 'known'
        ? attribution.jobs.values.map((jobId) => ({ recordKey: attribution.key, jobId }))
        : [],
    );
    const undecidedRecordKeysByJob = new Map<string, string[]>();
    for (const { jobId, recordKey } of unreadableSubjects) {
      const recordKeys = undecidedRecordKeysByJob.get(jobId) ?? [];
      recordKeys.push(recordKey);
      undecidedRecordKeysByJob.set(jobId, recordKeys);
    }
    for (const record of snapshot.records) {
      const recordKeys = undecidedRecordKeysByJob.get(record.operation.jobId);
      if (recordKeys === undefined) continue;
      recordKeys.push(providerOperationStartupRecordKey(record.operation));
    }
    const restoreUnreadablePermit = (jobId: string): LaunchPermit | null => {
      const status = progressStore.readStatus(jobId);
      if (
        settlementSnapshotJobIds.has(jobId) ||
        (status !== null && isTerminalPhase(status.phase) && !readableSnapshotJobIds.has(jobId))
      ) {
        return null;
      }
      const recordKeys = undecidedRecordKeysByJob.get(jobId);
      if (recordKeys === undefined) throw new Error(`Unreadable provider-operation ownership lost job ${jobId}.`);
      return restoreProviderOperationStartupPermit(jobId, { kind: 'undecided-provider-operation', recordKeys });
    };
    const unreadable = unreadableSubjects.map(({ recordKey, jobId }) => ({
      recordKey,
      jobId,
      restoredPermit: restoreUnreadablePermit(jobId),
    }));
    const unreadableJobIds = new Set(unreadable.map(({ jobId }) => jobId));
    const readableRecordCounts = new Map<string, number>();
    for (const record of snapshot.records) {
      readableRecordCounts.set(record.operation.jobId, (readableRecordCounts.get(record.operation.jobId) ?? 0) + 1);
    }
    for (const [jobId, count] of readableRecordCounts) {
      if (
        count > 1 &&
        snapshot.records.some(
          (record) => record.operation.jobId === jobId && providerOperationPhaseRestoresStartupPermit(record.phase),
        )
      ) {
        const recordKeys = snapshot.records
          .filter((record) => record.operation.jobId === jobId)
          .map((record) => providerOperationStartupRecordKey(record.operation));
        restoreProviderOperationStartupPermit(jobId, { kind: 'undecided-provider-operation', recordKeys });
      }
    }
    const records = snapshot.records.map((record) =>
      (readableRecordCounts.get(record.operation.jobId) ?? 0) > 1
        ? refuseAmbiguousProviderOperation(record, 'The job has more than one readable provider operation record.')
        : unreadableJobIds.has(record.operation.jobId)
          ? holdReadableProviderOperationBesideUnreadable(record)
          : hydrateProviderOperationStartupRecord(record),
    );
    const readableJobIds = records.flatMap((record) =>
      record.bindingDisposition.kind === 'not-reconciled' ? [] : [record.operation.jobId],
    );
    const holds = records.flatMap((record) =>
      record.bindingDisposition.kind === 'refused'
        ? [
            {
              kind: 'operation' as const,
              jobId: record.operation.jobId,
              operationId: record.operation.operationId,
              reason: record.bindingDisposition.reason,
              exit: record.bindingDisposition.exit,
            },
          ]
        : [],
    );
    const unreadableHolds = unreadable.flatMap((ownership) =>
      ownership.restoredPermit === null
        ? []
        : [
            {
              kind: 'unreadable-record' as const,
              jobId: ownership.jobId,
              recordKey: ownership.recordKey,
              reason: 'The provider operation record is unreadable, so its live ownership cannot be decided.',
              exit: 'coral-cli backend recovery-quarantine discard-provider-operation' as const,
            },
          ],
    );
    const startupHolds = [...holds, ...unreadableHolds];
    return Object.freeze({
      completion:
        startupHolds.length === 0
          ? Object.freeze({ kind: 'complete' as const })
          : Object.freeze({ kind: 'held' as const, holds: Object.freeze(startupHolds) }),
      jobIds: Object.freeze([
        ...new Set([
          ...readableJobIds,
          ...unreadable.flatMap(({ jobId }) => {
            const status = progressStore.readStatus(jobId);
            return status !== null && isTerminalPhase(status.phase) ? [] : [jobId];
          }),
        ]),
      ]),
      records: Object.freeze(records),
      unreadable: Object.freeze(unreadable),
    });
  };

  const adoptRepairedProviderOperationOwnership = (
    record: ProviderOperationRecord,
    recordKey?: string,
  ): ProviderOperationStartupRecordOwnership => {
    const owned = state.providerOperationStartupPermits.get(record.operation.jobId);
    if (owned?.kind === 'undecided-provider-operation' && recordKey !== undefined) {
      state.providerOperationStartupPermits.set(record.operation.jobId, {
        ...owned,
        recordKeys: owned.recordKeys.filter((candidate) => candidate !== recordKey),
      });
    }
    const scan = readProviderOperations(progressStore.getDb());
    const unreadable = attributeUnreadableProviderOperations(progressStore.getDb(), scan.unreadableKeys).filter(
      (attribution) => attribution.jobs.kind === 'known' && attribution.jobs.values.includes(record.operation.jobId),
    );
    const readableForJob = scan.records.filter((candidate) => candidate.operation.jobId === record.operation.jobId);
    const readableRecordKeys = readableForJob.map((candidate) =>
      providerOperationStartupRecordKey(candidate.operation),
    );
    if (unreadable.length > 0) {
      restoreProviderOperationStartupPermit(record.operation.jobId, {
        kind: 'undecided-provider-operation',
        recordKeys: [...unreadable.map((attribution) => attribution.key), ...readableRecordKeys],
      });
    }
    if (unreadable.length > 0) return holdReadableProviderOperationBesideUnreadable(record);
    if (readableForJob.length > 1) {
      restoreProviderOperationStartupPermit(record.operation.jobId, {
        kind: 'undecided-provider-operation',
        recordKeys: readableRecordKeys,
      });
      return refuseAmbiguousProviderOperation(record, 'The job has more than one readable provider operation record.');
    }
    return hydrateProviderOperationStartupRecord(record);
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
      const runningDisposition = await runRecoveryAdoption(
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
        return recoverQueuedItem(item, queued, retrySignal, ctx.coordinatorCommit, controls);
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
    const providerOperationFenceSnapshot = snapshotProviderOperationStartupOwnership();
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
      await runRecoveryAdoption({
        queuedJobs: queuedRecoverable,
        runningJobs: runningRecoverable,
        signal,
        coordinatorCommit: ctx.coordinatorCommit,
        interruptedAppServerReason,
        abandonHeldJob: (heldJobId) => abandonHeldRecoveryJob(heldJobId),
      });
    }
    const postReconciliationSnapshot = snapshotProviderOperationStartupOwnership();
    const postReconciliationOwnership = hydrateProviderOperationStartupOwnership(postReconciliationSnapshot);
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
        const hold = holdProviderOperationStartupOwnership(record, reason);
        const ownership = resolveProviderOperationStartupHold(record, null, hold, {
          kind: 'refused',
          reason,
          exit: 'restart-or-operator-repair',
        });
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
    retireAbsentSupersededProviderOperations,
    snapshotProviderOperationStartupOwnership,
    hydrateProviderOperationStartupOwnership,
    adoptRepairedProviderOperationOwnership,
    releaseProviderOperationStartupOwnership,
    releaseUnreadableProviderOperationStartupOwnership,
    recoverProviderOperationJob,
    completeProviderOperationJobRecovery,
    releaseAdoptedJob,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown,
  };
}
