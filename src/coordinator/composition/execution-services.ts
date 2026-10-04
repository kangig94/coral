import { readLaunchStatus, recordControllerEvidenceRefusals } from '../../infra/launch-status.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { join } from 'node:path';
import { resolveCurrentStoreEpoch } from '../../store/epoch/index.js';
import type { ProjectRequestPort, ExecutionServiceDeps } from '../contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SettlementRefusalRecorder } from '../../jobs/contracts/admission.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { CoordinatorWorld } from './world.js';
import { subscribeJobEvents } from '../../jobs/shell/event-subscription.js';
import { prepareCached } from '../../store/db.js';
import { aggregateWorkflowUsage } from '../../jobs/workflow-usage.js';
import { admittedByThisCoordinator, createObserveCarriers } from './carrier-observation.js';
import { observeCarrierStatuses } from '../live/carrier-observer.js';
import { createAppServerProxyRoute } from '../services/provider-proxy-launch-route.js';
import { currentSuccessionAttemptChild } from '../succession/attempt-child.js';
import { acceptedControllerTransferHandsCapsule } from '../succession/provider-host-transfer.js';
import {
  ProviderOperationReconciler,
  type ProviderOperationReconcilerFatalError,
  type ProviderOperationReconcilerStopDisposition,
  type ProviderStopDecision,
  StartupSetRecoveryProducer,
  type StartupReconciliationReport,
} from '../services/provider-operation-reconciler.js';
import type { ProviderStopCause } from '../../providers/contract.js';
import {
  notifyProviderProxyControlEstablished,
  subscribeProviderProxyControlEstablished,
} from '../live/provider-proxy/operation-route.js';
import { reobserveDurableProviderProxyAcquisitionContainment } from '../live/provider-proxy/spawn-undo.js';
import { backendLog } from '../../infra/backend-log.js';
import { createRecordedProcessObserver } from '../../infra/node-process.js';
import { assertNever } from '../../infra/error-format.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type { ProviderOperationStartupOwnership } from '../../jobs/startup.js';
import { ProviderOperationCleanupRouter } from '../../jobs/provider-operation-cleanup.js';
import { readProviderOperationJobLaunch } from '../../jobs/provider-operation-state.js';
import { readProjectionProviderSession } from '../../sessions/projections.js';
import { materializeProviderOperationPrepare } from '../services/provider-operation-prepare.js';
import { terminalizeProviderOperation } from '../../jobs/provider-operation-terminalization.js';
import type { RecoveryCoordinator } from '../services/recovery/index.js';
import {
  quarantineUnreadableProviderOperations,
  type RepairedProviderOperationAdoption,
} from '../services/recovery/retry-plans.js';
import {
  attributeUnreadableProviderOperations,
  providerOperationMutationAdmission,
  readProviderOperation,
  readProviderOperations,
  subscribeProviderOperationMutations,
} from '../../store/provider-operation-journal.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import type {
  ProviderOperationAdoptionRefusal,
  ProviderOperationStartupOwnershipReleaseDisposition,
} from '../../recovery/unreadable-provider-operation.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
} from '../services/provider-proxy-set/identity.js';
import { ProviderProxySetLifecycle } from '../services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '../services/provider-proxy-set/operator-disposition-store.js';
import {
  authorizeProviderProxySetContainmentProof,
  runProviderProxySetContainmentProofMutation,
} from '../services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetLifecycleFatalError } from '../services/provider-proxy-recovery-policy.js';
import {
  discoverProviderHandoffCapsules,
  retireProviderHandoffCapsule,
} from '../services/provider-proxy-capsule-discovery.js';
import { proxyOperationStatusNonceSchema } from '../../provider-proxy/protocol.js';
import {
  providerProxySetAvailabilityReason,
  type ProviderProxySetInheritanceOutcome,
} from '../services/provider-proxy-set/inheritance.js';
import {
  recoverProviderProxySetAtStartup,
  recoverProviderProxySetOrdinarily,
} from '../services/provider-proxy-set/inheritance.js';
import {
  createProviderProxyRecoveryDispatcher,
  providerProxyRecoveryRoleControlPort,
} from '../services/provider-proxy-recovery-policy.js';

type CreateExecutionServicesDeps = {
  world: CoordinatorWorld;
  runtime: Runtime;
  getActiveEpochPath?: () => string | null;
  currentJobEpochKey?: () => string | null;
  bundleHash: string;
  backendNamespace: string;
  settlementRefusalRecorder: SettlementRefusalRecorder;
  createExecutionService: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
  onProviderProxyLifecycleFatal(
    error: ProviderProxySetLifecycleFatalError | ProviderOperationReconcilerFatalError,
  ): void;
  onProviderProxySlotReleased?(): void;
  onProviderOperationRemoved?(): void;
};

