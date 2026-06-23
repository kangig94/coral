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
import { deriveLaunchReadiness } from '../../jobs/launch-readiness.js';
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
  handleKbCommunityListStale,
  handleKbCommunityRead,
  handleKbCommunitySetSummary,
  handleKbCommunitySummaryInput,
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
  handleKbWakeUp,
  handleKbWikiAdopt,
  handleKbWikiCite,
  handleKbWikiCreate,
  handleKbWikiDelete,
  handleKbWikiLink,
  handleKbWikiList,
  handleKbWikiRead,
  handleKbWikiRewrite,
  handleKbWikiUnlink,
} from '../../kb/tool-handlers.js';
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '../../transport/ipc/server.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { KbToolResult } from '../../kb/result.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import { createRuntimeState, createLifecycle, type LifecycleController, type LifecycleDeps } from '../lifecycle.js';
import { createSubsystemRegistry } from '../subsystems/registry.js';
import { KB_ID } from '../subsystems/contract.js';
import type { KnowledgeBaseRuntime } from '../../kb/subsystem.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './types.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { createCoordinatorControl } from './job-control.js';
import { resolveCoordinatorDefaults } from './defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { createExecutionServices } from './execution-services.js';
import { createCoordinatorWorld } from './world.js';
import { storeServicesStartupNotReadyError, type StoreServicesRef } from './store-services-ref.js';
import { isLivePhase } from '../../jobs/phase.js';
import { belongsToNamespace } from '../../jobs/records.js';
import { createExpansionRpc } from '../expansion/rpc.js';
import type {
  EquipExpansionRequest,
  EquipExpansionResult,
  ExpansionRequestPort,
  ListExpansionRequest,
  ListExpansionResult,
  ReadBindingRequest,
  ReadBindingResult,
  RemoveExpansionCatalogRequest,
  RemoveExpansionCatalogResult,
  UnequipExpansionRequest,
  UnequipExpansionResult,
} from '../../expansion/rpc-contract.js';
import { KbSourceImportService, parseKbSourceImportRequest } from '../services/kb/source-import.js';
import { KbReindexService } from '../services/kb/reindex.js';
import { KbJobRecorder, normalizeHostedKbFailureDetail } from '../services/kb/recorder.js';
import { AbortRegistry } from '../../jobs/shell/abort-registry.js';

export const MAX_EVENT_STREAM_CONNECTIONS = 100;

const EVENT_STREAM_CAPACITY_RESPONSE = {
  code: 'too_many_event_streams',
  message: 'Too many event stream connections',
};

function createRefBackedExpansionRpc(storeServicesRef: StoreServicesRef): ExpansionRequestPort {
  const getExpansionRpc = (): ExpansionRequestPort => {
    const lifecycleService = storeServicesRef.tryGet()?.expansionLifecycleService ?? null;
    if (lifecycleService === null) {
      throw storeServicesStartupNotReadyError();
    }
    return createExpansionRpc(lifecycleService);
  };

  return {
    equipExpansion: (request: EquipExpansionRequest): Promise<EquipExpansionResult> =>
      getExpansionRpc().equipExpansion(request),
    unequipExpansion: (request: UnequipExpansionRequest): Promise<UnequipExpansionResult> =>
      getExpansionRpc().unequipExpansion(request),
    removeExpansionCatalog: (request: RemoveExpansionCatalogRequest): Promise<RemoveExpansionCatalogResult> =>
      getExpansionRpc().removeExpansionCatalog(request),
    listExpansion: (request: ListExpansionRequest): Promise<ListExpansionResult> =>
      getExpansionRpc().listExpansion(request),
    readBinding: (request: ReadBindingRequest): Promise<ReadBindingResult> => getExpansionRpc().readBinding(request),
  };
}

