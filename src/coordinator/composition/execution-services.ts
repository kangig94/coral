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
import {
  isProviderProxyOperationAuthority,
  subscribeProviderProxyControlEstablished,
} from '../live/provider-proxy/operation-route.js';
import { backendLog } from '../../infra/backend-log.js';
import type { ProviderOperationRecord } from '../../store/provider-operation-record.js';
import type { ProviderProxySetLocator } from '../services/provider-proxy-set-inheritance.js';

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

function providerProxySetLocator(record: ProviderOperationRecord): ProviderProxySetLocator {
  return {
    buildSetId: record.operation.buildSetId,
    hostFingerprint: record.locator.hostFingerprint,
    guardianInstanceId: record.locator.guardian.instanceId,
    guardianPid: record.locator.guardian.pid,
    guardianProcessStartedAtSeconds: record.locator.guardian.processStartedAtSeconds,
    guardianControlEndpoint: record.locator.guardian.controlEndpoint,
    proxyInstanceId: record.locator.proxy.instanceId,
    proxyPid: record.locator.proxy.pid,
    proxyProcessStartedAtSeconds: record.locator.proxy.processStartedAtSeconds,
    proxyProcessGroupId: record.locator.containment.processGroupId,
    canonicalEndpoint: record.locator.proxy.controlEndpoint,
    reaperInstanceId: record.locator.reaper.instanceId,
    reaperPid: record.locator.reaper.pid,
    reaperProcessStartedAtSeconds: record.locator.reaper.processStartedAtSeconds,
    reaperControlEndpoint: record.locator.reaper.controlEndpoint,
    containmentKind: record.locator.containment.kind,
  };
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
  reconcileProviderOperationsAtStartup: (signal: AbortSignal) => Promise<void>;
  stopProviderOperationReconciler: () => void;
} {
  const services = new Map<string, ProjectRequestPort>();
  const storeServicesRef = world.storeServicesRef;
  const getProgressStore = () => storeServicesRef.get().progressStore;
  const authorityFor = (record: ProviderOperationRecord) => {
    const set = world.providerProxyAuthority
      ?.liveSets()
      .find((candidate) => candidate.proxyInstanceId === record.operation.proxyInstanceId);
    return set !== undefined && isProviderProxyOperationAuthority(set) ? set : null;
  };
  const providerOperationReconciler = new ProviderOperationReconciler({
    getProgressStore,
    authorityFor,
    acquireAuthority: async (record, signal) => {
      const live = authorityFor(record);
      if (live !== null || world.providerProxyInheritance === undefined) return live;
      const outcome = await world.providerProxyInheritance.inheritProviderProxySet(
        providerProxySetLocator(record),
        getProgressStore().getDb(),
        signal,
      );
      return outcome.kind === 'inherited' ? outcome.set : null;
    },
    registry: world.operationRegistry,
    backendNamespace,
    time: runtime.time,
    onError: (message) => backendLog.warn(message),
  });
  const unsubscribeProviderProxyControlEstablished = subscribeProviderProxyControlEstablished((authority) =>
    providerOperationReconciler.onControlEstablished(authority),
  );

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
      operations: { stop: (jobId, cause) => world.operationRegistry.stop(jobId, cause) },
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
    reconcileProviderOperationsAtStartup: (signal) => providerOperationReconciler.reconcileAtStartup(signal),
    stopProviderOperationReconciler: () => {
      unsubscribeProviderProxyControlEstablished();
      providerOperationReconciler.stop();
    },
  };
}
