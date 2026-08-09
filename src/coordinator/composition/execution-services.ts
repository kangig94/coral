import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { ProjectRequestPort, ExecutionServiceDeps } from '../contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { CoordinatorWorld } from './world.js';
import { subscribeJobEvents } from '../../jobs/shell/event-subscription.js';
import { prepareCached } from '../../store/db.js';
import { aggregateWorkflowUsage } from '../../jobs/workflow-usage.js';
import { admittedByThisCoordinator, createObserveCarriers } from './carrier-observation.js';
import { createAppServerProxyRoute } from '../services/provider-proxy-launch-route.js';
import { ProviderOperationReconciler } from '../services/provider-operation-reconciler.js';
import { subscribeProviderProxyControlEstablished } from '../live/provider-proxy/operation-route.js';
import { backendLog } from '../../infra/backend-log.js';
import { assertNever } from '../../infra/error-format.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import { ProviderOperationCleanupRouter } from '../../jobs/provider-operation-cleanup.js';
import { readProviderOperationJobLaunch } from '../../jobs/provider-operation-state.js';
import { readProjectionProviderSession } from '../../sessions/projections.js';
import { materializeProviderOperationPrepare } from '../services/provider-operation-prepare.js';
import { terminalizeProviderOperation } from '../../jobs/provider-operation-terminalization.js';
import type { RecoveryCoordinator } from '../services/recovery/index.js';
import { readProviderOperations, subscribeProviderOperationMutations } from '../../store/provider-operation-journal.js';
import { providerProxySetIdentityFromRecord } from '../services/provider-proxy-set-identity.js';
import { ProviderProxySetLifecycle } from '../services/provider-proxy-set-lifecycle.js';
import {
  discoverProviderHandoffCapsules,
  retireProviderHandoffCapsule,
} from '../services/provider-proxy-capsule-discovery.js';

type CreateExecutionServicesDeps = {
  world: CoordinatorWorld;
  runtime: Runtime;
  bundleHash: string;
  backendNamespace: string;
  createExecutionService: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
};

function listInstantiatedExecutionServices(services: ReadonlyMap<string, ProjectRequestPort>): ProjectRequestPort[] {
  return [...services.values()];
}

export function createExecutionServices({
  world,
  runtime,
  bundleHash,
  backendNamespace,
  createExecutionService,
}: CreateExecutionServicesDeps): {
  getExecutionService: (ctx: InvocationContext) => ProjectRequestPort;
  getRecoveryService: (ctx: InvocationContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
  connectProviderOperationRecovery: (recoveryCoordinator: RecoveryCoordinator) => void;
  reconcileProviderOperationsAtStartup: (signal: AbortSignal) => Promise<void>;
  startProviderOperationReconciler: () => void;
  stopProviderOperationReconciler: () => void;
} {
  const services = new Map<string, ProjectRequestPort>();
  let providerOperationRecovery: RecoveryCoordinator | null = null;
  const storeServicesRef = world.storeServicesRef;
  const providerOperationCleanup = new ProviderOperationCleanupRouter();
  world.operationRegistry.connectCleanup(providerOperationCleanup);
  const getProgressStore = () => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) throw new Error('Coordinator store services are not connected.');
    return storeServices.progressStore;
  };
  const providerProxyInheritance = world.providerProxyInheritance;
  const authorityFor = (record: ProviderOperationRecord) =>
    providerProxyLifecycle.authorityFor(providerProxySetIdentityFromRecord(record));
  const providerOperationReconciler = new ProviderOperationReconciler({
    getProgressStore,
    authorityFor,
    acquireAuthority: async (record, signal) => {
      const live = authorityFor(record);
      if (live !== null || providerProxyInheritance === undefined) return live;
      const outcome = await providerProxyInheritance.inheritProviderProxySet(
        record,
        getProgressStore().getDb(),
        signal,
      );
      switch (outcome.kind) {
        case 'inherited':
          return outcome.set;
        case 'not-bequeathed':
          return null;
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
    registry: world.operationRegistry,
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
    backendNamespace,
    time: runtime.time,
    onError: (message) => backendLog.warn(message),
  });
  const providerProxyLifecycle: ProviderProxySetLifecycle = new ProviderProxySetLifecycle({
    claims: world.providerProxyClaims,
    disappearanceConsumer: providerOperationReconciler,
    time: runtime.time,
    proveContainmentAbsent: (identity, signal) =>
      providerProxyInheritance === undefined
        ? Promise.resolve(null)
        : providerProxyInheritance.proveContainmentAbsent(identity, getProgressStore().getDb(), signal),
    retireCapsule: (path) => retireProviderHandoffCapsule(runtime.storage, path),
    ...(providerProxyInheritance === undefined
      ? {}
      : {
          redeemCapsule: (capsule, path, signal) =>
            providerProxyInheritance.redeemDiscoveredCapsule(capsule, path, signal),
        }),
    onProgressPremiseViolation: (violation) =>
      backendLog.warn(
        `Provider proxy lifecycle ${violation.stage} woke ${violation.latenessMs}ms after its requested time.`,
      ),
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

  const initializeProviderProxyClaims = (): void => {
    if (providerProxyClaimsInitialized) return;
    const db = getProgressStore().getDb();
    world.providerProxyClaims.initialize(readProviderOperations(db));
    providerProxyClaimsInitialized = true;
    unsubscribeProviderOperationMutations = subscribeProviderOperationMutations(db, (mutation) => {
      world.providerProxyClaims.applyMutation(mutation);
      providerProxyLifecycle.claimsChanged(providerProxySetIdentityFromRecord(mutation.record));
    });
  };

  const initializeProviderProxyLifecycle = (): void => {
    if (providerProxyLifecycleInitialized) return;
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
      );
    }
    providerProxyLifecycleInitialized = true;
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
          isAdmittedByThisCoordinator: (jobId) => admittedByThisCoordinator(world.launchCoordinator, jobId),
          registryStateForJob: (jobId) => world.operationRegistry.stateForJob(jobId),
        },
        getCurrentJournalSeq,
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
    connectProviderOperationRecovery: (recoveryCoordinator) => {
      providerOperationRecovery = recoveryCoordinator;
    },
    reconcileProviderOperationsAtStartup: (signal) => {
      initializeProviderProxyClaims();
      initializeProviderProxyLifecycle();
      return providerOperationReconciler.reconcileAtStartup(signal);
    },
    startProviderOperationReconciler: () => providerOperationReconciler.start(),
    stopProviderOperationReconciler: () => {
      unsubscribeProviderProxyControlEstablished();
      unsubscribeProviderOperationMutations?.();
      unsubscribeProviderOperationMutations = null;
      providerOperationReconciler.stop();
    },
  };
}