type ExecutionServicesState = {
  providerOperationRecovery: RecoveryCoordinator | null;
  unsubscribeProviderOperationMutations: (() => void) | null;
  providerProxyClaimsInitialized: boolean;
  providerProxyLifecycleInitialized: boolean;
};

function listInstantiatedExecutionServices(services: ReadonlyMap<string, ProjectRequestPort>): ProjectRequestPort[] {
  return [...services.values()];
}

function createExecutionServiceRegistry(input: {
  services: Map<string, ProjectRequestPort>;
  deps: CreateExecutionServicesDeps;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  providerOperationReconciler: ProviderOperationReconciler;
  providerOperationCleanup: ProviderOperationCleanupRouter;
}) {
  const { services, getProgressStore, providerOperationReconciler, providerOperationCleanup } = input;
  const { world, runtime, bundleHash, backendNamespace, settlementRefusalRecorder, createExecutionService } =
    input.deps;
  function getExecutionService(ctx: InvocationContext): ProjectRequestPort {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const progressStore = getProgressStore();
    const getCurrentJournalSeq = (): number =>
      prepareCached<[], { seq: number }>(
        getProgressStore().getDb(),
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM events',
      ).get()?.seq ?? 0;
    const created = createExecutionService(ctx, {
      runtime,
      progressStore,
      bundleHash,
      backendNamespace,
      launchCoordinator: world.launchCoordinator,
      settlementRefusalRecorder,
      eventBus: world.eventBus,
      providerRegistry: world.providerRegistry,
      childPrincipalRegistry: world.childPrincipalRegistry,
      pluginRegistry: world.pluginRegistry,
      coordinatorCommit: (cb) => getProgressStore().commit(cb),
      loadJobProjectionDetail: (jobId) => getProgressStore().loadJobProjectionDetail(jobId),
      readJobEvents: (jobId: string, afterSeq?: number) => getProgressStore().readJobEvents(jobId, false, afterSeq),
      aggregateWorkflowUsage: (workflowJobId) => aggregateWorkflowUsage(getProgressStore().getDb(), workflowJobId),
      subscribeJobEvents,
      getCurrentJournalSeq,
      currentJobEpochKey: input.deps.currentJobEpochKey,
      observeResultAvailability: (jobId) => getProgressStore().getResultExportOwner().observeResultAvailability(jobId),
      hintResultRepair: (jobId) => getProgressStore().getResultExportOwner().hintRepair(jobId),
      appServerProxyRoute: createAppServerProxyRoute({
        hostManager: world.providerHostManager,
        reconciler: providerOperationReconciler,
        now: () => runtime.time.now(),
      }),
      operations: { stop: (jobId, cause) => providerOperationReconciler.requestStop(jobId, cause) },
      providerOperationCleanup,
      observeCarriers: createObserveCarriers(
        {
          getDb: () => getProgressStore().getDb(),
          loadJobProjectionDetail: (jobId) => getProgressStore().loadJobProjectionDetail(jobId),
          platform: runtime.env.platform() as NodeJS.Platform,
          hasStartupRecoveryPassed: () => world.startupRecoveryBarrier.hasPassed(),
          isAdmittedByThisCoordinator: (jobId) => admittedByThisCoordinator(world.launchCoordinator, jobId),
          registryStateForJob: (jobId) => world.operationRegistry.stateForJob(jobId),
          holdsLocalAppServerExecution: (jobId) =>
            [...services.values()].some((service) => service.holdsLocalAppServerExecution?.(jobId) === true),
        },
        getCurrentJournalSeq,
        (records) =>
          observeCarrierStatuses(records, {
            timer: runtime.time,
            mintNonce: () => proxyOperationStatusNonceSchema.parse(runtime.ids.uuid()),
            log: (report) =>
              backendLog.warn(
                `carrier status pass dropped ${report.droppedRows} rows across ${report.droppedEndpointRequests} requests`,
              ),
          }),
      ),
    });
    services.set(key, created);
    return created;
  }

  function getRecoveryService(ctx: InvocationContext): RecoveryCapableService {
    return getExecutionService(ctx) as unknown as RecoveryCapableService;
  }

  function listExecutionServices(): ProjectRequestPort[] {
    return listInstantiatedExecutionServices(services);
  }

  return { getExecutionService, getRecoveryService, listExecutionServices };
}

