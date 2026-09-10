import type { InvocationContext } from '../../runtime/invocation-context.js';
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
import {
  ProviderOperationReconciler,
  type ProviderOperationReconcilerFatalError,
  type ProviderOperationReconcilerStopDisposition,
  StartupSetRecoveryProducer,
  type StartupReconciliationReport,
} from '../services/provider-operation-reconciler.js';
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
import {
  quarantineUnreadableProviderOperations,
  type RepairedProviderOperationAdoption,
  type RecoveryCoordinator,
} from '../services/recovery/index.js';
import {
  attributeUnreadableProviderOperations,
  providerOperationMutationAdmission,
  readProviderOperation,
  readProviderOperations,
  subscribeProviderOperationMutations,
} from '../../store/provider-operation-journal.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
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
import { providerProxySetAvailabilityReason } from '../services/provider-proxy-set/inheritance.js';
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
  bundleHash: string;
  backendNamespace: string;
  settlementRefusalRecorder: SettlementRefusalRecorder;
  createExecutionService: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
  onProviderProxyLifecycleFatal(
    error: ProviderProxySetLifecycleFatalError | ProviderOperationReconcilerFatalError,
  ): void;
};

function listInstantiatedExecutionServices(services: ReadonlyMap<string, ProjectRequestPort>): ProjectRequestPort[] {
  return [...services.values()];
}

