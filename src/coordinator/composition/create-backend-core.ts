import { existsSync, readFileSync as readNodeFileSync, readdirSync as readNodeDirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { formatError, nowIsoString } from '../../shared/utils.js';
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
} from '../../kb/api.js';
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import {
  createLifecycle,
  type LifecycleController,
  type LifecycleDeps,
} from '../control.js';
import type { BackendCoreOptions, BackendCoreResult } from './backend-core-types.js';
import { openStoreDatabase } from '../../store/db.js';
import { storePaths } from '../../store/paths.js';
import { jobsReconcile } from '../../jobs/api.js';
import { isWorkflowInputFailure, workflowCommands, workflowCompiler, workflowRecover } from '../../workflow/api.js';
import { createBackendControl } from './backend-control.js';
import { resolveBackendDefaults } from './backend-defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-build.js';
import { createExecutionServices } from './execution-services.js';
import { createBackendWorld } from './backend-world.js';
import { createRuntimeState } from './runtime-state.js';
import { isLivePhase } from '../../jobs/phase.js';
import { belongsToNamespace } from '../../jobs/records.js';

export type {
  BackendBootSnapshot,
  BackendCoreOptions,
  BackendCoreResult,
  CreateServerFn,
  FetchFn,
} from './backend-core-types.js';

function createLegacyStartupRecoveryFn(
  runtime: BackendCoreOptions['runtime'],
): NonNullable<BackendCoreOptions['runStartupRecoveryFn']> {
  return async ({
    identity,
    progressStore,
    providerRegistry,
    getExecutionService,
    getRecoveryService,
    knownDiscussSources,
    getDiscussStoreForSource,
    getDiscussContext,
    createCallerContext,
    recoveryCoordinator,
    assertStartupStillActive,
    cleanupStaleJobs,
    recoverPersistedDiscussFn,
  }) => {
    let storeDbPath = storePaths(identity.flavor).dbFile;
    try {
      storeDbPath = runtime.paths.coral.store.dbFile;
    } catch {
      // Some direct backend-core tests intentionally bypass flavor-settled bootstrap.
    }

    const storeDbStorage = {
      ...runtime.storage,
      readFileSync: (filePath: string, encoding: 'utf-8') => readNodeFileSync(filePath, encoding),
      readdirSync: (dirPath: string, options: { withFileTypes: true }) => readNodeDirSync(dirPath, options),
    };
    runtime.storage.mkdirSync(dirname(storeDbPath), { recursive: true });
    const storeDb = openStoreDatabase({
      path: existsSync(dirname(storeDbPath)) ? storeDbPath : ':memory:',
      storage: storeDbStorage,
    });

    try {
      await jobsReconcile.runStartup({
        recoveryCoordinator,
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createCallerContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
      });
      assertStartupStillActive();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createCallerContext,
        assertStartupStillActive,
      });
      assertStartupStillActive();

      await workflowRecover.resumeAll({
        db: storeDb,
        progressStore,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createCallerContext,
      });
      assertStartupStillActive();

      return recoveredDiscussResumes;
    } finally {
      storeDb.close();
    }
  };
}

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
      createStreamId: () => runtime.ids.uuid(),
      nowIsoString: () => nowIsoString(runtime.time),
      subscribe: (handlers: EventStreamHandlers) => {
        world.eventBus.on('job:created', handlers.onJobCreated);
        world.eventBus.on('job:phase_changed', handlers.onPhaseChanged);
        world.eventBus.on('job:progress', handlers.onProgress);
        world.eventBus.on('job:completed', handlers.onCompleted);
        world.eventBus.on('discuss:updated', handlers.onDiscussUpdated);
      },
      unsubscribe: (handlers: EventStreamHandlers) => {
        world.eventBus.off('job:created', handlers.onJobCreated);
        world.eventBus.off('job:phase_changed', handlers.onPhaseChanged);
        world.eventBus.off('job:progress', handlers.onProgress);
        world.eventBus.off('job:completed', handlers.onCompleted);
        world.eventBus.off('discuss:updated', handlers.onDiscussUpdated);
      },
    },
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
    runStartupRecoveryFn: options.runStartupRecoveryFn ?? createLegacyStartupRecoveryFn(runtime),
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
