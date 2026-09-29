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
import type { RecoverySourceFactoryPlan } from '../../../recovery/source-registry.js';
import type { Database } from '../../../store/db.js';
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
  type SupersededProviderOperationRetirementSummary,
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
    fault: (status) => ({ namespace: status.backendNamespace }),
    terminal: (status) => ({ namespace: status.backendNamespace }),
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
  onRecoverySettlement?: (jobId: string) => void;
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
  const { runCoordinatorWalk, settleClaim, settleFault, settleUnexpectedRecoveryFailure } = recoveryWalk;

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
    settleClaim,
    settleFault,
    settleUnexpectedRecoveryFailure,
    maybeReleaseRecoveryRegistry,
    abandonHeldJob: (jobId) => abandonHeldRecoveryJob(jobId),
  });
  const { completeProviderOperationJobRecovery, recoverProviderOperationJob } = operationRecovery;

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
  const runStartupRecovery = startupRecovery.run;

  if (bound !== null) {
    registerCoordinatorStartupRecovery(bound, runStartupRecovery);
  }
  return {
    runStartupRecovery,
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