function createExecutionStartupSetRecovery(input: {
  runtime: Runtime;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  authorityFor: (record: ProviderOperationRecord) => ReturnType<ProviderProxySetLifecycle['authorityFor']>;
  providerProxyInheritance: CoordinatorWorld['providerProxyInheritance'];
  recoverSet: (record: ProviderOperationRecord, signal: AbortSignal) => Promise<ProviderProxySetInheritanceOutcome>;
  acceptContainmentAbsence: ProviderProxySetLifecycle['containmentAbsent'];
}): StartupSetRecoveryProducer {
  const { runtime, getProgressStore, authorityFor, providerProxyInheritance, recoverSet, acceptContainmentAbsence } =
    input;
  return new StartupSetRecoveryProducer(async (work, signal) => {
    const representative = work.operations
      .map((operation) => readProviderOperation(getProgressStore().getDb(), operation))
      .find((record): record is ProviderOperationRecord => record !== null);
    if (representative === undefined) {
      throw new Error(`provider_proxy_startup_set_representative_missing:${work.key}`);
    }
    if (!providerProxySetIdentitiesEqual(providerProxySetIdentityFromRecord(representative), work.identity)) {
      throw new Error(`provider_proxy_startup_set_identity_changed:${work.key}`);
    }
    const live = authorityFor(representative);
    if (live !== null) return { kind: 'authority', authority: live };
    if (providerProxyInheritance === undefined) {
      return {
        kind: 'retry-scheduled',
        reason: 'Provider proxy set inheritance is not configured.',
        nextAttemptAtMs: runtime.time.now() + 25,
      };
    }
    const outcome = await recoverSet(representative, signal);
    switch (outcome.kind) {
      case 'inherited':
        return { kind: 'authority', authority: outcome.set };
      case 'containment-disappeared':
        return {
          kind: 'absence-accepted',
          acceptance: acceptContainmentAbsence(work.identity, outcome.disappearanceReceipt),
        };
      case 'recorded-group-unattributable':
        return {
          kind: 'retry-scheduled',
          reason: 'The recorded leader identity is gone, but the surviving process group cannot be attributed.',
          nextAttemptAtMs: runtime.time.now() + 25,
        };
      case 'signal-authorization-refused':
        return {
          kind: 'retry-scheduled',
          reason: 'Signal authorization could not be established for every recorded-containment target.',
          nextAttemptAtMs: runtime.time.now() + 25,
        };
      case 'identity-unobservable':
        return {
          kind: 'retry-scheduled',
          reason: outcome.signalDelivered
            ? 'Process identity became unobservable after a recorded-containment signal was delivered.'
            : 'Process identity could not be observed before recorded-containment signal authorization.',
          nextAttemptAtMs: runtime.time.now() + 25,
        };
      case 'not-bequeathed':
        return {
          kind: 'retry-scheduled',
          reason: outcome.reason,
          nextAttemptAtMs: runtime.time.now() + 25,
        };
      case 'temporarily-unavailable':
        return {
          kind: 'retry-scheduled',
          reason: providerProxySetAvailabilityReason(outcome.incident),
          nextAttemptAtMs: runtime.time.now() + 25,
        };
      default:
        return assertNever(outcome);
    }
  });
}

function createExecutionProviderProxyProducers(input: {
  world: CoordinatorWorld;
  runtime: Runtime;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  providerProxyInheritance: CoordinatorWorld['providerProxyInheritance'];
  getReconciler: () => ProviderOperationReconciler;
}): Parameters<typeof createProviderProxyRecoveryDispatcher>[0]['producers'] {
  const { world, runtime, getProgressStore, providerProxyInheritance, getReconciler } = input;
  return {
    'disappearance-terminalization': ({ record, directive }) =>
      terminalizeProviderOperation(getProgressStore(), record, directive, runtime.time.now()),
    'role-control': providerProxyRecoveryRoleControlPort,
    'set-inheritance': ({ locator, db, signal }) => {
      if (providerProxyInheritance === undefined) {
        return Promise.reject(new Error('Provider proxy set inheritance is not configured.'));
      }
      return providerProxyInheritance.inheritProviderProxySet(locator, db, signal);
    },
    'capsule-redemption': ({ capsule, capsulePath, signal }) => {
      if (providerProxyInheritance === undefined) {
        return Promise.reject(new Error('Provider proxy capsule redemption is not configured.'));
      }
      return providerProxyInheritance.redeemDiscoveredCapsule(capsule, capsulePath, signal);
    },
    'containment-proof': ({ identity, signal }) => {
      const db = getProgressStore().getDb();
      const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
      return world.providerProxySetContainmentProver.collectContainmentProof(
        authorizeProviderProxySetContainmentProof(identity, {
          mutationFence,
          closeAdmission: async () => {
            if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
          },
        }),
        db,
        signal,
      );
    },
    'capsule-retirement': ({ path }) => retireProviderHandoffCapsule(runtime.storage, path),
    'disappearance-consumer': ({ notice, mutationProof }) => {
      const consumeDisappearance = () => getReconciler().containmentDisappeared(notice);
      return mutationProof === undefined
        ? consumeDisappearance()
        : runProviderProxySetContainmentProofMutation(
            mutationProof,
            notice.setIdentity,
            'provider-containment-disappearance-fenced-release',
            consumeDisappearance,
          );
    },
    'representation-abandonment-consumer': ({ notice, mutationProof }) => {
      const consumeAbandonment = () => getReconciler().representationAbandoned(notice);
      return mutationProof === undefined
        ? consumeAbandonment()
        : runProviderProxySetContainmentProofMutation(
            mutationProof,
            notice.setIdentity,
            'provider-representation-abandonment-fenced-release',
            consumeAbandonment,
          );
    },
  };
}