export function createExecutionServices({
  world,
  runtime,
  bundleHash,
  backendNamespace,
  settlementRefusalRecorder,
  createExecutionService,
  onProviderProxyLifecycleFatal,
}: CreateExecutionServicesDeps): {
  getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
  adoptRepairedProviderOperation: (
    record: ProviderOperationRecord,
    recordKey?: string,
  ) => Promise<RepairedProviderOperationAdoption>;
  releaseUnreadableProviderOperationStartupOwnership: (recordKey: string) => Promise<number>;
  connectProviderOperationRecovery: (recoveryCoordinator: RecoveryCoordinator) => void;
  reconcileProviderOperationsAtStartup: (
    ownership: ProviderOperationStartupOwnership,
    signal: AbortSignal,
  ) => Promise<StartupReconciliationReport>;
  startProviderOperationReconciler: () => void;
  stopProviderOperationReconciler: () => ProviderOperationReconcilerStopDisposition;
} {
  const services = new Map<string, ProjectRequestPort>();
  let providerOperationRecovery: RecoveryCoordinator | null = null;
  const storeServicesRef = world.storeServicesRef;
  const providerOperationCleanup = new ProviderOperationCleanupRouter();
  world.operationRegistry.connectCleanup(providerOperationCleanup);
  world.operationRegistry.connectBinding(world.launchCoordinator);
  const getProgressStore = () => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) throw new Error('Coordinator store services are not connected.');
    return storeServices.progressStore;
  };
  const providerProxyInheritance = world.providerProxyInheritance;
  const providerProxyRecovery = createProviderProxyRecoveryDispatcher({
    producers: {
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
        const consumeDisappearance = () => providerOperationReconciler.containmentDisappeared(notice);
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
        const consumeAbandonment = () => providerOperationReconciler.representationAbandoned(notice);
        return mutationProof === undefined
          ? consumeAbandonment()
          : runProviderProxySetContainmentProofMutation(
              mutationProof,
              notice.setIdentity,
              'provider-representation-abandonment-fenced-release',
              consumeAbandonment,
            );
      },
    },
    fatalSink: { fatal: onProviderProxyLifecycleFatal },
  });
  const authorityFor = (record: ProviderOperationRecord) =>
    providerProxyLifecycle.authorityFor(providerProxySetIdentityFromRecord(record));
  const startupSetRecovery = new StartupSetRecoveryProducer(async (work, signal) => {
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
    const outcome = await recoverProviderProxySetAtStartup(
      providerProxyRecovery,
      representative,
      getProgressStore().getDb(),
      signal,
    );
    switch (outcome.kind) {
      case 'inherited':
        return { kind: 'authority', authority: outcome.set };
      case 'containment-disappeared':
        return {
          kind: 'absence-accepted',
          acceptance: providerProxyLifecycle.containmentAbsent(work.identity, outcome.disappearanceReceipt),
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
  const providerOperationReconciler = new ProviderOperationReconciler({
    getProgressStore,
    authorityFor,
    acquireAuthority: async (record, signal) => {
      const live = authorityFor(record);
      if (live !== null || providerProxyInheritance === undefined) return live;
      const outcome = await recoverProviderProxySetOrdinarily(
        providerProxyRecovery,
        record,
        getProgressStore().getDb(),
        signal,
      );
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
          providerProxyLifecycle.containmentAbsent(
            providerProxySetIdentityFromRecord(record),
            outcome.disappearanceReceipt,
          );
          return null;
        default:
          return assertNever(outcome);
      }
    },
    startupSetRecovery,
    registry: world.operationRegistry,
    binding: world.launchCoordinator,
    releaseStartupOwnership: (operation) =>
      providerOperationRecovery?.releaseProviderOperationStartupOwnership(operation) ?? false,
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
      const recoveryCoordinator = providerOperationRecovery;
      if (recoveryCoordinator === null) {
        return Promise.reject(new Error('Provider operation recovery is not connected.'));
      }
      return recoveryCoordinator.recoverProviderOperationJob(record, signal);
    },
    completeLocalRecovery: (jobId) => providerOperationRecovery?.completeProviderOperationJobRecovery(jobId),
    terminalization: {
      terminalize: (record, directive) =>
        terminalizeProviderOperation(getProgressStore(), record, directive, runtime.time.now()),
    },
    recoveryDispatcher: providerProxyRecovery,
    backendNamespace,
    time: runtime.time,
    onFatal: onProviderProxyLifecycleFatal,
    onError: (message) => backendLog.warn(message),
  });
  const providerProxyLifecycle: ProviderProxySetLifecycle = new ProviderProxySetLifecycle({
    buildSetId: world.identity.buildSetId,
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
    onSlotReleased: (routeKey) => world.providerHostManager.providerProxySlotReleased?.(routeKey),
  });
  world.providerProxyLifecycleRef.connect(providerProxyLifecycle);
  const unsubscribeProviderProxyControlEstablished = subscribeProviderProxyControlEstablished((authority) =>
    providerOperationReconciler.onControlEstablished(authority),
  );
  let unsubscribeProviderOperationMutations: (() => void) | null = null;
  let providerProxyClaimsInitialized = false;
  let providerProxyLifecycleInitialized = false;

  const adoptRepairedProviderOperation = async (
    record: ProviderOperationRecord,
    recordKey?: string,
  ): Promise<RepairedProviderOperationAdoption> => {
    if (!providerProxyClaimsInitialized || !providerProxyLifecycleInitialized) {
      return { kind: 'refused', reason: 'the provider operation ownership path is not initialized' };
    }
    if (providerOperationRecovery === null) {
      return { kind: 'refused', reason: 'provider operation recovery ownership is not connected' };
    }

    const ownership = providerOperationRecovery.adoptRepairedProviderOperationOwnership(record, recordKey);
    if (ownership.bindingDisposition.kind === 'refused') {
      return { kind: 'refused', reason: ownership.bindingDisposition.reason };
    }
    if (ownership.bindingDisposition.kind === 'not-reconciled') {
      return { kind: 'refused', reason: `the repaired provider operation is ${ownership.bindingDisposition.reason}` };
    }

    world.providerProxyClaims.applyMutation({ kind: 'upserted', record });
    const setIdentity = providerProxySetIdentityFromRecord(record);
    const accepted = world.providerProxyClaims.claimFor(record.operation);
    if (accepted === null || !providerProxySetIdentitiesEqual(accepted.setIdentity, setIdentity)) {
      return { kind: 'refused', reason: 'the provider operation claim mirror did not retain the decoded record' };
    }
    providerProxyLifecycle.claimsChanged(setIdentity);
    await providerOperationReconciler.reconcile(record);
    return { kind: 'accepted', owner: 'provider-operation-reconciler' };
  };

  const initializeProviderProxyClaims = async (): Promise<void> => {
    if (providerProxyClaimsInitialized) return;
    const db = getProgressStore().getDb();
    const scan = readProviderOperations(db);
    world.providerProxyClaims.initialize(scan.records);
    providerProxyClaimsInitialized = true;
    unsubscribeProviderOperationMutations = subscribeProviderOperationMutations(db, (mutation) => {
      world.providerProxyClaims.applyMutation(mutation);
      providerProxyLifecycle.claimsChanged(providerProxySetIdentityFromRecord(mutation.record));
    });

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
  };

  const initializeProviderProxyLifecycle = async (): Promise<void> => {
    if (providerProxyLifecycleInitialized) return;
    const activation = providerProxyLifecycle.activateDurableOperatorDispositions();
    if (activation.kind === 'held') {
      backendLog.warn(
        `Durable provider proxy disposition activation remains held pending store repair: ${activation.reason}`,
      );
    }
    providerProxyLifecycle.initializeClaimSlots();
    if (world.providerProxyInheritance === undefined) {
      providerProxyLifecycle.completeStartupDiscovery();
    } else {
      providerProxyLifecycle.installDiscoveredCapsules(
        discoverProviderHandoffCapsules({
          runDir: runtime.paths.coral.coordinator.runDir,
          generationRoot: runtime.paths.coral.generation.root,
          storage: runtime.storage,
          uid: process.getuid?.() ?? 0,
        }),
        {
          observeRecordedProcess: createRecordedProcessObserver({
            readIncarnation: (pid) =>
              runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
            observeLiveness: (pid) => runtime.process.observeLiveness(pid),
          }),
        },
      );
    }
    providerProxyLifecycleInitialized = true;
    const durableReconciliation = await providerProxyLifecycle.reconcileDurableOperatorDispositions();
    if (durableReconciliation.kind !== 'completed') {
      backendLog.warn(`Durable provider proxy set disposition reconciliation failed: ${durableReconciliation.reason}`);
    }
  };

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
      readJobEvents: (jobId) => getProgressStore().readJobEvents(jobId),
      aggregateWorkflowUsage: (workflowJobId) => aggregateWorkflowUsage(getProgressStore().getDb(), workflowJobId),
      subscribeJobEvents,
      getCurrentJournalSeq,
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

  return {
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
    adoptRepairedProviderOperation,
    releaseUnreadableProviderOperationStartupOwnership: async (recordKey) => {
      const resolution = providerOperationRecovery?.releaseUnreadableProviderOperationStartupOwnership(recordKey);
      if (resolution === undefined) return 0;
      for (const record of resolution.readableRecords) {
        await adoptRepairedProviderOperation(record);
      }
      return resolution.released;
    },
    connectProviderOperationRecovery: (recoveryCoordinator) => {
      providerOperationRecovery = recoveryCoordinator;
    },
    reconcileProviderOperationsAtStartup: async (ownership, signal) => {
      await initializeProviderProxyClaims();
      await initializeProviderProxyLifecycle();
      return providerOperationReconciler.reconcileAtStartup(ownership, signal);
    },
    startProviderOperationReconciler: () => providerOperationReconciler.start(),
    stopProviderOperationReconciler: () => {
      const disposition = providerOperationReconciler.stop();
      unsubscribeProviderProxyControlEstablished();
      if (disposition.kind === 'drained') {
        unsubscribeProviderOperationMutations?.();
        unsubscribeProviderOperationMutations = null;
      }
      return disposition;
    },
  };
}
