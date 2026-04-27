// Coordinator assembly root — wires HTTP/IPC transports, domain shells,
// services, coordinator lifecycle, and event subscriptions. This file is
// allowed to be large because its single job is composition; that role does
// not turn it into a magnet for unrelated logic.
// What it MUST NOT absorb:
//   - Domain-specific logic (belongs in jobs/, sessions/, discuss/, kb/, ...)
//   - Coordinator global state (belongs in CoordinatorWorld via world.ts)
//   - Default resolution policy (belongs in defaults.ts)
//   - Job-control or drain logic (belongs in control.ts)
// Adding any of those here turns this file from "orchestrator" into "magnet".

import type { ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { formatError } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { EventStreamHandlers, HttpHandlerPorts } from '../../transport/server-ports.js';
import {
  knownDiscussSources,
  loadDiscussDetail,
  listDiscussSessions,
} from '../../discuss/shell/session-read-service.js';
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
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceList,
  handleKbSourceRead,
  handleKbUpdate,
  handleKbDelete,
} from '../../kb/tool-handlers.js';
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '../../transport/ipc/server.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { KbToolResult } from '../../kb/result.js';
import { noteEntryId, sourceEntryId } from '../../kb/entry-types.js';
import type { KbRef } from '../../store/envelope.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import { createRuntimeState, createLifecycle, type LifecycleController, type LifecycleDeps } from '../control.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './types.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { createCoordinatorControl } from './control.js';
import { resolveCoordinatorDefaults } from './defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { createExecutionServices } from './execution-services.js';
import { createCoordinatorWorld } from './world.js';
import { isLivePhase } from '../../jobs/phase.js';
import { belongsToNamespace } from '../../jobs/records.js';
import { createExpansionRpc, createUnavailableExpansionRpc } from '../expansion/rpc.js';
import { KbSourceImportService, parseKbSourceImportRequest } from '../services/kb-source-import-service.js';
import { KbReindexService } from '../services/kb-reindex-service.js';
import { KbJobRecorder, normalizeHostedKbFailureDetail } from '../services/kb-job-recorder.js';