function createOrdinaryProviderAuthorityAcquirer(input: {
  authorityFor: (record: ProviderOperationRecord) => ReturnType<ProviderProxySetLifecycle['authorityFor']>;
  providerProxyInheritance: CoordinatorWorld['providerProxyInheritance'];
  recoverSet: (record: ProviderOperationRecord, signal: AbortSignal) => Promise<ProviderProxySetInheritanceOutcome>;
  recordContainmentAbsence: ProviderProxySetLifecycle['containmentAbsent'];
}): ConstructorParameters<typeof ProviderOperationReconciler>[0]['acquireAuthority'] {
  const { authorityFor, providerProxyInheritance, recoverSet, recordContainmentAbsence } = input;
  return async (record, signal) => {
    const live = authorityFor(record);
    if (live !== null || providerProxyInheritance === undefined) return live;
    const outcome = await recoverSet(record, signal);
    switch (outcome.kind) {
      case 'inherited':
        return outcome.set;
      case 'not-bequeathed':
        return null;
      case 'temporarily-unavailable':
        return {
          kind: 'temporarily-unavailable',
          reason: providerProxySetAvailabilityReason(outcome.incident),
        };
      case 'recorded-group-unattributable':
        return {
          kind: 'temporarily-unavailable',
          reason: 'The recorded leader identity is gone, but the surviving process group cannot be attributed.',
        };
      case 'signal-authorization-refused':
        return {
          kind: 'temporarily-unavailable',
          reason: 'Signal authorization could not be established for every recorded-containment target.',
        };
      case 'identity-unobservable':
        return {
          kind: 'temporarily-unavailable',
          reason: outcome.signalDelivered
            ? 'Process identity became unobservable after a recorded-containment signal was delivered.'
            : 'Process identity could not be observed before recorded-containment signal authorization.',
        };
      case 'containment-disappeared':
        recordContainmentAbsence(providerProxySetIdentityFromRecord(record), outcome.disappearanceReceipt);
        return null;
      default:
        return assertNever(outcome);
    }
  };
}

function createExecutionOperationReconciler(input: {
  deps: CreateExecutionServicesDeps;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  authorityFor: (record: ProviderOperationRecord) => ReturnType<ProviderProxySetLifecycle['authorityFor']>;
  startupSetRecovery: StartupSetRecoveryProducer;
  providerProxyRecovery: ReturnType<typeof createProviderProxyRecoveryDispatcher>;
  getRecoveryCoordinator: () => RecoveryCoordinator | null;
  acquireAuthority: ConstructorParameters<typeof ProviderOperationReconciler>[0]['acquireAuthority'];
  initializeAtStartup: (signal: AbortSignal) => Promise<void>;
}): ProviderOperationReconciler {
  const {
    world,
    runtime,
    getActiveEpochPath,
    backendNamespace,
    onProviderProxyLifecycleFatal,
    onProviderOperationRemoved,
  } = input.deps;
  const {
    getProgressStore,
    authorityFor,
    startupSetRecovery,
    providerProxyRecovery,
    getRecoveryCoordinator,
    acquireAuthority,
    initializeAtStartup,
  } = input;
  return new ProviderOperationReconciler({
    getProgressStore,
    custody: () => {
      const activeEpochPath = getActiveEpochPath?.();
      const dbDir = runtime.paths.coral.store.dbDir;
      const epoch =
        activeEpochPath === undefined || activeEpochPath === null
          ? resolveCurrentStoreEpoch(runtime.storage, dbDir)
          : null;
      if ((activeEpochPath === null || activeEpochPath === undefined) && epoch === null) {
        throw new Error('Provider operation custody requires a selected store epoch.');
      }
      return {
        runtime,
        runDir: runtime.paths.coral.coordinator.runDir,
        epoch: activeEpochPath ?? join(dbDir, `epoch-${epoch}`),
        nowMs: runtime.time.now(),
        bindWithinMs: 10_000,
      };
    },
    authorityFor,
    acquireAuthority,
    startupSetRecovery,
    initializeAtStartup,
    registry: world.operationRegistry,
    binding: world.launchCoordinator,
    releaseStartupOwnership: (operation) =>
      getRecoveryCoordinator()?.releaseProviderOperationStartupOwnership(operation) ?? { kind: 'not-owned' },
    materializePrepare: (record) =>
      materializeProviderOperationPrepare(
        {
          runtime,
          providerRegistry: world.providerRegistry,
          childPrincipalRegistry: world.childPrincipalRegistry,
          readJobLaunch: (jobId, eventSeq) => readProviderOperationJobLaunch(getProgressStore(), jobId, eventSeq),
          readSession: (sessionId) => readProjectionProviderSession(getProgressStore().getDb(), sessionId),
        },
        record.operation,
        record.prepareSource,
      ),
    recoverLocalJob: (record, signal) => {
      const recoveryCoordinator = getRecoveryCoordinator();
      if (recoveryCoordinator === null) {
        return Promise.reject(new Error('Provider operation recovery is not connected.'));
      }
      return recoveryCoordinator.recoverProviderOperationJob(record, signal);
    },
    completeLocalRecovery: (jobId) => getRecoveryCoordinator()?.completeProviderOperationJobRecovery(jobId),
    terminalization: {
      terminalize: (record, directive) =>
        terminalizeProviderOperation(getProgressStore(), record, directive, runtime.time.now()),
    },
    recoveryDispatcher: providerProxyRecovery,
    backendNamespace,
    time: runtime.time,
    onFatal: onProviderProxyLifecycleFatal,
    onError: (message) => backendLog.warn(message),
    onRecordRemoved: () => onProviderOperationRemoved?.(),
  });
}

