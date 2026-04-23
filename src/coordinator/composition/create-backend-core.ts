import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { formatError } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { EventStreamHandlers, HttpHandlerPorts } from '../../transport/http/contracts.js';
import { discussQueries } from '../../discuss/api.js';
import { knownDiscussSources } from '../../discuss/shell/read-helpers.js';
import { listAttachedSessions } from '../../discuss/shell/live-registry.js';
import {
  handleDiscussAbort,
  handleDiscussBid,
  handleDiscussSeed,
  handleDiscussSpeech,
  handleDiscussStart,
  handleDiscussWatch,
} from '../../discuss/shell/tools.js';
import {
  handleKbCommunityRead,
  handleKbDiagnose,
  handleKbMemo,
  handleKbMemoDeleteConsolidated,
  handleKbMemoList,
  handleKbMemoRead,
  handleKbNoteRead,
  handleKbPrincipleRead,
  handleKbPrinciples,
  handleKbPromote,
  handleKbReindex,
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceImport,
  handleKbSourceList,
  handleKbSourceRead,
  handleKbUpdate,
  handleKbDelete,
} from '../../kb/tool-handlers.js';
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '../../transport/ipc/server.js';
import type { RpcPorts } from '../../transport/rpc-ports.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import {
  createLifecycle,
  type LifecycleController,
  type LifecycleDeps,
} from '../control.js';
import type { BackendCoreOptions, BackendCoreResult } from './backend-core-types.js';
import { isWorkflowInputFailure, workflowCommands, workflowCompiler } from '../../workflow/api.js';
import { createBackendControl } from './backend-control.js';
import { resolveBackendDefaults } from './backend-defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-build.js';
import { createExecutionServices } from './execution-services.js';
import { createBackendWorld } from './backend-world.js';
import { createRuntimeState } from './runtime-state.js';
import { isLivePhase } from '../../jobs/phase.js';
import { belongsToNamespace } from '../../jobs/records.js';
import { coordinatorPaths } from '../../infra/coordinator-paths.js';
import { createEquipmentRpc, createUnavailableEquipmentRpc } from '../equipment/rpc.js';

export type {
  BackendBootSnapshot,
  BackendCoreOptions,
  BackendCoreResult,
  CreateServerFn,
  FetchFn,
} from './backend-core-types.js';

