import type { ServerResponse } from 'node:http';
import { formatError } from '../../shared/utils.js';
import type { EventStreamHandlers, HttpHandlerDeps } from '../backend-contracts.js';
import {
  knownDiscussSources,
  listDiscussSessions,
  loadDiscussDetail,
} from '../discuss/read-helpers.js';
import { listAttachedSessions } from '../discuss/context-registry.js';
import { createHttpHandler, sendJson } from '../http-handler.js';
import {
  createLifecycle,
  type LifecycleController,
  type LifecycleDeps,
} from '../lifecycle.js';
import type { BackendCoreOptions, BackendCoreResult } from '../backend-core-types.js';
import { createBackendControl } from './backend-control.js';
import { resolveBackendDefaults } from './backend-defaults.js';
import { createDiscussRuntime } from './discuss-runtime.js';
import { createExecutionServices } from './execution-services.js';
import { createBackendWorld } from './backend-world.js';
import { createRuntimeState } from './runtime-state.js';

export type {
  BackendBootSnapshot,
  BackendCoreOptions,
  BackendCoreResult,
  CreateServerFn,
  FetchFn,
} from '../backend-core-types.js';

export function createBackendCore(options: BackendCoreOptions): BackendCoreResult {
  const runtime = options.runtime;
  const bootSnapshot = options.bootSnapshot ?? {};
  void bootSnapshot;

  const defaultsPlan = resolveBackendDefaults(options, runtime);
  const world = createBackendWorld(options, runtime, defaultsPlan);
  const identity = world.identity;

  // Eager defaults resolve from `runtime` alone.
  // `bindHost`, `advertiseHost`, `progressStore`, `launchCoordinator`, and `log`
  // come from `BackendWorld`; this call is exact-once and throws on a second invocation.
  const defaults = defaultsPlan.finalizeWithWorld(world);
  const runtimeState = createRuntimeState(world.now());
  const streamResponses = new Set<ServerResponse>();
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: world.identity.bundleHash,
    backendNamespace: world.namespace,
    createExecutionService: defaults.createExecutionService,
  });

  let lifecycleController: LifecycleController | null = null;

  const discuss = createDiscussRuntime({
    world,
    runtime,
    getExecutionService: services.getExecutionService,
  });
  const control = createBackendControl({
    world,
    listExecutionServices: services.listExecutionServices,
    getLifecycleController: () => lifecycleController,
    backendNamespace: world.namespace,
    progressStore: world.progressStore,
  });

  const httpHandlerDeps: HttpHandlerDeps = {
    identity,
    runtime,
    runtimeState,
    idleTimer: world.idleTimer,
    progressStore: world.progressStore,
    sessionIndex: world.sessionIndex,
    activeLaunchCount: () => world.launchCoordinator.active,
    queueDepth: () => world.launchCoordinator.queueDepth(),
    streamResponses,
    coralEnvSnapshot: world.coralEnvSnapshot,
    resolveProjectSource: world.resolveProjectSource,
    isDrainRequested: control.isDrainRequested,
    requestDrain: control.requestDrain,
    getExecutionService: services.getExecutionService,
    getDiscussContext: discuss.getDiscussContext,
    providerRegistry: world.providerRegistry,
    abortJobs: control.abortJobs,
    scopeCheckJobs: (jobIds, projectRoot) => control.scopeCheckJobs(jobIds, projectRoot, world.namespace),
    subscribeBackendEvents: (handlers: EventStreamHandlers) => {
      world.eventBus.on('job:created', handlers.onJobCreated);
      world.eventBus.on('job:phase_changed', handlers.onPhaseChanged);
      world.eventBus.on('job:progress', handlers.onProgress);
      world.eventBus.on('job:completed', handlers.onCompleted);
      world.eventBus.on('session:updated', handlers.onSessionUpdated);
      world.eventBus.on('discuss:updated', handlers.onDiscussUpdated);
    },
    unsubscribeBackendEvents: (handlers: EventStreamHandlers) => {
      world.eventBus.off('job:created', handlers.onJobCreated);
      world.eventBus.off('job:phase_changed', handlers.onPhaseChanged);
      world.eventBus.off('job:progress', handlers.onProgress);
      world.eventBus.off('job:completed', handlers.onCompleted);
      world.eventBus.off('session:updated', handlers.onSessionUpdated);
      world.eventBus.off('discuss:updated', handlers.onDiscussUpdated);
    },
    liveDiscussCount: () => listAttachedSessions(world.discussRegistry).length,
    listDiscussSessions: () => listDiscussSessions(discuss.readHelpersDeps),
    loadDiscussDetail: (source, sessionId, view) =>
      loadDiscussDetail(discuss.readHelpersDeps, source, sessionId, view),
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);

  const server = defaults.createServerFn((req, res) => {
    void handleRequest(req, res).catch((error) => {
      world.log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'internal_error', message: 'Internal error' });
        return;
      }
      res.destroy();
    });
  });

  const lifecycleDeps: LifecycleDeps = {
    identity,
    runtime,
    backendPid: world.backendPid,
    runtimeState,
    idleTimer: world.idleTimer,
    progressStore: world.progressStore,
    sessionIndex: world.sessionIndex,
    streamResponses,
    discussStores: discuss.discussStores,
    eventBus: world.eventBus,
    launchCoordinator: world.launchCoordinator,
    providerRegistry: world.providerRegistry,
    server,
    getExecutionService: services.getExecutionService,
    getRecoveryService: services.getRecoveryService,
    listExecutionServices: services.listExecutionServices,
    getDiscussStoreForSource: discuss.getDiscussStoreForSource,
    knownDiscussSources: () => knownDiscussSources(discuss.readHelpersDeps),
    getDiscussContext: discuss.getDiscussContext,
    acquireLockFn: defaults.acquireLockFn,
    writeBackendInfoFn: defaults.writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: defaults.removeBackendInfoIfOwnerFn,
    removeLockIfOwnerFn: defaults.removeLockIfOwnerFn,
    cleanupStaleJobsFn: defaults.cleanupStaleJobsFn,
    markJobsAsErrorFn: defaults.markJobsAsErrorFn,
    terminateAllFn: defaults.terminateAllFn,
    providerHostManager: world.providerHostManager,
    createKbSubsystemFn: defaults.createKbSubsystemFn,
    registerBuiltInProvidersFn: defaults.registerBuiltInProvidersFn,
    recoverPersistedDiscussFn: defaults.recoverPersistedDiscussFn,
    hooks: discuss.hooks,
    closeServerFn: defaults.closeServerFn,
    listenFn: defaults.listenFn,
    onStopped: options.onStopped,
    onFatalShutdownError: options.onFatalShutdownError,
  };

  lifecycleController = createLifecycle(lifecycleDeps);
  const resolvedLifecycleController = lifecycleController;

  return {
    identity,
    server,
    handleRequest,
    lifecycleController: resolvedLifecycleController,
    sessionIndex: world.sessionIndex,
    idleTimer: world.idleTimer,
    discussRegistry: world.discussRegistry,
    runtimeState,
    progressStore: world.progressStore,
    eventBus: world.eventBus,
    launchCoordinator: world.launchCoordinator,
    providerRegistry: world.providerRegistry,
    providerHostManager: world.providerHostManager,
    getExecutionService: services.getExecutionService,
    getRecoveryService: services.getRecoveryService,
    listExecutionServices: services.listExecutionServices,
    getDiscussStoreForSource: discuss.getDiscussStoreForSource,
    getDiscussContext: discuss.getDiscussContext,
    resolveProjectSource: world.resolveProjectSource,
    isDrainRequested: control.isDrainRequested,
    requestDrain: control.requestDrain,
    hooks: discuss.hooks,
  };
}