function createExecutionProxyLifecycle(input: {
  world: CoordinatorWorld;
  runtime: Runtime;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  providerProxyRecovery: ReturnType<typeof createProviderProxyRecoveryDispatcher>;
  onProviderProxySlotReleased: CreateExecutionServicesDeps['onProviderProxySlotReleased'];
}): ProviderProxySetLifecycle {
  const { world, runtime, getProgressStore, providerProxyRecovery, onProviderProxySlotReleased } = input;
  return new ProviderProxySetLifecycle({
    buildSetId: world.identity.buildSetId,
    acceptsControllerTransfer: (capsule) =>
      acceptedControllerTransferHandsCapsule(
        runtime,
        world.identity.buildSetId,
        currentSuccessionAttemptChild()?.attemptId ?? null,
        capsule,
      ),
    claims: world.providerProxyClaims,
    controlEstablished: notifyProviderProxyControlEstablished,
    time: runtime.time,
    recoveryDispatcher: providerProxyRecovery,
    reapRecordedContainment: world.reapRecordedContainment,
    operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(
      runtime.storage,
      runtime.paths.coral.coordinator.runDir,
    ),
    writerIncarnation: world.identity.instanceId,
    collectOperatorDispositionContainmentProof: (identity, signal) => {
      const db = getProgressStore().getDb();
      const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
      return world.providerProxySetContainmentProver.collectContainmentProof(
        authorizeProviderProxySetContainmentProof(identity, {
          mutationFence,
          closeAdmission: async () => {
            if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
          },
        }),
        db,
        signal,
      );
    },
    reobserveAcquisitionContainment: (subject, signal) =>
      reobserveDurableProviderProxyAcquisitionContainment(runtime, subject, signal),
    fenceProviderOperationMutations: (identity) =>
      providerOperationMutationAdmission(getProgressStore().getDb()).closeSet(identity),
    onProgressPremiseViolation: (violation) =>
      backendLog.warn(
        `Provider proxy lifecycle ${violation.stage} woke ${violation.latenessMs}ms after its requested time.`,
      ),
    reportLifecycle: (severity, message) => backendLog[severity](message),
    onError: (message) => backendLog.warn(message),
    onSlotReleased: (routeKey) => {
      world.providerHostManager.providerProxySlotReleased?.(routeKey);
      onProviderProxySlotReleased?.();
    },
  });
}

