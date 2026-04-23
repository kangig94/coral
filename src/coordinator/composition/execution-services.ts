import type { CallerContext } from '../../transport/request-context.js';
import { noopAppendEvents } from '../../store/append.js';
import type { ProjectRequestPort } from '../../coordinator/contracts.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ExecutionServiceDeps, RecoveryCapableService } from '../../coordinator/contracts.js';
import type { BackendWorld } from './backend-world.js';

type CreateExecutionServicesDeps = {
  world: BackendWorld;
  runtime: Runtime;
  bundleHash: string;
  backendNamespace: string;
  createExecutionService: (ctx: CallerContext, deps: ExecutionServiceDeps) => ProjectRequestPort;
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
  getExecutionService: (ctx: CallerContext) => ProjectRequestPort;
  getRecoveryService: (ctx: CallerContext) => RecoveryCapableService;
  listExecutionServices: () => ProjectRequestPort[];
} {
  const services = new Map<string, ProjectRequestPort>();

  function getExecutionService(ctx: CallerContext): ProjectRequestPort {
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
      appendEvents: noopAppendEvents,
    });
    services.set(key, created);
    return created;
  }

  function getRecoveryService(ctx: CallerContext): RecoveryCapableService {
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
