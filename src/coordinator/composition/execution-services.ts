import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { ProjectRequestPort, ExecutionServiceDeps } from '../contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { RecoveryCapableService } from '../../jobs/reconcile/contracts.js';
import type { CoordinatorWorld } from './world.js';
import { subscribeJobEvents } from '../../jobs/shell/event-subscription.js';

type CreateExecutionServicesDeps = {
  world: CoordinatorWorld;
  runtime: Runtime;
  bundleHash: string;
  backendNamespace: string;
  createExecutionService: (ctx: InvocationContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
};

export function listInstantiatedExecutionServices(
  services: ReadonlyMap<string, ProjectRequestPort>,
): ProjectRequestPort[] {
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
} {
  const services = new Map<string, ProjectRequestPort>();
  const storeServicesRef = world.storeServicesRef;
  const getProgressStore = () => storeServicesRef.get().progressStore;

  function getExecutionService(ctx: InvocationContext): ProjectRequestPort {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const progressStore = getProgressStore();
    const created = createExecutionService(ctx, {
      runtime,
      progressStore,
      bundleHash,
      backendNamespace,
      providerHostManager: world.providerHostManager,
      launchCoordinator: world.launchCoordinator,
      eventBus: world.eventBus,
      providerRegistry: world.providerRegistry,
      pluginRegistry: world.pluginRegistry,
      loadJobProjectionDetail: (jobId) => getProgressStore().loadJobProjectionDetail(jobId),
      readJobEvents: (jobId) => getProgressStore().readJobEvents(jobId),
      subscribeJobEvents,
      getCurrentJournalSeq: () =>
        (
          getProgressStore()
            .getDb()
            .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
            .get() as { seq: number }
        ).seq,
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
  };
}
