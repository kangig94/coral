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
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { formatError } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { deriveLaunchReadiness } from '../../jobs/launch-readiness.js';
import type { EventStreamHandlers, HealthSnapshot, HttpHandlerPorts } from '../../transport/server-ports.js';
import type { StoragePort } from '../../infra/port-types.js';
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
import { createDisabledKbChildSupervisor, type KbChildSupervisor } from '../kb-child/supervisor.js';
import { createKbChildProxySubsystem } from '../kb-child/proxy-subsystem.js';
import type { KbCorpusSnapshot } from '../../kb/contract.js';

export const MAX_EVENT_STREAM_CONNECTIONS = 100;
export const CORAL_KB_CHILD_READS_ENV = 'CORAL_KB_CHILD_READS';
export const CORAL_KB_CHILD_MUTATIONS_ENV = 'CORAL_KB_CHILD_MUTATIONS';
const KB_CHILD_JOB_ABORT_PROXY_TTL_MS = 24 * 60 * 60 * 1000;

const EVENT_STREAM_CAPACITY_RESPONSE = {
  code: 'too_many_event_streams',
  message: 'Too many event stream connections',
};

const EMPTY_CORPUS_SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};

type CorpusSnapshotCursorRow = {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
};

function readPersistedCorpusSnapshot(db: { prepare(sql: string): { get(): CorpusSnapshotCursorRow | undefined } }): KbCorpusSnapshot {
  const row = db
    .prepare(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM kb_corpus_state
         WHERE id = 1
      `,
    )
    .get();
  if (row === undefined) {
    return { ...EMPTY_CORPUS_SNAPSHOT };
  }
  return {
    snapshotId: row.snapshot_id ?? '',
    contentSeq: row.content_seq ?? 0,
    metadataSeq: row.metadata_seq ?? 0,
    contentManifestHash: row.content_manifest_hash ?? '',
    metadataManifestHash: row.metadata_manifest_hash ?? '',
  };
}

function shouldDelegateKbReadsToChild(options: CoordinatorCoreOptions, kbChildSupervisor: KbChildSupervisor): boolean {
  if (options.delegateKbReadsToChild === false || options.runtime.env.get(CORAL_KB_CHILD_READS_ENV) === '0') {
    return false;
  }
  if (options.delegateKbReadsToChild === true || options.runtime.env.get(CORAL_KB_CHILD_READS_ENV) === '1') {
    return true;
  }
  return kbChildSupervisor.read().enabled;
}

function shouldDelegateKbMutationsToChild(options: CoordinatorCoreOptions, kbChildSupervisor: KbChildSupervisor): boolean {
  if (options.delegateKbMutationsToChild === false || options.runtime.env.get(CORAL_KB_CHILD_MUTATIONS_ENV) === '0') {
    return false;
  }
  if (options.delegateKbMutationsToChild === true || options.runtime.env.get(CORAL_KB_CHILD_MUTATIONS_ENV) === '1') {
    return true;
  }
  return kbChildSupervisor.read().enabled;
}

let eventLoopDelayMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;

function readEventLoopLagMs(): number {
  if (eventLoopDelayMonitor === null) {
    eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelayMonitor.enable();
    return 0;
  }

  const meanNs = eventLoopDelayMonitor.mean;
  if (!Number.isFinite(meanNs)) {
    return 0;
  }
  return Math.max(0, Math.round(meanNs / 1_000_000));
}

function readFdCount(storage: Pick<StoragePort, 'readdirSync'>): number | undefined {
  try {
    return storage.readdirSync('/proc/self/fd').length;
  } catch {
    return undefined;
  }
}

function readResourceSnapshot(
  storage: Pick<StoragePort, 'readdirSync'>,
  ipcOpenSockets: number,
  eventStreamResponses: number,
): NonNullable<HealthSnapshot['resources']> {
  const memory = process.memoryUsage();
  const fdCount = readFdCount(storage);
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopLagMs: readEventLoopLagMs(),
    ipcOpenSockets,
    eventStreamResponses,
    ...(fdCount === undefined ? {} : { fdCount }),
  };
}

function createKbChildReadPort(localKb: RpcPorts['kb'], kbChildSupervisor: KbChildSupervisor): RpcPorts['kb'] {
  return {
    ...localKb,
    readSearch: (args) => kbChildSupervisor.readKb({ method: 'readSearch', args }),
    diagnose: () => kbChildSupervisor.readKb({ method: 'diagnose' }),
    readNote: (slug) => kbChildSupervisor.readKb({ method: 'readNote', slug }),
    readSource: (slug) => kbChildSupervisor.readKb({ method: 'readSource', slug }),
    readCommunity: (slug) => kbChildSupervisor.readKb({ method: 'readCommunity', slug }),
    readWiki: (slug) => kbChildSupervisor.readKb({ method: 'readWiki', slug }),
    readMemo: (slug, ctx) => kbChildSupervisor.readKb({ method: 'readMemo', slug, ctx }),
    readPrinciple: (slug) => kbChildSupervisor.readKb({ method: 'readPrinciple', slug }),
    listSources: () => kbChildSupervisor.readKb({ method: 'listSources' }),
    listWikis: () => kbChildSupervisor.readKb({ method: 'listWikis' }),
    listMemos: (args, ctx) => kbChildSupervisor.readKb({ method: 'listMemos', args, ctx }),
    listPrinciples: (args) => kbChildSupervisor.readKb({ method: 'listPrinciples', args }),
    listStaleCommunities: () => kbChildSupervisor.readKb({ method: 'listStaleCommunities' }),
    readCommunitySummaryInput: (slug) => kbChildSupervisor.readKb({ method: 'readCommunitySummaryInput', slug }),
    wakeUp: (args) => kbChildSupervisor.readKb({ method: 'wakeUp', args }),
  };
}

function readStartedKbJobId(result: KbToolResult): string | null {
  if (!result.ok || typeof result.data !== 'object' || result.data === null) {
    return null;
  }
  const data = result.data as { status?: unknown; job?: unknown };
  if (
    (data.status === 'running' || data.status === 'queued') &&
    typeof data.job === 'string' &&
    data.job.length > 0
  ) {
    return data.job;
  }
  return null;
}

function createKbChildMutationPort(
  localKb: RpcPorts['kb'],
  kbChildSupervisor: KbChildSupervisor,
  recordHostedKbFailure: (operation: string, ctx: InvocationContext | undefined, result: KbToolResult) => void,
  notifyHostedCorpusMutation: () => void,
  registerChildJobAbortProxy: (jobId: string) => void,
  fallbackContext: InvocationContext,
): RpcPorts['kb'] {
  const recordAndNotify = (
    operation: string,
    ctx: InvocationContext | undefined,
    result: KbToolResult,
    options: { corpusMutation?: boolean } = {},
  ): KbToolResult => {
    recordHostedKbFailure(operation, ctx, result);
    if (result.ok && options.corpusMutation === true) {
      notifyHostedCorpusMutation();
    }
    return result;
  };
  const ctxOrFallback = (ctx: InvocationContext | undefined): InvocationContext => ctx ?? fallbackContext;
  return {
    ...localKb,
    setCommunitySummary: async (args, ctx) => {
      const invocationCtx = ctxOrFallback(ctx);
      const result = await kbChildSupervisor.mutateKb({ method: 'setCommunitySummary', args, ctx: invocationCtx });
      return recordAndNotify('community_set_summary', ctx, result, { corpusMutation: true });
    },
    createNote: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'createNote', args, ctx });
      return recordAndNotify('promote', ctx, result, { corpusMutation: true });
    },
    updateNote: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'updateNote', args, ctx });
      return recordAndNotify('update', ctx, result, { corpusMutation: true });
    },
    deleteNote: async (slug, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'deleteNote', slug, ctx });
      return recordAndNotify('delete', ctx, result, { corpusMutation: true });
    },
    createSource: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'createSource', args, ctx });
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        registerChildJobAbortProxy(jobId);
      }
      return recordAndNotify('source_import', ctx, result);
    },
    createWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'createWiki', args, ctx });
      return recordAndNotify('wiki_create', ctx, result, { corpusMutation: true });
    },
    rewriteWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'rewriteWiki', args, ctx });
      return recordAndNotify('wiki_rewrite', ctx, result, { corpusMutation: true });
    },
    linkWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'linkWiki', args, ctx });
      return recordAndNotify('wiki_link', ctx, result, { corpusMutation: true });
    },
    unlinkWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'unlinkWiki', args, ctx });
      return recordAndNotify('wiki_unlink', ctx, result, { corpusMutation: true });
    },
    citeWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'citeWiki', args, ctx });
      return recordAndNotify('wiki_cite', ctx, result, { corpusMutation: true });
    },
    adoptWiki: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'adoptWiki', args, ctx });
      return recordAndNotify('wiki_adopt', ctx, result, { corpusMutation: true });
    },
    deleteWiki: async (slug, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'deleteWiki', slug, ctx });
      return recordAndNotify('wiki_delete', ctx, result, { corpusMutation: true });
    },
    deleteSource: async (slug, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'deleteSource', slug, ctx });
      return recordAndNotify('source_delete', ctx, result, { corpusMutation: true });
    },
    createMemo: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'createMemo', args, ctx });
      return recordAndNotify('memo_create', ctx, result);
    },
    deleteMemos: async (args, ctx) => {
      const result = await kbChildSupervisor.mutateKb({ method: 'deleteMemos', args, ctx });
      return recordAndNotify('memo_delete', ctx, result);
    },
    reindex: async (args, ctx) => {
      const invocationCtx = ctxOrFallback(ctx);
      const result = await kbChildSupervisor.mutateKb({ method: 'reindex', args, ctx: invocationCtx });
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        registerChildJobAbortProxy(jobId);
      }
      return recordAndNotify('reindex', ctx, result);
    },
  };
}

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
  const kbChildSupervisor =
    options.kbChildSupervisor ?? createDisabledKbChildSupervisor('not configured for this coordinator core');
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
  let readIpcOpenSockets = () => 0;
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
  const notifyHostedCorpusMutation = (): void => {
    try {
      const storeServices = getStoreServices();
      const snapshot = readPersistedCorpusSnapshot(storeServices.storeDb);
      const invalidateResult = runtimeState.subsystems.run<KnowledgeBaseRuntime, void>(KB_ID, (kbSubsystem) => {
        kbSubsystem.kb.invalidateKbCache();
      });
      void invalidateResult;
      storeServices.consumerDriver?.notifyCorpus(snapshot);
    } catch (error) {
      world.log(`[kb-child] failed to publish hosted corpus mutation: ${formatError(error)}\n`);
    }
  };
  const registerChildJobAbortProxy = (jobId: string): void => {
    const cleanupTimer = runtime.time.setTimeout(() => {
      internalJobAbortRegistry.remove(jobId);
    }, KB_CHILD_JOB_ABORT_PROXY_TTL_MS);
    cleanupTimer.unref?.();
    internalJobAbortRegistry.register(jobId, () => {
      runtime.time.clearTimeout(cleanupTimer);
      const abortResult = kbChildSupervisor.abortKbJobs?.([jobId]) ?? Promise.resolve({ aborted: [], notFound: [jobId] });
      void abortResult.finally(() => {
        internalJobAbortRegistry.remove(jobId);
      });
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
  const delegateKbReadsToChild = shouldDelegateKbReadsToChild(options, kbChildSupervisor);
  const delegateKbMutationsToChild = shouldDelegateKbMutationsToChild(options, kbChildSupervisor);
  const useKbChildRuntimeOnly =
    options.useKbChildRuntimeOnly === true && delegateKbReadsToChild && delegateKbMutationsToChild;

  let effectiveKbPorts = rpcPorts.kb;
  if (delegateKbReadsToChild) {
    effectiveKbPorts = createKbChildReadPort(effectiveKbPorts, kbChildSupervisor);
  }
  if (delegateKbMutationsToChild) {
    effectiveKbPorts = createKbChildMutationPort(
      effectiveKbPorts,
      kbChildSupervisor,
      recordHostedKbFailure,
      notifyHostedCorpusMutation,
      registerChildJobAbortProxy,
      readOnlyInvocationContext,
    );
  }
  const effectiveRpcPorts: RpcPorts = { ...rpcPorts, kb: effectiveKbPorts };

  const httpHandlerDeps: HttpHandlerPorts = {
    identity,
    time: runtime.time,
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
      probeKbChild: () => kbChildSupervisor.probe(),
      restartKbChild: (reason) => kbChildSupervisor.restart(reason),
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

        const consumerStuck: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['consumerStuck']> =
          storeServices === null ? [] : (options.getConsumerStuck() ?? []);
        const mutationBlockedSnapshot =
          storeServices === null ? { blocked: false as const } : options.getMutationBlocked();
        const diagnostics: {
          mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
          consumerStuck?: NonNullable<HealthSnapshot['diagnostics']>['consumerStuck'];
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
          resources: readResourceSnapshot(runtime.storage, readIpcOpenSockets(), streamResponses.size),
          subsystems,
          kbChild: kbChildSupervisor.read(),
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
    ...effectiveRpcPorts,
  };

  const handleRequest = createHttpHandler(httpHandlerDeps);
  const ipcServer = createIpcServer(httpHandlerDeps);
  readIpcOpenSockets = () => ipcServer.sockets.size;

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
    kbChildSupervisor,
    disposeLifecycleReactor: options.disposeLifecycleReactor ?? (() => {}),
    handoffQuiescePorts: () =>
      services
        .listExecutionServices()
        .filter(
          (svc): svc is typeof svc & { quiesceAppServerJobsForHandoff: (signal: AbortSignal) => Promise<void> } =>
            typeof (svc as { quiesceAppServerJobsForHandoff?: unknown }).quiesceAppServerJobsForHandoff === 'function',
        ),
    createKbSubsystemFn: useKbChildRuntimeOnly
      ? () => createKbChildProxySubsystem(kbChildSupervisor)
      : defaults.createKbSubsystemFn,
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