export function createBackendCore(options: BackendCoreOptions): BackendCoreResult {
  const runtime = options.runtime;

  const defaultsPlan = resolveBackendDefaults(options, runtime);
  const world = createBackendWorld(options, runtime, defaultsPlan);
  const identity = world.identity;

  // Eager defaults resolve from `runtime` alone.
  // `bindHost`, `advertiseHost`, `progressStore`, `launchCoordinator`, and `log`
  // come from `BackendWorld`; this call is exact-once and throws on a second invocation.
  const defaults = defaultsPlan.finalizeWithWorld(world);
  const runtimeState = createRuntimeState(world.now());
  const streamResponses = new Set<ServerResponse>();
  const eventStreamSubscriptions = new WeakMap<EventStreamHandlers, () => void>();
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

  const readOnlyCallerContext = {
    projectRoot: '',
    pluginRoot: identity.pluginRoot,
    coralEnv: { ...world.coralEnvSnapshot },
  };
  const kbUnavailableResult = {
    ok: false as const,
    code: 'kb_unavailable',
    message: 'Knowledge base is not available. Check backend health for details.',
  };
  const withKb = <T>(run: (kbSubsystem: NonNullable<ReturnType<typeof runtimeState.getKbSubsystem>>) => T): T | typeof kbUnavailableResult => {
    const kbSubsystem = runtimeState.getKbSubsystem();
    if (!kbSubsystem) {
      return kbUnavailableResult;
    }
    return run(kbSubsystem);
  };
  const withKbAsync = async <T>(
    run: (kbSubsystem: NonNullable<ReturnType<typeof runtimeState.getKbSubsystem>>) => Promise<T>,
  ): Promise<T | typeof kbUnavailableResult> => {
    const kbSubsystem = runtimeState.getKbSubsystem();
    if (!kbSubsystem) {
      return kbUnavailableResult;
    }
    return run(kbSubsystem);
  };

  const rpcPorts: RpcPorts = {
    sessions: {
      start: (providerName, input, ctx) => services.getExecutionService(ctx).start(providerName, input, ctx),
      resumeBySessionId: (input, ctx) => services.getExecutionService(ctx).resumeBySessionId(input, ctx),
      forkBySessionId: (input, ctx) => services.getExecutionService(ctx).forkBySessionId(input, ctx),
    },
    jobs: {
      scopeCheck: (jobIds, projectRoot) => control.scopeCheckJobs(jobIds, projectRoot, world.namespace),
      abort: control.abortJobs,
      waitStream: (request) =>
        services
          .getExecutionService({
            ...readOnlyCallerContext,
            projectRoot: request.projectRoot ?? readOnlyCallerContext.projectRoot,
          })
          .waitStream(request),
      list: (filters) => {
        let jobs = world.progressStore
          .listJobProjections()
          .filter((entry) => belongsToNamespace(entry.status, world.namespace));

        if (filters.all !== true) {
          jobs = jobs.filter((entry) => isLivePhase(entry.status.phase));
        }
        if (filters.projectRoot !== undefined) {
          jobs = jobs.filter((entry) => entry.status.projectRoot === filters.projectRoot);
        }
        if (filters.phase !== undefined) {
          jobs = jobs.filter((entry) => entry.status.phase === filters.phase);
        }
        if (filters.provider !== undefined) {
          jobs = jobs.filter((entry) => entry.status.provider === filters.provider);
        }

        return jobs;
      },
      detail: (jobId) => {
        const detail = world.progressStore.loadJobProjectionDetail(jobId);
        const status = detail.status;
        if (!status || !belongsToNamespace(status, world.namespace)) {
          return null;
        }
        const events = world.progressStore.readJobProgress(jobId);
        return { status, events };
      },
    },
    workflows: {
      execute: async (request, ctx) => {
        try {
          const compiled = workflowCompiler.compile(request, world.providerRegistry);
          const decision =
            'status' in compiled
              ? compiled
              : await workflowCommands.execute(services.getExecutionService(ctx), compiled, ctx);
          return { kind: 'decision' as const, decision };
        } catch (error: unknown) {
          if (isWorkflowInputFailure(error)) {
            if (error instanceof ZodError) {
              const first = error.issues[0];
              const path = first?.path.join('.') ?? '';
              const message = first ? (path.length > 0 ? `${path}: ${first.message}` : first.message) : error.message;
              return { kind: 'invalid_request' as const, message, detail: { issues: error.issues } };
            }
            return { kind: 'invalid_request' as const, message: error.message };
          }
          throw error;
        }
      },
    },
    kb: {
      readSearch: (args) => withKbAsync((kbSubsystem) => handleKbSearch(args, kbSubsystem)),
      diagnose: () => withKb((kbSubsystem) => handleKbDiagnose({}, kbSubsystem)),
      readNote: (slug) => withKb((kbSubsystem) => handleKbNoteRead(slug, readOnlyCallerContext, runtime, kbSubsystem)),
      readSource: (slug) => withKb((kbSubsystem) => handleKbSourceRead(slug, kbSubsystem, runtime)),
      readCommunity: (slug) => withKb((kbSubsystem) => handleKbCommunityRead(slug, kbSubsystem, runtime)),
      readMemo: (slug, ctx) => withKb(() => handleKbMemoRead(slug, ctx, runtime)),
      readPrinciple: (slug) => withKb((kbSubsystem) => handleKbPrincipleRead(slug, kbSubsystem, runtime)),
      listSources: () => withKbAsync((kbSubsystem) => handleKbSourceList({}, kbSubsystem)),
      listMemos: (args, ctx) => withKb(() => handleKbMemoList(args, ctx)),
      listPrinciples: (args) => withKbAsync((kbSubsystem) => handleKbPrinciples(args, kbSubsystem)),
      createNote: (args, ctx) => withKbAsync((kbSubsystem) => handleKbPromote(args, kbSubsystem, ctx)),
      updateNote: (args) => withKbAsync((kbSubsystem) => handleKbUpdate(args, kbSubsystem)),
      deleteNote: (slug) => withKbAsync((kbSubsystem) => handleKbDelete({ note: slug }, kbSubsystem)),
      createSource: (args) => withKbAsync((kbSubsystem) => handleKbSourceImport(args, kbSubsystem)),
      deleteSource: (slug) => withKbAsync((kbSubsystem) => handleKbSourceDelete({ slug }, kbSubsystem)),
      createMemo: (args, ctx) => withKb(() => handleKbMemo(args, ctx)),
      deleteMemos: (args, ctx) => withKb(() => handleKbMemoDeleteConsolidated(args, ctx)),
      reindex: () => withKbAsync((kbSubsystem) => handleKbReindex({}, kbSubsystem)),
    },
    discuss: {
      seed: handleDiscussSeed,
      start: (args, ctx) => handleDiscussStart(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      listSessions: () => discussQueries.list(discuss.readHelpersDeps),
      loadDetail: (projectRoot, sessionId, view) =>
        discussQueries.get(discuss.readHelpersDeps, world.resolveProjectSource(projectRoot), sessionId, view),
      watch: (args, ctx) => handleDiscussWatch(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      bid: (args, ctx) => handleDiscussBid(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      speech: (args, ctx) => handleDiscussSpeech(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      abort: (args, ctx) => handleDiscussAbort(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
    },
    equipment:
      options.equipmentLifecycleService === undefined
        ? createUnavailableEquipmentRpc()
        : createEquipmentRpc(options.equipmentLifecycleService),
  };

  const httpHandlerDeps: HttpHandlerPorts = {
    identity,
    coralEnvSnapshot: world.coralEnvSnapshot,
    admin: {
      isLifecycleRunning: () => runtimeState.getLifecycle() === 'running',
      isDrainRequested: control.isDrainRequested,
      isLaunchFenceActive: () => runtimeState.getLaunchFenceActive(),
      beginRequest: () => {
        world.idleTimer.beginRequest();
      },
      endRequest: () => {
        world.idleTimer.endRequest();
      },
      requestDrain: control.requestDrain,
    },
    health: {
      read: () => {
        const env = { ...world.coralEnvSnapshot };
        const lifecycleState = runtimeState.getLifecycle();
        let status: string = lifecycleState;
        if (world.idleTimer.isDraining) {
          status = 'draining';
        } else if (lifecycleState === 'running') {
          status = 'ok';
        }

        const kbInitError = runtimeState.getKbInitError();
        return {
          status,
          version: identity.version,
          bundleHash: identity.bundleHash,
          flavor: identity.flavor,
          namespace: identity.namespace,
          instanceId: identity.instanceId,
          uptimeMs: identity.now() - runtimeState.getStartedAt(),
          active: world.launchCoordinator.active,
          activeJobs: world.progressStore.liveJobCountByNamespace(identity.namespace),
          liveDiscuss: listAttachedSessions(world.discussRegistry).length,
          queueDepth: world.launchCoordinator.queueDepth(),
          inflightRequests: world.idleTimer.inflightRequests,
          subsystems: {
            kb: kbInitError === null ? 'ok' : 'unavailable',
            ...(kbInitError === null ? {} : { kbError: kbInitError }),
            discuss: 'ok' as const,
          },
          env,
        };
      },
    },
    events: {
      addResponse: (res) => {
        streamResponses.add(res);
      },
      removeResponse: (res) => {
        streamResponses.delete(res);
      },
      bus: world.eventBus,
      createStreamId: () => runtime.ids.uuid(),
      nowIsoString: () => nowIsoString(runtime.time),
      subscribe: (handlers: EventStreamHandlers) => {
        eventStreamSubscriptions.get(handlers)?.();
        eventStreamSubscriptions.set(
          handlers,
          subscribeAll(world.eventBus, {
            'job:created': handlers.onJobCreated,
            'job:phase_changed': handlers.onPhaseChanged,
            'job:progress': handlers.onProgress,
            'job:completed': handlers.onCompleted,
            'discuss:updated': handlers.onDiscussUpdated,
          }),
        );
      },
      unsubscribe: (handlers: EventStreamHandlers) => {
        const cleanup = eventStreamSubscriptions.get(handlers);
        if (!cleanup) {
          return;
        }
        eventStreamSubscriptions.delete(handlers);
        cleanup();
      },
    },
    ...rpcPorts,
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);
  const ipcServer = createIpcServer(httpHandlerDeps);

  const server = defaults.createServerFn((req, res) => {
    void handleRequest(req, res).catch((error) => {
      world.log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, buildTransportErrorResponse(error).body);
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
    runStartupRecoveryFn: options.runStartupRecoveryFn,
    hooks: discuss.hooks,
    closeServerFn: defaults.closeServerFn,
    listenFn: defaults.listenFn,
    ipcServer,
    closeIpcServerFn: closeIpcServer,
    listenIpcFn:
      options.listenIpcFn ??
      ((listener) =>
        listenIpcServer(
          listener,
          coordinatorPaths(identity.flavor, runtime.env.fullSnapshot(), {
            baseDir: join(runtime.env.homedir(), '.coral'),
          }).socketPath,
        )),
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
    idleTimer: world.idleTimer,
    discussRegistry: world.discussRegistry,
    runtimeState,
    progressStore: world.progressStore,
    eventBus: world.eventBus,
    launchCoordinator: world.launchCoordinator,
    providerRegistry: world.providerRegistry,
    providerHostManager: world.providerHostManager,
    equipmentLifecycleService: options.equipmentLifecycleService ?? null,
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
