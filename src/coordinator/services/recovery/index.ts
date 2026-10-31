import type { JobAdmissionPort, JobLaunchRecoveryPort } from '../../../jobs/contracts/admission.js';
import type {
  ProviderOperationBindingPort,
  SettledUnboundStatusAbsence,
  SettledUnboundStatusHydrationPort,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import type { JobEventBus } from '../../../jobs/event-bus.js';
import type { RecoveryCapableService } from '../../../jobs/reconcile/contracts.js';
import type { RecoveryAbortDisposition, RecoveryRegistry } from '../../../jobs/reconcile/registry.js';
import type {
  ProviderOperationStartupOwnership,
  ProviderOperationStartupRecordOwnership,
} from '../../../jobs/startup.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobStore } from '../../../jobs/store.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type {
  RecoveryQuarantinePort,
  RecoveryQuarantineWrite,
  RecoverySettlementFact,
  RecoverySubject,
} from '../../../recovery/containment.js';
import {
  COORDINATOR_JOB_RECOVERY_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoverySourceFactoryPlan,
} from '../../../recovery/source-registry.js';
import type { Database } from '../../../store/db.js';
import { backendLog } from '../../../infra/backend-log.js';
import { isTerminalPhase } from '../../../jobs/phase.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import { registerCoordinatorStartupRecovery, type BoundCoordinator } from '../../handoff.js';
import { createRecoveryAdoption } from './adoption.js';
import { coordinatorJobRecoverySource, type RawCoordinatorJobRecoveryEnvelope } from './coordinator-job-source.js';
import { createRecoveryLifecycle } from './lifecycle.js';
import {
  createProviderOperationJobRecovery,
  type ProviderOperationRecoveryAcceptance,
} from './provider-operation-job-recovery.js';
import { createCoordinatorStartupRecovery, type RunCoordinatorStartupRecoveryFn } from './startup.js';
import {
  createSupersededProviderOperationMaintenance,
  type CoordinatorJobRecoveryStatus,
  type SupersededProviderOperationMaintenancePass,
} from './superseded-provider-operations.js';
import {
  createCoordinatorJobRecoveryRetryPolicy,
  createCoordinatorJobSettlementRefusalRecorderImplementation,
  createSettledUnboundStatusRetryPolicy,
  createUnreadableProviderOperationRetryPolicy,
  type RepairedProviderOperationAdoption,
} from './retry-plans.js';
import {
  createProviderOperationStartupOwnership,
  type ProviderOperationStartupRelease,
  type ProviderOperationStartupSnapshot,
  type SupersededProviderOperationRetirement,
  type UnreadableProviderOperationStartupResolution,
} from './provider-operation-startup-ownership.js';
import type { CoordinatorRecoveryItem } from './snapshot.js';
import type { SettlementRefusalRecorder } from '../../../jobs/contracts/admission.js';
import {
  settledUnboundStatusRecoverySource,
  type RawSettledUnboundStatusRecovery,
} from './settled-unbound-status-recovery-source.js';
import {
  unreadableProviderOperationRecoverySource,
  type RawUnreadableProviderOperationRecoveryRow,
} from './unreadable-provider-operation-recovery-source.js';
import {
  createRecoveryWalk,
  settleCoordinatorRecoveryItemWithProvenance,
  type CoordinatorSettlementOptions,
} from './walk.js';

function settleCoordinatorRecoveryItem(
  item: CoordinatorRecoveryItem,
  options: CoordinatorSettlementOptions,
): readonly RecoverySettlementFact[] {
  return settleCoordinatorRecoveryItemWithProvenance(item, options, {
    fault: (status) => ({ namespace: status.backendNamespace ?? undefined }),
    terminal: (status) => ({ namespace: status.backendNamespace ?? undefined }),
  });
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
    policy: createUnreadableProviderOperationRetryPolicy(adopt),
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
    policy: createSettledUnboundStatusRetryPolicy(quarantine, releaseAbsent),
  };
}

export function createCoordinatorJobSettlementRefusalRecorder(
  deps: Readonly<{
    getDb(): Database;
    isBoundaryRegistered(boundary: string): boolean;
    upsert(write: RecoveryQuarantineWrite): boolean;
  }>,
): SettlementRefusalRecorder {
  return createCoordinatorJobSettlementRefusalRecorderImplementation({
    ...deps,
    source: (jobId) => coordinatorJobRecoverySource(deps.getDb(), { subjectKey: jobId }),
  });
}

export function createCoordinatorJobRecoveryRetryPlan(
  db: Database,
  subject: RecoverySubject,
  signal: AbortSignal,
  quarantine: RecoveryQuarantinePort,
): RecoverySourceFactoryPlan<RawCoordinatorJobRecoveryEnvelope, CoordinatorRecoveryItem> {
  return {
    source: coordinatorJobRecoverySource(db, { subject }),
    policy: createCoordinatorJobRecoveryRetryPolicy(db, signal, quarantine),
  };
}