function createRepairedProviderOperationAdopter(input: {
  world: CoordinatorWorld;
  state: ExecutionServicesState;
  providerProxyLifecycle: ProviderProxySetLifecycle;
  providerOperationReconciler: ProviderOperationReconciler;
}): (record: ProviderOperationRecord, recordKey?: string) => Promise<RepairedProviderOperationAdoption> {
  const { world, state, providerProxyLifecycle, providerOperationReconciler } = input;
  return async (record: ProviderOperationRecord, recordKey?: string): Promise<RepairedProviderOperationAdoption> => {
    if (!state.providerProxyClaimsInitialized || !state.providerProxyLifecycleInitialized) {
      return {
        kind: 'refused',
        reason: 'the provider operation ownership path is not initialized',
        remedy: { kind: 'restart-coordinator' },
      };
    }
    if (state.providerOperationRecovery === null) {
      return {
        kind: 'refused',
        reason: 'provider operation recovery ownership is not connected',
        remedy: { kind: 'restart-coordinator' },
      };
    }

    const ownership = state.providerOperationRecovery.adoptRepairedProviderOperationOwnership(record, recordKey);
    if (ownership.bindingDisposition.kind === 'refused') {
      return {
        kind: 'refused',
        reason: ownership.bindingDisposition.reason,
        remedy: ownership.bindingDisposition.remedy,
      };
    }
    if (ownership.bindingDisposition.kind === 'not-reconciled') {
      return {
        kind: 'refused',
        reason: `the repaired provider operation is ${ownership.bindingDisposition.reason}`,
        remedy: { kind: 'external-repair' },
      };
    }

    world.providerProxyClaims.applyMutation({ kind: 'upserted', record });
    const setIdentity = providerProxySetIdentityFromRecord(record);
    const accepted = world.providerProxyClaims.claimFor(record.operation);
    if (accepted === null || !providerProxySetIdentitiesEqual(accepted.setIdentity, setIdentity)) {
      return {
        kind: 'refused',
        reason: 'the provider operation claim mirror did not retain the decoded record',
        remedy: { kind: 'external-repair' },
      };
    }
    providerProxyLifecycle.claimsChanged(setIdentity);
    await providerOperationReconciler.reconcile(record);
    return { kind: 'accepted', owner: 'provider-operation-reconciler' };
  };
}

function createProviderProxyClaimsInitializer(input: {
  world: CoordinatorWorld;
  runtime: Runtime;
  getProgressStore: () => ReturnType<CoordinatorWorld['storeServicesRef']['get']>['progressStore'];
  providerProxyLifecycle: ProviderProxySetLifecycle;
  state: ExecutionServicesState;
}): () => Promise<void> {
  const { world, runtime, getProgressStore, providerProxyLifecycle, state } = input;
  return async (): Promise<void> => {
    if (state.providerProxyClaimsInitialized) return;
    const db = getProgressStore().getDb();
    const scan = readProviderOperations(db);
    world.providerProxyClaims.initialize(scan.records);

    if (scan.unreadableKeys.length > 0) {
      const quarantineReport = await quarantineUnreadableProviderOperations(
        new RecoveryQuarantineStore(db, runtime.time),
        attributeUnreadableProviderOperations(db, scan.unreadableKeys),
      );
      backendLog.warn(
        `Quarantined ${quarantineReport.materialized} provider operation record(s) this build cannot read; ` +
          `retained ${quarantineReport.retained} existing durable quarantine status(es); ` +
          `${quarantineReport.failed.length} materialization failure(s): ` +
          `${quarantineReport.failed.map(({ key }) => key).join(', ') || 'none'}`,
      );
    }
    state.unsubscribeProviderOperationMutations = subscribeProviderOperationMutations(db, (mutation) => {
      world.providerProxyClaims.applyMutation(mutation);
      providerProxyLifecycle.claimsChanged(providerProxySetIdentityFromRecord(mutation.record));
    });
    state.providerProxyClaimsInitialized = true;
  };
}

function createUnreadableProviderOperationRelease(input: {
  state: ExecutionServicesState;
  adoptRepairedProviderOperation: (
    record: ProviderOperationRecord,
    recordKey?: string,
  ) => Promise<RepairedProviderOperationAdoption>;
}): (recordKey: string) => Promise<ProviderOperationStartupOwnershipReleaseDisposition> {
  const { state, adoptRepairedProviderOperation } = input;
  return async (recordKey) => {
    const resolution = state.providerOperationRecovery?.releaseUnreadableProviderOperationStartupOwnership(recordKey);
    if (resolution === undefined) return { kind: 'completed', releasedLaunchPermits: 0 };
    const refusals: ProviderOperationAdoptionRefusal[] = [];
    for (const readable of resolution.readableRecords) {
      const adoption = await adoptRepairedProviderOperation(readable.record, readable.recordKey);
      if (adoption.kind === 'accepted') continue;
      refusals.push({
        recordKey: readable.recordKey,
        jobId: readable.record.operation.jobId,
        operationId: readable.record.operation.operationId,
        proxyInstanceId: readable.record.operation.proxyInstanceId,
        buildSetId: readable.record.operation.buildSetId,
        reason: adoption.reason,
        remedy: adoption.remedy,
      });
    }
    return refusals.length === 0
      ? { kind: 'completed', releasedLaunchPermits: resolution.released }
      : { kind: 'adoption-refused', releasedLaunchPermits: resolution.released, refusals };
  };
}