export function createCoordinatorCore(options: CoordinatorCoreOptions): CoordinatorCoreResult {
  const runtime = options.runtime;

  const defaultsPlan = resolveCoordinatorDefaults(options, runtime);
  const world = createCoordinatorWorld(options, runtime, defaultsPlan);
  const identity = world.identity;

  // Eager defaults resolve from `runtime` alone.
  // `bindHost`, `advertiseHost`, `progressStore`, `launchCoordinator`, and `log`
  // come from `CoordinatorWorld`; this call is exact-once and throws on a second invocation.
  const defaults = defaultsPlan.finalizeWithWorld(world);
  const runtimeState = createRuntimeState(world.now());
  const streamResponses = new Set<ServerResponse>();
  const eventStreamSubscriptions = new WeakMap<EventStreamHandlers, () => void>();
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: world.identity.bundleHash,
    coordinatorNamespace: world.namespace,
    createExecutionService: defaults.createExecutionService,
  });

  let lifecycleController: LifecycleController | null = null;

  const discuss = createDiscussRuntime({
    world,
    runtime,
    getExecutionService: services.getExecutionService,
  });
  const control = createCoordinatorControl({
    world,
    listExecutionServices: services.listExecutionServices,
    getLifecycleController: () => lifecycleController,
    coordinatorNamespace: world.namespace,
    progressStore: world.progressStore,
  });
  const kbSourceImportService = new KbSourceImportService({
    runtime,
    progressStore: world.progressStore,
    coordinatorNamespace: world.namespace,
    bundleHash: identity.bundleHash,
    waitForReadiness: options.waitForKbSourceImportReadiness ?? (async () => {}),
  });
  const kbReindexService = new KbReindexService({
    runtime,
    progressStore: world.progressStore,
    coordinatorNamespace: world.namespace,
    bundleHash: identity.bundleHash,
    waitForReadiness: options.waitForKbSourceImportReadiness ?? (async () => {}),
  });
  const kbJobRecorder = new KbJobRecorder({
    runtime,
    progressStore: world.progressStore,
    coordinatorNamespace: world.namespace,
    bundleHash: identity.bundleHash,
  });

  const readOnlyInvocationContext = {
    projectRoot: '',
    pluginRoot: identity.pluginRoot,
    coralEnv: { ...world.coralEnvSnapshot },
  };
  const kbUnavailableResult = {
    ok: false as const,
    code: 'kb_unavailable',
    message: 'Knowledge base is not available. Check backend health for details.',
  };
  const withKb = <T>(
    run: (kbSubsystem: NonNullable<ReturnType<typeof runtimeState.getKbSubsystem>>) => T,
  ): T | typeof kbUnavailableResult => {
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
  const kbRefsForOperation = (
    operation: string,
    args: Record<string, unknown>,
  ): Array<Pick<KbRef, 'entryId'>> | undefined => {
    const slug = typeof args.note === 'string' ? args.note : typeof args.slug === 'string' ? args.slug : undefined;
    if (slug !== undefined && (operation === 'update' || operation === 'delete')) {
      return [{ entryId: noteEntryId(slug) }];
    }
    if (slug !== undefined && (operation === 'source_import' || operation === 'source_delete')) {
      return [{ entryId: sourceEntryId(slug) }];
    }
    if (operation === 'promote' && typeof args.domain === 'string' && typeof args.topic === 'string') {
      return [{ entryId: noteEntryId(`${args.domain}-${args.topic}`) }];
    }
    return undefined;
  };
  const recordHostedKbFailure = (
    operation: string,
    args: Record<string, unknown>,
    ctx: InvocationContext | undefined,
    result: KbToolResult,
  ): void => {
    if (result.ok || ctx === undefined) {
      return;
    }

    const jobId = ctx.coralEnv.CORAL_JOB_ID;
    const sessionId = ctx.coralEnv.CORAL_SESSION_ID;
    if (typeof jobId !== 'string' || jobId.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
      return;
    }

    const status = world.progressStore.readStatus(jobId);
    if (
      !status ||
      status.sessionId !== sessionId ||
      !belongsToNamespace(status, world.namespace) ||
      !isLivePhase(status.phase)
    ) {
      return;
    }

    const kbRefs = kbRefsForOperation(operation, args);
    const detail = normalizeHostedKbFailureDetail(result.detail);
    kbJobRecorder.appendHostedKbOperationFailure({
      jobId,
      sessionId,
      projectRoot: status.projectRoot,
      namespace: status.coordinatorNamespace,
      operation,
      code: result.code,
      message: result.message,
      detail,
      ...(kbRefs === undefined ? {} : { kbRefs }),
    });
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
            ...readOnlyInvocationContext,
            projectRoot: request.projectRoot ?? readOnlyInvocationContext.projectRoot,
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
      readNote: (slug) =>
        withKb((kbSubsystem) => handleKbNoteRead(slug, readOnlyInvocationContext, runtime, kbSubsystem)),
      readSource: (slug) => withKb((kbSubsystem) => handleKbSourceRead(slug, kbSubsystem, runtime)),
      readCommunity: (slug) => withKb((kbSubsystem) => handleKbCommunityRead(slug, kbSubsystem, runtime)),
      readMemo: (slug, ctx) => withKb(() => handleKbMemoRead(slug, ctx, runtime)),
      readPrinciple: (slug) => withKb((kbSubsystem) => handleKbPrincipleRead(slug, kbSubsystem, runtime)),
      listSources: () => withKbAsync((kbSubsystem) => handleKbSourceList({}, kbSubsystem)),
      listMemos: (args, ctx) => withKb(() => handleKbMemoList(args, ctx)),
      listPrinciples: (args) => withKbAsync((kbSubsystem) => handleKbPrinciples(args, kbSubsystem)),
      createNote: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbPromote(args, kbSubsystem, ctx));
        recordHostedKbFailure('promote', args, ctx, result);
        return result;
      },
      updateNote: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbUpdate(args, kbSubsystem));
        recordHostedKbFailure('update', args, ctx, result);
        return result;
      },
      deleteNote: async (slug, ctx) => {
        const args = { note: slug };
        const result = await withKbAsync((kbSubsystem) => handleKbDelete(args, kbSubsystem));
        recordHostedKbFailure('delete', args, ctx, result);
        return result;
      },
      createSource: async (args, ctx) => {
        const parsed = parseKbSourceImportRequest(args);
        if (!parsed.ok) {
          return {
            ok: false,
            code: 'invalid_request',
            message: parsed.message,
          } satisfies KbToolResult;
        }
        const result = await withKbAsync((kbSubsystem) =>
          Promise.resolve(kbSourceImportService.start(parsed.data, ctx, kbSubsystem)),
        );
        recordHostedKbFailure('source_import', args, ctx, result);
        return result;
      },
      deleteSource: async (slug, ctx) => {
        const args = { slug };
        const result = await withKbAsync((kbSubsystem) => handleKbSourceDelete(args, kbSubsystem));
        recordHostedKbFailure('source_delete', args, ctx, result);
        return result;
      },
      createMemo: (args, ctx) => {
        const result = withKb(() => handleKbMemo(args, ctx));
        recordHostedKbFailure('memo_create', args, ctx, result);
        return result;
      },
      deleteMemos: (args, ctx) => {
        const result = withKb(() => handleKbMemoDeleteConsolidated(args, ctx));
        recordHostedKbFailure('memo_delete', args, ctx, result);
        return result;
      },
      reindex: async (ctx) => {
        const invocationContext = ctx ?? readOnlyInvocationContext;
        const result = await withKbAsync((kbSubsystem) => kbReindexService.run(invocationContext, kbSubsystem));
        recordHostedKbFailure('reindex', {}, ctx, result);
        return result;
      },
    },
    discuss: {
      seed: handleDiscussSeed,
      start: (args, ctx) => handleDiscussStart(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      listSessions: () => listDiscussSessions(discuss.readHelpersDeps),
      loadDetail: (projectRoot, sessionId, view) =>
        loadDiscussDetail(discuss.readHelpersDeps, world.resolveProjectSource(projectRoot), sessionId, view),
      watch: (args, ctx) => handleDiscussWatch(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      bid: (args, ctx) => handleDiscussBid(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      speech: (args, ctx) => handleDiscussSpeech(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      abort: (args, ctx) => handleDiscussAbort(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
    },
    expansion:
      options.expansionLifecycleService === undefined
        ? createUnavailableExpansionRpc()
        : createExpansionRpc(options.expansionLifecycleService),
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
    expansionLifecycleService: options.expansionLifecycleService ?? null,
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
      ((listener) => listenIpcServer(listener, runtime.paths.coral.coordinator.socketPath)),
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
    expansionLifecycleService: options.expansionLifecycleService ?? null,
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
