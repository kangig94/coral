import type { ServerResponse } from 'node:http';
import type { EventStreamHandlers } from '../../transport/server-ports.js';
import { formatError, serializeThrown } from '../../infra/error-format.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import type { createExecutionServices } from './execution-services.js';
import { createCoordinatorControl } from './job-control.js';
import { storeServicesStartupNotReadyError } from './store-services-ref.js';
import type { createCoordinatorCoreContext } from './core-context.js';
import type { CoordinatorCoreOptions } from './types.js';

type CoreContext = ReturnType<typeof createCoordinatorCoreContext>;

function renderProviderProxyLifecycleFatalError(error: unknown): string {
  const lines = [formatError(error)];
  const serialized = serializeThrown(error);
  let cause = serialized.kind === 'error' ? serialized.cause : undefined;
  while (cause !== undefined) {
    const identity = [
      cause.kind === 'error' ? cause.name : undefined,
      cause.code === undefined ? undefined : `[${cause.code}]`,
    ]
      .filter((field) => field !== undefined)
      .join(' ');
    lines.push(`Caused by: ${identity === '' ? '' : `${identity}: `}${cause.message}`);
    cause = cause.kind === 'error' ? cause.cause : undefined;
  }
  return lines.join('\n');
}

export function prepareCoordinatorExecutionAssembly(core: CoreContext, options: CoordinatorCoreOptions) {
  const { world, state, defaultsPlan, storeServicesRef } = core;

  const defaults = defaultsPlan.finalizeWithWorld({
    bindHost: world.bindHost,
    advertiseHost: world.advertiseHost,
    getProgressStore: () => storeServicesRef.tryGet()?.progressStore ?? null,
    launchCoordinator: world.launchCoordinator,
    log: world.log,
  });
  const createStoreServicesFromDbFn =
    options.createStoreServicesFromDbFn ??
    (() => {
      throw storeServicesStartupNotReadyError();
    });
  const streamResponses = new Set<ServerResponse>();
  const eventStreamSubscriptions = new WeakMap<EventStreamHandlers, () => void>();
  const onProviderProxyLifecycleFatal = (error: unknown): void => {
    world.log(`Fatal provider proxy lifecycle error: ${renderProviderProxyLifecycleFatalError(error)}\n`);
    void state.lifecycleController
      ?.shutdown('provider-proxy-lifecycle-fatal', { kind: 'provider-proxy-lifecycle-fatal', error })
      .catch(() => undefined);
  };
  options.captureProviderProxyLifecycleFatal?.(onProviderProxyLifecycleFatal);
  return {
    defaults,
    createStoreServicesFromDbFn,
    streamResponses,
    eventStreamSubscriptions,
    onProviderProxyLifecycleFatal,
  };
}

export function createCoordinatorExecutionAssembly(
  core: CoreContext,
  options: CoordinatorCoreOptions,
  prepared: ReturnType<typeof prepareCoordinatorExecutionAssembly>,
  services: ReturnType<typeof createExecutionServices>,
) {
  const { runtime, world, state, getProgressStore } = core;
  const { defaults, createStoreServicesFromDbFn, streamResponses, eventStreamSubscriptions } = prepared;
  state.adoptRepairedProviderOperation = services.adoptRepairedProviderOperation;
  state.releaseUnreadableProviderOperationStartupOwnership =
    services.releaseUnreadableProviderOperationStartupOwnership;

  const discuss = createDiscussRuntime({
    world,
    runtime,
    getProgressStore,
    getExecutionService: services.getExecutionService,
    ...(options.discardSessionArtifacts !== undefined
      ? { discardSessionArtifacts: options.discardSessionArtifacts }
      : {}),
  });
  const internalJobAbortRegistry = world.launchCoordinator.getInternalAbortRegistry();

  const control = createCoordinatorControl({
    world,
    listExecutionServices: services.listExecutionServices,
    getLifecycleController: () => state.lifecycleController,
    isLifecycleRunning: () => core.runtimeState.getLifecycle() === 'running',
    getProgressStore,
    internalJobAbortRegistry,
    requestStops: services.requestStops,
  });
  return {
    defaults,
    createStoreServicesFromDbFn,
    streamResponses,
    eventStreamSubscriptions,
    services,
    discuss,
    internalJobAbortRegistry,
    control,
  };
}