export function createCoordinatorCore(options: CoordinatorCoreOptions): CoordinatorCoreResult {
  const runtime = options.runtime;

  const defaultsPlan = resolveCoordinatorDefaults(options, runtime);
  const world = createCoordinatorWorld(options, runtime, defaultsPlan);
  const identity = world.identity;
  const storeServicesRef = world.storeServicesRef;
  // Local indirection: callers in non-health/handoff paths use this to get
  // the post-bind progressStore. Equivalent to `storeServicesRef.get()` but
  // intentionally wrapped so the file-level "tryGet-only" invariant for
  // health/handoff identity code doesn't flag it as a direct `.get()` call
  // in a mixed-concern composition file.
  const getStoreServices = () => {
    const storeServices = storeServicesRef.tryGet();
    if (storeServices === null) {
      throw storeServicesStartupNotReadyError();
    }
    return storeServices;
  };
  const getProgressStore = () => getStoreServices().progressStore;

  // Eager defaults resolve from `runtime` alone.
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
  const subsystems = createSubsystemRegistry();
  const runtimeState = createRuntimeState(world.now(), subsystems);
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
    getProgressStore,
    getExecutionService: services.getExecutionService,
    ...(options.discardSessionArtifacts !== undefined
      ? { discardSessionArtifacts: options.discardSessionArtifacts }
      : {}),
  });
  // Coordinator-owned abort registry for internal KB jobs (source-import,
  // reindex). Shared with `createCoordinatorControl.abortJobs` so
  // `coral-cli abort <kb-job-id>` reaches the KB job's AbortController —
  // distinct from per-ExecutionService provider job registries.
  const internalJobAbortRegistry = new AbortRegistry(runtime.ids);

  const control = createCoordinatorControl({
    world,
    listExecutionServices: services.listExecutionServices,
    getLifecycleController: () => lifecycleController,
    backendNamespace: world.namespace,
    getProgressStore,
    internalJobAbortRegistry,
  });
  let kbSourceImportService: KbSourceImportService | null = null;
  const getKbSourceImportService = (): KbSourceImportService => {
    const existing = kbSourceImportService;
    if (existing) return existing;
    const created = new KbSourceImportService({
      runtime,
      progressStore: getProgressStore(),
      backendNamespace: world.namespace,
      bundleHash: identity.bundleHash,
      waitForReadiness: options.waitForKbSourceImportReadiness ?? (async () => {}),
      abortRegistry: internalJobAbortRegistry,
    });
    kbSourceImportService = created;
    return created;
  };
  let kbReindexService: KbReindexService | null = null;
  const getKbReindexService = (): KbReindexService => {
    const existing = kbReindexService;
    if (existing) return existing;
    const created = new KbReindexService({
      runtime,
      progressStore: getProgressStore(),
      backendNamespace: world.namespace,
      bundleHash: identity.bundleHash,
      waitForReadiness: options.waitForKbSourceImportReadiness ?? (async () => {}),
      abortRegistry: internalJobAbortRegistry,
    });
    kbReindexService = created;
    return created;
  };
  let kbJobRecorder: KbJobRecorder | null = null;
  const getKbJobRecorder = (): KbJobRecorder => {
    const existing = kbJobRecorder;
    if (existing) return existing;
    const created = new KbJobRecorder({
      runtime,
      progressStore: getProgressStore(),
      backendNamespace: world.namespace,
      bundleHash: identity.bundleHash,
      abortRegistry: internalJobAbortRegistry,
    });
    kbJobRecorder = created;
    return created;
  };

  const readOnlyInvocationContext: InvocationContext = {
    projectRoot: '',
    pluginRoot: identity.pluginRoot,
    coralEnv: { ...world.coralEnvSnapshot },
    authority: 'admin',
  };
  // KB-tool handlers route through the subsystem registry. The registry
  // returns a structured `kb_initializing` / `kb_offline` envelope whenever
  // the subsystem is not online or degraded — handlers cascade that envelope
  // up to the transport layer where it maps to HTTP 503.
  const withKb = <T>(run: (kbSubsystem: KnowledgeBaseRuntime) => T) =>
    runtimeState.subsystems.run<KnowledgeBaseRuntime, T>(KB_ID, run);
  const withKbAsync = <T>(run: (kbSubsystem: KnowledgeBaseRuntime) => Promise<T>) =>
    runtimeState.subsystems.runAsync<KnowledgeBaseRuntime, T>(KB_ID, run);
  const recordHostedKbFailure = (operation: string, ctx: InvocationContext | undefined, result: KbToolResult): void => {
    if (result.ok || ctx === undefined) {
      return;
    }

    const jobId = ctx.coralEnv.CORAL_JOB_ID;
    const sessionId = ctx.coralEnv.CORAL_SESSION_ID;
    if (typeof jobId !== 'string' || jobId.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
      return;
    }

    const progressStore = getProgressStore();
    const status = progressStore.readStatus(jobId);
    if (
      !status ||
      status.sessionId !== sessionId ||
      !belongsToNamespace(status, world.namespace) ||
      !isLivePhase(status.phase)
    ) {
      return;
    }

    const detail = normalizeHostedKbFailureDetail(result.detail);
    getKbJobRecorder().appendHostedKbOperationFailure({
      jobId,
      sessionId,
      projectRoot: status.projectRoot,
      namespace: status.backendNamespace,
      operation,
      code: result.code,
      message: result.message,
      detail,
    });
  };

  const rpcPorts: RpcPorts = {
    sessions: {
      start: (providerName, input, ctx) => services.getExecutionService(ctx).start(providerName, input, ctx),
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
        const progressStore = getProgressStore();
        const jobs: ReturnType<typeof progressStore.listJobProjections> = [];
        for (const entry of progressStore.listJobProjections()) {
          if (!belongsToNamespace(entry.status, world.namespace)) {
            continue;
          }
          if (filters.all !== true && !isLivePhase(entry.status.phase)) {
            continue;
          }
          if (filters.projectRoot !== undefined && entry.status.projectRoot !== filters.projectRoot) {
            continue;
          }
          if (filters.phase !== undefined && entry.status.phase !== filters.phase) {
            continue;
          }
          if (filters.provider !== undefined && entry.status.provider !== filters.provider) {
            continue;
          }
          jobs.push(entry);
        }

        return jobs;
      },
      detail: (jobId) => {
        const progressStore = getProgressStore();
        const detail = progressStore.loadJobProjectionDetail(jobId);
        const status = detail.status;
        if (!status || !belongsToNamespace(status, world.namespace)) {
          return null;
        }
        const events = progressStore.readJobEvents(jobId);
        return {
          status,
          events,
          readiness: deriveLaunchReadiness(detail),
          exit: detail.exit,
        };
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
              let message = error.message;
              if (first !== undefined) {
                message = path.length > 0 ? `${path}: ${first.message}` : first.message;
              }
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
      listStaleCommunities: () => withKb((kbSubsystem) => handleKbCommunityListStale(kbSubsystem)),
      readCommunitySummaryInput: (slug) => withKb((kbSubsystem) => handleKbCommunitySummaryInput(slug, kbSubsystem)),
      setCommunitySummary: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbCommunitySetSummary(args, kbSubsystem));
        recordHostedKbFailure('community_set_summary', ctx, result);
        return result;
      },
      readWiki: (slug) => withKb((kbSubsystem) => handleKbWikiRead(slug, kbSubsystem, runtime)),
      readMemo: (slug, ctx) => withKb(() => handleKbMemoRead(slug, ctx, runtime)),
      readPrinciple: (slug) => withKb((kbSubsystem) => handleKbPrincipleRead(slug, kbSubsystem, runtime)),
      listSources: () => withKbAsync((kbSubsystem) => handleKbSourceList({}, kbSubsystem)),
      listWikis: () => withKbAsync((kbSubsystem) => handleKbWikiList({}, kbSubsystem)),
      listMemos: (args, ctx) => withKb(() => handleKbMemoList(args, ctx, runtime)),
      listPrinciples: (args) => withKbAsync((kbSubsystem) => handleKbPrinciples(args, kbSubsystem)),
      createNote: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbPromote(args, kbSubsystem, ctx, runtime));
        recordHostedKbFailure('promote', ctx, result);
        return result;
      },
      updateNote: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbUpdate(args, kbSubsystem));
        recordHostedKbFailure('update', ctx, result);
        return result;
      },
      deleteNote: async (slug, ctx) => {
        const args = { note: slug };
        const result = await withKbAsync((kbSubsystem) => handleKbDelete(args, kbSubsystem));
        recordHostedKbFailure('delete', ctx, result);
        return result;
      },
      createWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiCreate(args, kbSubsystem));
        recordHostedKbFailure('wiki_create', ctx, result);
        return result;
      },
      rewriteWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiRewrite(args, kbSubsystem));
        recordHostedKbFailure('wiki_rewrite', ctx, result);
        return result;
      },
      linkWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiLink(args, kbSubsystem));
        recordHostedKbFailure('wiki_link', ctx, result);
        return result;
      },
      unlinkWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiUnlink(args, kbSubsystem));
        recordHostedKbFailure('wiki_unlink', ctx, result);
        return result;
      },
      citeWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiCite(args, kbSubsystem));
        recordHostedKbFailure('wiki_cite', ctx, result);
        return result;
      },
      adoptWiki: async (args, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiAdopt(args, kbSubsystem, ctx, runtime));
        recordHostedKbFailure('wiki_adopt', ctx, result);
        return result;
      },
      deleteWiki: async (slug, ctx) => {
        const result = await withKbAsync((kbSubsystem) => handleKbWikiDelete({ slug }, kbSubsystem));
        recordHostedKbFailure('wiki_delete', ctx, result);
        return result;
      },
      wakeUp: (args) => withKbAsync((kbSubsystem) => handleKbWakeUp(args, kbSubsystem)),
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
          Promise.resolve(getKbSourceImportService().start(parsed.data, ctx, kbSubsystem)),
        );
        recordHostedKbFailure('source_import', ctx, result);
        return result;
      },
      deleteSource: async (slug, ctx) => {
        const args = { slug };
        const result = await withKbAsync((kbSubsystem) => handleKbSourceDelete(args, kbSubsystem));
        recordHostedKbFailure('source_delete', ctx, result);
        return result;
      },
      createMemo: (args, ctx) => {
        const result = withKb(() => handleKbMemo(args, ctx, runtime));
        recordHostedKbFailure('memo_create', ctx, result);
        return result;
      },
      deleteMemos: (args, ctx) => {
        const result = withKb(() => handleKbMemoDeleteConsolidated(args, ctx, runtime));
        recordHostedKbFailure('memo_delete', ctx, result);
        return result;
      },
      reindex: async (args, ctx) => {
        const invocationContext = ctx ?? readOnlyInvocationContext;
        const request = { async: args.async === true };
        const result = await withKbAsync((kbSubsystem) =>
          Promise.resolve(getKbReindexService().run(request, invocationContext, kbSubsystem)),
        );
        recordHostedKbFailure('reindex', ctx, result);
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
    expansion: createRefBackedExpansionRpc(storeServicesRef),
  };

  const httpHandlerDeps: HttpHandlerPorts = {
    identity,
    coralEnvSnapshot: world.coralEnvSnapshot,
    admin: {
      getLifecycleState: () => runtimeState.getLifecycle(),
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
        const storeServices = storeServicesRef.tryGet();
        const lifecycleState = runtimeState.getLifecycle();
        // Legacy `status` field — older CLIs validate the strict
        // `'starting' | 'ok' | 'draining'` enum. New consumers read
        // `kernel.phase` for the full 5-state lifecycle.
        let legacyStatus: 'starting' | 'ok' | 'draining';
        if (world.idleTimer.isDraining || lifecycleState === 'draining' || lifecycleState === 'stopped') {
          legacyStatus = 'draining';
        } else if (lifecycleState === 'running' && storeServices !== null) {
          legacyStatus = 'ok';
        } else {
          legacyStatus = 'starting';
        }
        const platform = runtime.env.platform() as NodeJS.Platform;
        const processStartedAt = probeProcessStartedAtSeconds(world.backendPid, platform) ?? undefined;

        // Strip the branded `SubsystemId` to plain string at the wire boundary;
        // transport types use `string` because the brand is enforced producer-side.
        const subsystems = runtimeState.subsystems.list().map((entry) => ({ ...entry, id: entry.id as string }));

        const consumerStuck = storeServices === null ? [] : options.getConsumerStuck();
        const mutationBlockedSnapshot =
          storeServices === null ? { blocked: false as const } : options.getMutationBlocked();
        const diagnostics: {
          mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
          consumerStuck?: Array<{ id: string; elapsedSinceStopMs: number }>;
        } = {};
        if (mutationBlockedSnapshot.blocked) {
          diagnostics.mutationBlocked = {
            owner: mutationBlockedSnapshot.owner,
            ageMs: mutationBlockedSnapshot.ageMs,
            signaledAtMs: mutationBlockedSnapshot.signaledAtMs,
          };
        }
        if (consumerStuck.length > 0) {
          diagnostics.consumerStuck = consumerStuck;
        }
        const hasDiagnostics = diagnostics.mutationBlocked !== undefined || diagnostics.consumerStuck !== undefined;

        return {
          status: legacyStatus,
          kernel: {
            phase: lifecycleState,
            readyAt: lifecycleState === 'starting' ? null : runtimeState.getStartedAt(),
          },
          version: identity.version,
          bundleHash: identity.bundleHash,
          flavor: identity.flavor,
          namespace: identity.namespace,
          instanceId: identity.instanceId,
          pid: world.backendPid,
          ...(processStartedAt !== undefined ? { processStartedAt } : {}),
          uptimeMs: identity.now() - runtimeState.getStartedAt(),
          active: world.launchCoordinator.active,
          activeJobs:
            storeServices === null ? 0 : storeServices.progressStore.liveJobCountByNamespace(identity.namespace),
          liveDiscuss: listAttachedSessions(world.discussRegistry).length,
          queueDepth: world.launchCoordinator.queueDepth(),
          inflightRequests: world.idleTimer.inflightRequests,
          textProjectionState: options.getTextProjectionState?.() ?? 'idle',
          subsystems,
          ...(hasDiagnostics ? { diagnostics } : {}),
          env,
        };
      },
    },
    events: {
      addResponse: (res) => {
        if (streamResponses.has(res)) {
          return;
        }
        if (streamResponses.size >= MAX_EVENT_STREAM_CONNECTIONS) {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            sendJson(res, 503, EVENT_STREAM_CAPACITY_RESPONSE);
            return;
          }
          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
          return;
        }
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
    storeServicesRef,
    createStoreServicesFromDbFn,
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
    writeBackendInfoFn: defaults.writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: defaults.removeBackendInfoIfOwnerFn,
    cleanupStaleJobsFn: defaults.cleanupStaleJobsFn,
    markJobsAsErrorFn: defaults.markJobsAsErrorFn,
    terminateAllFn: defaults.terminateAllFn,
    providerHostManager: world.providerHostManager,
    disposeLifecycleReactor: options.disposeLifecycleReactor ?? (() => {}),
    handoffQuiescePorts: () =>
      services
        .listExecutionServices()
        .filter(
          (svc): svc is typeof svc & { quiesceAppServerJobsForHandoff: (signal: AbortSignal) => Promise<void> } =>
            typeof (svc as { quiesceAppServerJobsForHandoff?: unknown }).quiesceAppServerJobsForHandoff === 'function',
        ),
    createKbSubsystemFn: defaults.createKbSubsystemFn,
    createCurateAssistant: defaults.createCurateAssistant,
    registerBuiltInProvidersFn: defaults.registerBuiltInProvidersFn,
    recoverPersistedDiscussFn: defaults.recoverPersistedDiscussFn,
    runStartupRecoveryFn: options.runStartupRecoveryFn,
    hooks: discuss.hooks,
    closeServerFn: defaults.closeServerFn,
    listenFn: defaults.listenFn,
    ipcServer,
    closeIpcServerFn: closeIpcServer,
    listenIpcFn:
      options.listenIpcFn ?? ((listener) => listenIpcServer(listener, runtime.paths.coral.coordinator.socketPath)),
    onStopped: options.onStopped,
    onFatalShutdownError: options.onFatalShutdownError,
  };

  lifecycleController = createLifecycle(lifecycleDeps);
  const resolvedLifecycleController = lifecycleController;
  // Install the starting-incumbent shutdown callback. `transport.shutdown`
  // invokes both `requestDrain('replaced')` (idle-timer driven) AND this
  // callback so a still-`starting` incumbent quits immediately rather than
  // waiting for `idleTimer.startWatching` to be installed at lifecycle
  // 'running'. The callback fires once per request — `lifecycleController.shutdown`
  // is itself idempotent (returns the existing `state.shutdownPromise`).
  ipcServer.onShutdownRequest = (reason) => {
    void resolvedLifecycleController.shutdown(reason).catch(() => {});
  };

  return {
    identity,
    server,
    handleRequest,
    lifecycleController: resolvedLifecycleController,
    idleTimer: world.idleTimer,
    discussRegistry: world.discussRegistry,
    runtimeState,
    storeServicesRef,
    eventBus: world.eventBus,
    launchCoordinator: world.launchCoordinator,
    providerRegistry: world.providerRegistry,
    providerHostManager: world.providerHostManager,
    expansionLifecycleService: null,
    getExecutionService: services.getExecutionService,
    getRecoveryService: services.getRecoveryService,
    listExecutionServices: services.listExecutionServices,
    getDiscussStoreForSource: discuss.getDiscussStoreForSource,
    getDiscussContext: discuss.getDiscussContext,
    resolveProjectSource: world.resolveProjectSource,
    isDrainRequested: control.isDrainRequested,
    requestDrain: control.requestDrain,
    getKbJobRecorder,
    hooks: discuss.hooks,
  };
}