type ExecutionServices = {
  getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
  adoptRepairedProviderOperation: (
    record: ProviderOperationRecord,
    recordKey?: string,
  ) => Promise<RepairedProviderOperationAdoption>;
  releaseUnreadableProviderOperationStartupOwnership: (
    recordKey: string,
  ) => Promise<ProviderOperationStartupOwnershipReleaseDisposition>;
  connectProviderOperationRecovery: (recoveryCoordinator: RecoveryCoordinator) => void;
  reconcileProviderOperationsAtStartup: (
    ownership: ProviderOperationStartupOwnership,
    signal: AbortSignal,
  ) => Promise<StartupReconciliationReport>;
  startProviderOperationReconciler: () => void;
  providerOperationStartupStatus: ProviderOperationReconciler['startupStatus'];
  wakeProviderOperationReconciler: () => void;
  stopProviderOperationReconciler: () => ProviderOperationReconcilerStopDisposition;
  requestStops: (jobIds: readonly string[], cause: ProviderStopCause) => ProviderStopDecision;
};

function createExecutionServicePorts(input: {
  state: ExecutionServicesState;
  services: Pick<ExecutionServices, 'getExecutionService' | 'getRecoveryService' | 'listExecutionServices'>;
  adoptRepairedProviderOperation: ExecutionServices['adoptRepairedProviderOperation'];
  providerOperationReconciler: ProviderOperationReconciler;
  unsubscribeProviderProxyControlEstablished: () => void;
}): ExecutionServices {
  const {
    state,
    services,
    adoptRepairedProviderOperation,
    providerOperationReconciler,
    unsubscribeProviderProxyControlEstablished,
  } = input;
  const { getExecutionService, getRecoveryService, listExecutionServices } = services;
  return {
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
    adoptRepairedProviderOperation,
    releaseUnreadableProviderOperationStartupOwnership: createUnreadableProviderOperationRelease({
      state,
      adoptRepairedProviderOperation,
    }),
    connectProviderOperationRecovery: (recoveryCoordinator) => {
      state.providerOperationRecovery = recoveryCoordinator;
    },
    reconcileProviderOperationsAtStartup: (ownership, signal) =>
      providerOperationReconciler.reconcileAtStartup(ownership, signal),
    startProviderOperationReconciler: () => providerOperationReconciler.start(),
    providerOperationStartupStatus: () => providerOperationReconciler.startupStatus(),
    wakeProviderOperationReconciler: () => providerOperationReconciler.wake(),
    requestStops: (jobIds, cause) => providerOperationReconciler.requestStops(jobIds, cause),
    stopProviderOperationReconciler: () => {
      const disposition = providerOperationReconciler.stop();
      unsubscribeProviderProxyControlEstablished();
      if (disposition.kind === 'drained') {
        state.unsubscribeProviderOperationMutations?.();
        state.unsubscribeProviderOperationMutations = null;
      }
      return disposition;
    },
  };
}

function createExecutionServiceContext(world: CoordinatorWorld) {
  const services = new Map<string, ProjectRequestPort>();
  const state: ExecutionServicesState = {
    providerOperationRecovery: null,
    unsubscribeProviderOperationMutations: null,
    providerProxyClaimsInitialized: false,
    providerProxyLifecycleInitialized: false,
  };
  const storeServicesRef = world.storeServicesRef;
  const providerOperationCleanup = new ProviderOperationCleanupRouter();
  world.operationRegistry.connectCleanup(providerOperationCleanup);
  world.operationRegistry.connectBinding(world.launchCoordinator);
  const getProgressStore = () => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) throw new Error('Coordinator store services are not connected.');
    return storeServices.progressStore;
  };
  return { services, state, providerOperationCleanup, getProgressStore };
}

function activateProviderProxyLifecycle(lifecycle: ProviderProxySetLifecycle): void {
  const activation = lifecycle.activateDurableOperatorDispositions();
  if (activation.kind === 'held') {
    throw new Error(
      `Durable provider proxy disposition activation remains held pending store repair: ${activation.reason}`,
    );
  }
  lifecycle.initializeClaimSlots();
}

async function reconcileProviderProxyLifecycle(
  lifecycle: ProviderProxySetLifecycle,
  signal: AbortSignal,
): Promise<void> {
  const durableReconciliation = await lifecycle.reconcileDurableOperatorDispositions(signal);
  if (durableReconciliation.kind !== 'completed') {
    throw new Error(`Durable provider proxy set disposition reconciliation failed: ${durableReconciliation.reason}`);
  }
}