export interface RecoveryCoordinator {
  runStartupRecovery: RunCoordinatorStartupRecoveryFn;
  retireAbsentSupersededProviderOperations(): SupersededProviderOperationRetirement;
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
  passSupersededProviderOperations(): Promise<SupersededProviderOperationMaintenancePass>;
  getRecoveryRegistry(): RecoveryRegistry | null;
  isIdleBlocked(): boolean;
  teardown(): Promise<void>;
}

type RecoveryCoordinatorContext = {
  progressStore: JobStore;
  runtime: Runtime;
  runtimeState: { setLaunchFenceActive(active: boolean): void };
  eventBus: JobEventBus;
  onRecoverySettlement?: (jobId: string) => void;
  supersededProviderOperationPorts?: SupersededProviderOperationPorts;
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

function createRecoveryAdoptionFor(
  context: RecoveryCoordinatorContext,
  lifecycle: ReturnType<typeof createRecoveryLifecycle>,
  recoveryWalk: ReturnType<typeof createRecoveryWalk>,
): ReturnType<typeof createRecoveryAdoption> {
  return createRecoveryAdoption({
    state: lifecycle.state,
    progressStore: context.progressStore,
    runtime: context.runtime,
    eventBus: context.eventBus,
    getRecoveryService: context.getRecoveryService,
    createInvocationContext: context.createInvocationContext,
    log: context.log,
    clearRecoveryPoller: lifecycle.clearRecoveryPoller,
    startTrackedFinalization: lifecycle.startTrackedFinalization,
    observeDurableRecoveryContainment: lifecycle.observeDurableRecoveryContainment,
    runHeldRecoveryReap: lifecycle.runHeldRecoveryReap,
    deleteCoordinatorRecoveryQuarantine: recoveryWalk.deleteCoordinatorRecoveryQuarantine,
    runCoordinatorWalk: recoveryWalk.runCoordinatorWalk,
    settleUnexpectedRecoveryFailure: recoveryWalk.settleUnexpectedRecoveryFailure,
    settleFault: recoveryWalk.settleFault,
    takeAdoptedJobCleanup: lifecycle.takeAdoptedJobCleanup,
    maybeReleaseRecoveryRegistry: lifecycle.maybeReleaseRecoveryRegistry,
    settleCoordinatorRecoveryItem: recoveryWalk.settleCoordinatorRecoveryItem,
  });
}

export type SupersededProviderOperationPorts = Readonly<{
  adoptReadable(record: ProviderOperationRecord, recordKey: string): Promise<'accepted' | 'refused'>;
  retryRecoveryQuarantine(
    coordinate: Readonly<{ boundary: string; key: string; revision: string | null }>,
    signal: AbortSignal,
  ): Promise<'advanced' | 'held'>;
  onObligationChange(): void;
}>;

function coordinatorJobRecoveryStatus(
  quarantine: RecoveryQuarantineStore,
  jobId: string,
): CoordinatorJobRecoveryStatus {
  return quarantine.read(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId)?.state ?? 'none';
}

function providerOperationJobOwnership(
  progressStore: JobStore,
  jobId: string,
): 'settled' | 'owned' | 'undecided' | 'unowned' {
  const status = progressStore.readStatus(jobId);
  if (status === null || isTerminalPhase(status.phase)) return 'settled';
  const db = progressStore.getDb();
  const scan = readProviderOperations(db);
  if (scan.records.some((record) => record.operation.jobId === jobId)) return 'owned';
  const attributions = attributeUnreadableProviderOperations(db, scan.unreadableKeys);
  if (attributions.some(({ jobs }) => jobs.kind === 'indeterminate')) return 'undecided';
  return attributions.some(({ jobs }) => jobs.kind === 'known' && jobs.values.includes(jobId)) ? 'owned' : 'unowned';
}

export function createRecoveryCoordinator(
  context: RecoveryCoordinatorContext,
  bound: BoundCoordinator | null,
): RecoveryCoordinator {
  const {
    progressStore,
    runtime,
    runtimeState,
    eventBus,
    onRecoverySettlement,
    getRecoveryService,
    createInvocationContext,
    log,
    startupOwnership,
    supersededProviderOperationPorts,
  } = context;
  const providerOperationStartupOwnership = createProviderOperationStartupOwnership({
    progressStore,
    runtime,
    log,
    binding: startupOwnership,
  });
  const lifecycle = createRecoveryLifecycle({
    progressStore,
    runtime,
    runtimeState,
    eventBus,
    onRecoverySettlement,
    onPhaseChanged: providerOperationStartupOwnership.reclaimTerminalUndecided,
    releaseStartupOwnership: providerOperationStartupOwnership.releaseAll,
  });
  const { state, maybeReleaseRecoveryRegistry, releaseAdoptedJob, teardown } = lifecycle;

  const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);
  let abandonHeldRecoveryJob = (_jobId: string): RecoveryAbortDisposition => ({
    kind: 'refused',
    reason: 'durable containment abandonment is unavailable before recovery initialization',
  });

  const recoveryWalk = createRecoveryWalk({
    progressStore,
    runtime,
    eventBus,
    log,
    quarantine,
    source: (options) => coordinatorJobRecoverySource(progressStore.getDb(), options),
    settleCoordinatorRecoveryItem,
  });
  const { runCoordinatorWalk, settleFault, settleUnexpectedRecoveryFailure } = recoveryWalk;

  const recoveryAdoption = createRecoveryAdoptionFor(context, lifecycle, recoveryWalk);

  const operationRecovery = createProviderOperationJobRecovery({
    state,
    progressStore,
    runtime,
    getRecoveryService,
    createInvocationContext,
    recoveryAdoption,
    providerOperationStartupOwnership,
    runCoordinatorWalk,
    settleFault,
    settleUnexpectedRecoveryFailure,
    maybeReleaseRecoveryRegistry,
    abandonHeldJob: (jobId) => abandonHeldRecoveryJob(jobId),
  });
  const { completeProviderOperationJobRecovery, recoverProviderOperationJob } = operationRecovery;

  const retryQuarantined = async (boundary: string, key: string, signal: AbortSignal): Promise<'advanced' | 'held'> => {
    const status = quarantine.read(boundary, key);
    if (status === null) return 'advanced';
    if (supersededProviderOperationPorts === undefined) return 'held';
    const revision = status.subject.revision.kind === 'fingerprint' ? status.subject.revision.value : null;
    return supersededProviderOperationPorts.retryRecoveryQuarantine({ boundary, key, revision }, signal);
  };
  const supersededProviderOperations = createSupersededProviderOperationMaintenance({
    time: runtime.time,
    retire: providerOperationStartupOwnership.retireAbsentSupersededProviderOperations,
    releaseOwnership: providerOperationStartupOwnership.releaseUnreadable,
    resolveRetiredStatus: async (key, signal) =>
      providerOperationStartupOwnership.resolveRetiredStatus(key) ||
      (await retryQuarantined(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key, signal)) === 'advanced',
    adoptReadable: async (record, recordKey) =>
      (await supersededProviderOperationPorts?.adoptReadable(record, recordKey)) ?? 'refused',
    ownership: (jobId) => providerOperationJobOwnership(progressStore, jobId),
    recoveryStatus: (jobId) => coordinatorJobRecoveryStatus(quarantine, jobId),
    recoverJob: operationRecovery.recoverReleasedJob,
    retryRecovery: (jobId, signal) => retryQuarantined(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId, signal),
    completeRecovery: completeProviderOperationJobRecovery,
    onObligationChange: () => supersededProviderOperationPorts?.onObligationChange(),
    log: (message) => backendLog.warn(message),
  });

  const startupRecovery = createCoordinatorStartupRecovery({
    state,
    runtimeState,
    providerOperationStartupOwnership,
    recoveryAdoption,
    operationRecovery,
    recoveryWalk,
    lifecycle,
    setAbandonHeldJob: (handler) => {
      abandonHeldRecoveryJob = handler;
    },
  });
  const runStartupRecovery: RunCoordinatorStartupRecoveryFn = async (ctx) => {
    await supersededProviderOperations.quiesce();
    const disposition = await startupRecovery.run(ctx);
    supersededProviderOperations.start();
    return disposition;
  };

  if (bound !== null) {
    registerCoordinatorStartupRecovery(bound, runStartupRecovery);
  }
  return {
    runStartupRecovery,
    retireAbsentSupersededProviderOperations: () => {
      const retirement = providerOperationStartupOwnership.retireAbsentSupersededProviderOperations();
      supersededProviderOperations.trackStartupRetirement(retirement);
      return retirement;
    },
    snapshotProviderOperationStartupOwnership: providerOperationStartupOwnership.snapshot,
    hydrateProviderOperationStartupOwnership: providerOperationStartupOwnership.hydrate,
    adoptRepairedProviderOperationOwnership: providerOperationStartupOwnership.adoptRepaired,
    releaseProviderOperationStartupOwnership: providerOperationStartupOwnership.release,
    releaseUnreadableProviderOperationStartupOwnership: providerOperationStartupOwnership.releaseUnreadable,
    recoverProviderOperationJob,
    completeProviderOperationJobRecovery,
    releaseAdoptedJob,
    passSupersededProviderOperations: supersededProviderOperations.pass,
    getRecoveryRegistry: () => state.recoveryRegistry,
    isIdleBlocked: () => state.adoptedRunningPids.size > 0 || (state.recoveryRegistry?.size ?? 0) > 0,
    teardown: async () => {
      await supersededProviderOperations.stop();
      return teardown();
    },
  };
}
