import type { CallerContext } from '../../shared/request-context.js';
import type { ExecutionServiceLike } from '../backend-contracts.js';
import type { Runtime } from '../runtime.js';
import type { ExecutionServiceDeps, RecoveryCapableService } from '../service.js';
import type { BackendWorld } from './backend-world.js';

type CreateExecutionServicesDeps = {
  world: BackendWorld;
  runtime: Runtime;
  bundleHash: string;
  backendNamespace: string;
  createExecutionService: (ctx: CallerContext, deps: ExecutionServiceDeps) => ExecutionServiceLike;
};

export function listInstantiatedExecutionServices(
  services: ReadonlyMap<string, ExecutionServiceLike>,
): ExecutionServiceLike[] {
  return [...services.values()];
}

export function createExecutionServices({
  world,
  runtime,
  bundleHash,
  backendNamespace,
  createExecutionService,
}: CreateExecutionServicesDeps): {
  getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  listExecutionServices: () => ExecutionServiceLike[];
} {
  const services = new Map<string, ExecutionServiceLike>();

  function getExecutionService(ctx: CallerContext): ExecutionServiceLike {
    const key = ctx.projectRoot;
    const existing = services.get(key);
    if (existing) return existing;
    const created = createExecutionService(ctx, {
      runtime,
      progressStore: world.progressStore,
      bundleHash,
      backendNamespace,
      providerHostManager: world.providerHostManager,
      launchCoordinator: world.launchCoordinator,
      eventBus: world.eventBus,
      providerRegistry: world.providerRegistry,
      pluginRegistry: world.pluginRegistry,
    });
    services.set(key, created);
    return created;
  }

  function getRecoveryService(ctx: CallerContext): RecoveryCapableService {
    return getExecutionService(ctx) as unknown as RecoveryCapableService;
  }

  function listExecutionServices(): ExecutionServiceLike[] {
    return listInstantiatedExecutionServices(services);
  }

  return {
    getExecutionService,
    getRecoveryService,
    listExecutionServices,
  };
}