export function createExecutionServices(deps: CreateExecutionServicesDeps): ExecutionServices {
  const { world, runtime, onProviderProxyLifecycleFatal, onProviderProxySlotReleased } = deps;
  const { services, state, providerOperationCleanup, getProgressStore } = createExecutionServiceContext(world);
  const providerProxyInheritance = world.providerProxyInheritance;
  const providerProxyRecovery = createProviderProxyRecoveryDispatcher({
    producers: createExecutionProviderProxyProducers({
      world,
      runtime,
      getProgressStore,
      providerProxyInheritance,
      getReconciler: () => providerOperationReconciler,
    }),
    fatalSink: { fatal: onProviderProxyLifecycleFatal },
  });
  const authorityFor = (record: ProviderOperationRecord) =>
    providerProxyLifecycle.authorityFor(providerProxySetIdentityFromRecord(record));
  const startupSetRecovery = createExecutionStartupSetRecovery({
    runtime,
    getProgressStore,
    authorityFor,
    providerProxyInheritance,
    recoverSet: async (record, signal) => {
      const outcome = await recoverProviderProxySetAtStartup(
        providerProxyRecovery,
        record,
        getProgressStore().getDb(),
        signal,
      );
      return outcome;
    },
    acceptContainmentAbsence: (identity, receipt) => providerProxyLifecycle.containmentAbsent(identity, receipt),
  });
  const providerOperationReconciler = createExecutionOperationReconciler({
    deps,
    getProgressStore,
    authorityFor,
    startupSetRecovery,
    providerProxyRecovery,
    initializeAtStartup: async (signal) => {
      await initializeProviderProxyClaims();
      signal.throwIfAborted();
      await initializeProviderProxyLifecycle(signal);
    },
    getRecoveryCoordinator: () => state.providerOperationRecovery,
    acquireAuthority: createOrdinaryProviderAuthorityAcquirer({
      authorityFor,
      providerProxyInheritance,
      recoverSet: async (record, signal) => {
        const outcome = await recoverProviderProxySetOrdinarily(
          providerProxyRecovery,
          record,
          getProgressStore().getDb(),
          signal,
        );
        return outcome;
      },
      recordContainmentAbsence: (identity, receipt) => providerProxyLifecycle.containmentAbsent(identity, receipt),
    }),
  });
  const providerProxyLifecycle = createExecutionProxyLifecycle({
    world,
    runtime,
    getProgressStore,
    providerProxyRecovery,
    onProviderProxySlotReleased,
  });
  world.providerProxyLifecycleRef.connect(providerProxyLifecycle);
  const unsubscribeProviderProxyControlEstablished = subscribeProviderProxyControlEstablished((authority) =>
    providerOperationReconciler.onControlEstablished(authority),
  );

  const adoptRepairedProviderOperation = createRepairedProviderOperationAdopter({
    world,
    state,
    providerProxyLifecycle,
    providerOperationReconciler,
  });
  const initializeProviderProxyClaims = createProviderProxyClaimsInitializer({
    world,
    runtime,
    getProgressStore,
    providerProxyLifecycle,
    state,
  });
  const initializeProviderProxyLifecycle = async (signal: AbortSignal): Promise<void> => {
    if (state.providerProxyLifecycleInitialized) return;
    activateProviderProxyLifecycle(providerProxyLifecycle);
    if (world.providerProxyInheritance === undefined) {
      providerProxyLifecycle.completeStartupDiscovery();
    } else {
      const refusals: { path: string; observation: string; observedAt: string }[] = [];
      const discovered = discoverProviderHandoffCapsules({
        runDir: runtime.paths.coral.coordinator.runDir,
        generationRoot: runtime.paths.coral.generation.root,
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
        onRefused: (path, observation) =>
          refusals.push({ path, observation, observedAt: new Date(runtime.time.now()).toISOString() }),
      });
      const prior = readLaunchStatus(runtime.paths.coral.coordinator.runDir);
      const observedPaths = new Set([...discovered.map(({ path }) => path), ...refusals.map(({ path }) => path)]);
      recordControllerEvidenceRefusals(runtime.paths.coral.coordinator.runDir, [
        ...(prior.kind === 'readable' ? (prior.status.controllerEvidenceRefusals ?? []) : []).filter(
          ({ path }) => !observedPaths.has(path),
        ),
        ...refusals,
      ]);
      providerProxyLifecycle.installDiscoveredCapsules(discovered, {
        observeRecordedProcess: createRecordedProcessObserver({
          readIncarnation: (pid) =>
            runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
          observeLiveness: (pid) => runtime.process.observeLiveness(pid),
        }),
      });
    }
    await reconcileProviderProxyLifecycle(providerProxyLifecycle, signal);
    signal.throwIfAborted();
    state.providerProxyLifecycleInitialized = true;
  };

  const servicesPorts = createExecutionServiceRegistry({
    services,
    deps,
    getProgressStore,
    providerOperationReconciler,
    providerOperationCleanup,
  });

  return createExecutionServicePorts({
    state,
    services: servicesPorts,
    adoptRepairedProviderOperation,
    providerOperationReconciler,
    unsubscribeProviderProxyControlEstablished,
  });
}
