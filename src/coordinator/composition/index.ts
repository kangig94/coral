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
import { invocationCoralEnvSnapshot } from '../../infra/env-sanitize.js';
import { isRecord } from '../../infra/json.js';
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
import { createHttpHandler, sendJson } from '../../transport/http/handler.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '../../transport/ipc/server.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { KbToolResult } from '../../kb/result.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Principal } from '../../security/principal.js';
import { principalToWire } from '../../security/principal-wire.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import { createRuntimeState, createLifecycle, type LifecycleController, type LifecycleDeps } from '../lifecycle.js';
import { createRuntimeComponentRegistry } from '../runtime-components/registry.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './types.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { createCoordinatorControl } from './job-control.js';
import { resolveCoordinatorDefaults } from './defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { createExecutionServices } from './execution-services.js';
import { createCoordinatorWorld } from './world.js';
import { storeServicesStartupNotReadyError } from './store-services-ref.js';
import { isLivePhase, isTerminalPhase } from '../../jobs/phase.js';
import { belongsToNamespace } from '../../jobs/records.js';
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
import { KbJobRecorder, normalizeHostedKbFailureDetail } from '../../jobs/kb/recorder.js';
import { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import { type KbDaemonHealthSnapshot, type KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { KbDaemonRequestContextWire } from '../../kb-daemon/protocol.js';
import { createKbDaemonHealthComponent } from '../runtime-components/kb-health-component.js';
import type { KbCorpusSnapshot } from '../../kb/contract.js';
import { markJobAsError } from '../../jobs/reconcile/recovery-effects.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';

export const MAX_EVENT_STREAM_CONNECTIONS = 100;
const KB_DAEMON_JOB_ABORT_PROXY_TTL_MS = 24 * 60 * 60 * 1000;

type KbReadRpcPort = Pick<
  RpcPorts['kb'],
  | 'readSearch'
  | 'diagnose'
  | 'readNote'
  | 'readSource'
  | 'readCommunity'
  | 'listStaleCommunities'
  | 'readCommunitySummaryInput'
  | 'readWiki'
  | 'readMemo'
  | 'readPrinciple'
  | 'listSources'
  | 'listWikis'
  | 'listMemos'
  | 'listPrinciples'
  | 'wakeUp'
>;

const EVENT_STREAM_CAPACITY_RESPONSE = {
  code: 'too_many_event_streams',
  message: 'Too many event stream connections',
};

const TERMINAL_DISCUSS_STATUSES = new Set(['ended', 'completed', 'aborted', 'error', 'failed', 'closed']);

function isTerminalDiscussStatus(status: string): boolean {
  return TERMINAL_DISCUSS_STATUSES.has(status);
}

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

function readPersistedCorpusSnapshot(db: {
  prepare(sql: string): { get(): CorpusSnapshotCursorRow | undefined };
}): KbCorpusSnapshot {
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

export function createKbDaemonReadPort(kbDaemonSupervisor: KbDaemonSupervisor): KbReadRpcPort {
  const daemonCtx = (ctx: InvocationContext | Principal): KbDaemonRequestContextWire => toKbDaemonWireContext(ctx);

  return {
    readSearch: (args, principal) => {
      const request = { method: 'readSearch' as const, args, ctx: daemonCtx(principal) };
      const signal = readAbortSignal(args);
      return signal === undefined ? kbDaemonSupervisor.readKb(request) : kbDaemonSupervisor.readKb(request, { signal });
    },
    diagnose: (principal) => kbDaemonSupervisor.readKb({ method: 'diagnose', ctx: daemonCtx(principal) }),
    readNote: (slug, principal) => kbDaemonSupervisor.readKb({ method: 'readNote', slug, ctx: daemonCtx(principal) }),
    readSource: (slug, principal) =>
      kbDaemonSupervisor.readKb({ method: 'readSource', slug, ctx: daemonCtx(principal) }),
    readCommunity: (slug, principal) =>
      kbDaemonSupervisor.readKb({ method: 'readCommunity', slug, ctx: daemonCtx(principal) }),
    readWiki: (slug, principal) => kbDaemonSupervisor.readKb({ method: 'readWiki', slug, ctx: daemonCtx(principal) }),
    readMemo: (slug, ctx) => kbDaemonSupervisor.readKb({ method: 'readMemo', slug, ctx: daemonCtx(ctx) }),
    readPrinciple: (slug, principal) =>
      kbDaemonSupervisor.readKb({ method: 'readPrinciple', slug, ctx: daemonCtx(principal) }),
    listSources: (principal) => kbDaemonSupervisor.readKb({ method: 'listSources', ctx: daemonCtx(principal) }),
    listWikis: (principal) => kbDaemonSupervisor.readKb({ method: 'listWikis', ctx: daemonCtx(principal) }),
    listMemos: (args, ctx) => kbDaemonSupervisor.readKb({ method: 'listMemos', args, ctx: daemonCtx(ctx) }),
    listPrinciples: (args, principal) =>
      kbDaemonSupervisor.readKb({ method: 'listPrinciples', args, ctx: daemonCtx(principal) }),
    listStaleCommunities: (principal) =>
      kbDaemonSupervisor.readKb({ method: 'listStaleCommunities', ctx: daemonCtx(principal) }),
    readCommunitySummaryInput: (slug, principal) =>
      kbDaemonSupervisor.readKb({ method: 'readCommunitySummaryInput', slug, ctx: daemonCtx(principal) }),
    wakeUp: (args, principal) => kbDaemonSupervisor.readKb({ method: 'wakeUp', args, ctx: daemonCtx(principal) }),
  };
}

function readAbortSignal(args: Record<string, unknown>): AbortSignal | undefined {
  const signal = args.abortSignal;
  return typeof signal === 'object' &&
    signal !== null &&
    'aborted' in signal &&
    'addEventListener' in signal &&
    'removeEventListener' in signal
    ? (signal as AbortSignal)
    : undefined;
}

function readStartedKbJobId(result: KbToolResult): string | null {
  if (!result.ok || typeof result.data !== 'object' || result.data === null) {
    return null;
  }
  const data = result.data as { status?: unknown; job?: unknown };
  if ((data.status === 'running' || data.status === 'queued') && typeof data.job === 'string' && data.job.length > 0) {
    return data.job;
  }
  return null;
}

function toKbDaemonWireContext(ctx: InvocationContext | Principal): KbDaemonRequestContextWire {
  if (!('principal' in ctx)) {
    return { principal: principalToWire(ctx) };
  }
  return {
    ...(ctx.projectRoot.length === 0 ? {} : { projectRoot: ctx.projectRoot }),
    ...(ctx.pluginRoot.length === 0 ? {} : { pluginRoot: ctx.pluginRoot }),
    ...(Object.keys(ctx.coralEnv).length === 0 ? {} : { coralEnv: ctx.coralEnv }),
    principal: principalToWire(ctx.principal),
  };
}

function createKbDaemonMutationPort(
  readPort: ReturnType<typeof createKbDaemonReadPort>,
  kbDaemonSupervisor: KbDaemonSupervisor,
  recordHostedKbFailure: (operation: string, ctx: InvocationContext | undefined, result: KbToolResult) => void,
  notifyHostedCorpusMutation: () => void,
  registerDaemonJobAbortProxy: (jobId: string) => void,
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
  const daemonCtx = (ctx: InvocationContext | undefined): KbDaemonRequestContextWire =>
    toKbDaemonWireContext(ctx ?? fallbackContext);
  return {
    ...readPort,
    setCommunitySummary: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({
        method: 'setCommunitySummary',
        args,
        ctx: daemonCtx(ctx),
      });
      return recordAndNotify('community_set_summary', ctx, result, { corpusMutation: true });
    },
    createNote: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createNote', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('promote', ctx, result, { corpusMutation: true });
    },
    updateNote: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'updateNote', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('update', ctx, result, { corpusMutation: true });
    },
    deleteNote: async (slug, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteNote', slug, ctx: daemonCtx(ctx) });
      return recordAndNotify('delete', ctx, result, { corpusMutation: true });
    },
    createSource: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createSource', args, ctx: daemonCtx(ctx) });
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        registerDaemonJobAbortProxy(jobId);
      }
      return recordAndNotify('source_import', ctx, result);
    },
    createWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_create', ctx, result, { corpusMutation: true });
    },
    rewriteWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'rewriteWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_rewrite', ctx, result, { corpusMutation: true });
    },
    linkWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'linkWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_link', ctx, result, { corpusMutation: true });
    },
    unlinkWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'unlinkWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_unlink', ctx, result, { corpusMutation: true });
    },
    citeWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'citeWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_cite', ctx, result, { corpusMutation: true });
    },
    adoptWiki: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'adoptWiki', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_adopt', ctx, result, { corpusMutation: true });
    },
    deleteWiki: async (slug, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteWiki', slug, ctx: daemonCtx(ctx) });
      return recordAndNotify('wiki_delete', ctx, result, { corpusMutation: true });
    },
    deleteSource: async (slug, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteSource', slug, ctx: daemonCtx(ctx) });
      return recordAndNotify('source_delete', ctx, result, { corpusMutation: true });
    },
    createMemo: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createMemo', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('memo_create', ctx, result);
    },
    deleteMemos: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteMemos', args, ctx: daemonCtx(ctx) });
      return recordAndNotify('memo_delete', ctx, result);
    },
    reindex: async (args, ctx) => {
      const result = await kbDaemonSupervisor.mutateKb({
        method: 'reindex',
        args,
        ctx: daemonCtx(ctx),
      });
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        registerDaemonJobAbortProxy(jobId);
      }
      return recordAndNotify('reindex', ctx, result);
    },
  };
}

function createKbDaemonExpansionRpc(kbDaemonSupervisor: KbDaemonSupervisor): ExpansionRequestPort {
  const errorContext = (detail: unknown): Record<string, unknown> | undefined => {
    if (detail === undefined) {
      return undefined;
    }
    return isRecord(detail) ? detail : { detail };
  };
  const errorRemediation = (code: string): string => {
    switch (code) {
      case 'invalid_request':
        return "Retry with valid expansion command arguments or run 'coral-cli expansion --help'.";
      case 'kb_disabled':
        return 'Enable the KB daemon runtime and restart Coral, then retry.';
      case 'kb_initializing':
      case 'kb_offline':
      case 'kb_unavailable':
        return 'Wait for the KB daemon runtime to become available or restart Coral, then retry.';
      case 'kb_daemon_protocol_error':
        return 'Restart Coral and retry. If this persists, check the coordinator logs.';
      default:
        return 'Retry the expansion command. If this persists, check the coordinator logs.';
    }
  };
  const run = async <T>(
    method: Parameters<KbDaemonSupervisor['expansionRpc']>[0]['method'],
    args: unknown,
    principal: Principal | undefined,
  ): Promise<T> => {
    if (principal === undefined) {
      throw new CoralSetupError({
        code: 'invalid_request',
        userMessage: 'Expansion request requires principal context.',
        remediation: "Retry the expansion command. If this persists, run 'coral-cli expansion --help'.",
      });
    }
    const result = await kbDaemonSupervisor.expansionRpc({ method, args, ctx: toKbDaemonWireContext(principal) });
    if (!result.ok) {
      throw new CoralSetupError({
        code: result.code,
        userMessage: result.message,
        remediation: result.remediation ?? errorRemediation(result.code),
        context: errorContext(result.detail),
      });
    }
    return result.data as T;
  };

  return {
    equipExpansion: (request: EquipExpansionRequest, principal?: Principal): Promise<EquipExpansionResult> =>
      run('equipExpansion', request, principal),
    unequipExpansion: (request: UnequipExpansionRequest, principal?: Principal): Promise<UnequipExpansionResult> =>
      run('unequipExpansion', request, principal),
    removeExpansionCatalog: (
      request: RemoveExpansionCatalogRequest,
      principal?: Principal,
    ): Promise<RemoveExpansionCatalogResult> => run('removeExpansionCatalog', request, principal),
    listExpansion: (request: ListExpansionRequest, principal?: Principal): Promise<ListExpansionResult> =>
      run('listExpansion', request, principal),
    readBinding: (request: ReadBindingRequest, principal?: Principal): Promise<ReadBindingResult> =>
      run('readBinding', request, principal),
  };
}

export function createCoordinatorCore(options: CoordinatorCoreOptions): CoordinatorCoreResult {
  const runtime = options.runtime;

  const defaultsPlan = resolveCoordinatorDefaults(options, runtime);
  const world = createCoordinatorWorld(options, runtime, defaultsPlan);
  const kbDaemonSupervisor = options.kbDaemonSupervisor;
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
  const components = createRuntimeComponentRegistry();
  const runtimeState = createRuntimeState(world.now(), components);
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
    coralEnv: invocationCoralEnvSnapshot(world.coralEnvSnapshot),
    principal: {
      subject: 'system',
      transport: 'internal',
      credential: { kind: 'internal', id: 'coordinator-readonly' },
      binding: { kind: 'unbound' },
    },
  };
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
      storeServices.consumerDriver?.notifyCorpus(snapshot);
    } catch (error) {
      world.log(`[kb-daemon] failed to publish hosted corpus mutation: ${formatError(error)}\n`);
    }
  };
  const daemonOwnedKbJobs = new Map<string, { cleanupTimer: ReturnType<typeof runtime.time.setTimeout> }>();
  const cleanupDaemonJobAbortProxy = (jobId: string): void => {
    const tracked = daemonOwnedKbJobs.get(jobId);
    if (tracked !== undefined) {
      runtime.time.clearTimeout(tracked.cleanupTimer);
      daemonOwnedKbJobs.delete(jobId);
    }
    internalJobAbortRegistry.remove(jobId);
    if (daemonOwnedKbJobs.size === 0) {
      disposeDaemonJobTerminalListeners();
    }
  };
  const cleanupTerminalDaemonJobAbortProxy = (jobId: string, phase: string): void => {
    if (!isTerminalPhase(phase) || !daemonOwnedKbJobs.has(jobId)) {
      return;
    }
    cleanupDaemonJobAbortProxy(jobId);
  };
  const onDaemonJobPhaseChanged = (event: { jobId: string; phase: string }): void => {
    cleanupTerminalDaemonJobAbortProxy(event.jobId, event.phase);
  };
  const onDaemonJobCompleted = (event: { jobId: string }): void => {
    if (!daemonOwnedKbJobs.has(event.jobId)) {
      return;
    }
    cleanupDaemonJobAbortProxy(event.jobId);
  };
  let daemonJobTerminalListenersRegistered = false;
  const ensureDaemonJobTerminalListeners = (): void => {
    if (daemonJobTerminalListenersRegistered) {
      return;
    }
    daemonJobTerminalListenersRegistered = true;
    world.eventBus.on('job:phase_changed', onDaemonJobPhaseChanged);
    world.eventBus.on('job:completed', onDaemonJobCompleted);
  };
  const disposeDaemonJobTerminalListeners = (): void => {
    if (!daemonJobTerminalListenersRegistered) {
      return;
    }
    daemonJobTerminalListenersRegistered = false;
    world.eventBus.off('job:phase_changed', onDaemonJobPhaseChanged);
    world.eventBus.off('job:completed', onDaemonJobCompleted);
  };
  const onChildPrincipalJobPhaseChanged = (event: { jobId: string; phase: string }): void => {
    if (isTerminalPhase(event.phase)) {
      world.childPrincipalRegistry.revokeParentJob(event.jobId);
    }
  };
  const onChildPrincipalJobCompleted = (event: { jobId: string }): void => {
    world.childPrincipalRegistry.revokeParentJob(event.jobId);
  };
  const onChildPrincipalDiscussUpdated = (event: { sessionId: string; status: string }): void => {
    if (isTerminalDiscussStatus(event.status)) {
      world.childPrincipalRegistry.revokeParentSession(event.sessionId);
    }
  };
  world.eventBus.on('job:phase_changed', onChildPrincipalJobPhaseChanged);
  world.eventBus.on('job:completed', onChildPrincipalJobCompleted);
  world.eventBus.on('discuss:updated', onChildPrincipalDiscussUpdated);
  const disposeChildPrincipalTerminalListeners = (): void => {
    world.eventBus.off('job:phase_changed', onChildPrincipalJobPhaseChanged);
    world.eventBus.off('job:completed', onChildPrincipalJobCompleted);
    world.eventBus.off('discuss:updated', onChildPrincipalDiscussUpdated);
  };
  const describeKbDaemonExit = (snapshot: KbDaemonHealthSnapshot): string => {
    const exit = snapshot.lastExit;
    const suffix =
      exit === undefined
        ? ''
        : ` (code=${String(exit.code)}, signal=${String(exit.signal)}, generation=${snapshot.generation})`;
    return `KB daemon exited${suffix}: ${snapshot.lastError ?? snapshot.reason ?? snapshot.phase}`;
  };
  const listDurableDaemonOwnedKbJobs = (progressStore: JobProgressStore): string[] => {
    const jobIds: string[] = [];
    for (const jobId of progressStore.listJobIds()) {
      const status = progressStore.readStatus(jobId);
      if (
        status === null ||
        !isLivePhase(status.phase) ||
        !belongsToNamespace(status, world.namespace) ||
        status.jobKind !== 'kb'
      ) {
        continue;
      }
      const runtime = progressStore.readRuntimeProjection(jobId);
      if (runtime?.transport === 'internal' && runtime.owner === 'kb-daemon') {
        jobIds.push(jobId);
      }
    }
    return jobIds;
  };
  const failTrackedDaemonJobs = (snapshot: KbDaemonHealthSnapshot): void => {
    const message = describeKbDaemonExit(snapshot);
    try {
      const progressStore = getProgressStore();
      const daemonOwnedJobIds = new Set([...daemonOwnedKbJobs.keys(), ...listDurableDaemonOwnedKbJobs(progressStore)]);
      if (daemonOwnedJobIds.size === 0) {
        return;
      }
      const failed: string[] = [];
      for (const jobId of daemonOwnedJobIds) {
        const status = progressStore.readStatus(jobId);
        if (
          status === null ||
          !isLivePhase(status.phase) ||
          !belongsToNamespace(status, world.namespace) ||
          status.jobKind !== 'kb'
        ) {
          cleanupDaemonJobAbortProxy(jobId);
          continue;
        }
        markJobAsError(
          progressStore,
          status,
          { kind: 'wrapper_crashed', cause: { message } },
          runtime.time.now(),
          (line) => world.log(`${line}\n`),
        );
        cleanupDaemonJobAbortProxy(jobId);
        failed.push(jobId);
      }
      if (failed.length > 0) {
        world.log(`[kb-daemon] marked ${failed.length} daemon-owned KB job(s) as error after daemon exit\n`);
      }
    } catch (error: unknown) {
      world.log(`[kb-daemon] failed to reconcile daemon-owned KB jobs after daemon exit: ${formatError(error)}\n`);
    }
  };
  const registerDaemonJobAbortProxy = (jobId: string): void => {
    cleanupDaemonJobAbortProxy(jobId);
    ensureDaemonJobTerminalListeners();
    const cleanupTimer = runtime.time.setTimeout(() => {
      cleanupDaemonJobAbortProxy(jobId);
    }, KB_DAEMON_JOB_ABORT_PROXY_TTL_MS);
    cleanupTimer.unref?.();
    daemonOwnedKbJobs.set(jobId, { cleanupTimer });
    internalJobAbortRegistry.register(jobId, () => {
      const tracked = daemonOwnedKbJobs.get(jobId);
      if (tracked !== undefined) {
        runtime.time.clearTimeout(tracked.cleanupTimer);
      }
      const abortResult =
        kbDaemonSupervisor.abortKbJobs?.([jobId]) ?? Promise.resolve({ aborted: [], notFound: [jobId] });
      void abortResult.finally(() => {
        cleanupDaemonJobAbortProxy(jobId);
      });
    });
  };
  const trackActiveDaemonKbJobs = async (reason: string, signal?: AbortSignal): Promise<void> => {
    try {
      const activeJobs = (await kbDaemonSupervisor.listActiveKbJobs?.({ signal }))?.active ?? [];
      for (const jobId of activeJobs) {
        registerDaemonJobAbortProxy(jobId);
      }
      if (activeJobs.length > 0) {
        world.log(`[kb-daemon] tracking ${activeJobs.length} active KB job(s) before ${reason}\n`);
      }
    } catch (error: unknown) {
      world.log(`[kb-daemon] failed to list active KB jobs before ${reason}: ${formatError(error)}\n`);
    }
  };
  const kbDaemonSupervisorWithTrackedShutdown: KbDaemonSupervisor = {
    ...kbDaemonSupervisor,
    restart: async (reason) => {
      await trackActiveDaemonKbJobs(reason ?? 'restart');
      return kbDaemonSupervisor.restart(reason);
    },
    dispose: async (reason, disposeOptions) => {
      await trackActiveDaemonKbJobs(reason ?? 'dispose', disposeOptions?.signal);
      return kbDaemonSupervisor.dispose(reason, disposeOptions);
    },
  };
  const disposeKbDaemonExitListener = kbDaemonSupervisor.onExit?.(failTrackedDaemonJobs) ?? (() => {});
  const daemonKbReadPort = createKbDaemonReadPort(kbDaemonSupervisorWithTrackedShutdown);
  const kbRpcPort = createKbDaemonMutationPort(
    daemonKbReadPort,
    kbDaemonSupervisorWithTrackedShutdown,
    recordHostedKbFailure,
    notifyHostedCorpusMutation,
    registerDaemonJobAbortProxy,
    readOnlyInvocationContext,
  );

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
    kb: kbRpcPort,
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
    expansion: createKbDaemonExpansionRpc(kbDaemonSupervisorWithTrackedShutdown),
  };
  const httpHandlerDeps: HttpHandlerPorts = {
    identity,
    time: runtime.time,
    coralEnvSnapshot: world.coralEnvSnapshot,
    ...(world.systemProviderScope === undefined ? {} : { systemProviderScope: world.systemProviderScope }),
    remoteAccess: world.remoteAccess,
    childPrincipals: world.childPrincipalRegistry,
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
      probeKbDaemon: () => kbDaemonSupervisor.probe(),
      restartKbDaemon: (reason) => kbDaemonSupervisorWithTrackedShutdown.restart(reason),
    },
    health: {
      read: () => {
        const env = { ...world.coralEnvSnapshot };
        delete env.CORAL_SYSTEM_PROVIDER_SCOPE;
        const storeServices = storeServicesRef.tryGet();
        const lifecycleState = runtimeState.getLifecycle();
        // Coarse `status` field for clients that validate the strict
        // `'starting' | 'ok' | 'draining'` enum. Consumers that need the full
        // lifecycle read `kernel.phase`.
        let coarseStatus: 'starting' | 'ok' | 'draining';
        if (world.idleTimer.isDraining || lifecycleState === 'draining' || lifecycleState === 'stopped') {
          coarseStatus = 'draining';
        } else if (lifecycleState === 'running' && storeServices !== null) {
          coarseStatus = 'ok';
        } else {
          coarseStatus = 'starting';
        }
        const platform = runtime.env.platform() as NodeJS.Platform;
        const processStartedAt = probeProcessStartedAtSeconds(world.backendPid, platform) ?? undefined;

        // Strip the branded `RuntimeComponentId` to plain string at the wire boundary;
        // transport types use `string` because the brand is enforced producer-side.
        const components = runtimeState.components.list().map((entry) => ({ ...entry, id: entry.id as string }));
        const kbDaemon = kbDaemonSupervisor.read();
        const systemProviderScope = world.systemProviderScope;

        const consumerStuck: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['consumerStuck']> =
          storeServices === null ? [] : (options.getConsumerStuck() ?? []);
        const mutationBlocked = kbDaemon.kbWrite?.mutationBlocked;
        const diagnostics: {
          mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
          consumerStuck?: NonNullable<HealthSnapshot['diagnostics']>['consumerStuck'];
        } = {};
        if (mutationBlocked !== undefined) {
          diagnostics.mutationBlocked = mutationBlocked;
        }
        if (consumerStuck.length > 0) {
          diagnostics.consumerStuck = consumerStuck;
        }
        const hasDiagnostics = diagnostics.mutationBlocked !== undefined || diagnostics.consumerStuck !== undefined;

        return {
          status: coarseStatus,
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
          components,
          kbDaemon,
          ...(hasDiagnostics ? { diagnostics } : {}),
          env,
          ...(systemProviderScope === undefined
            ? {}
            : {
                systemProviderScope: {
                  name: systemProviderScope.name,
                  providers: systemProviderScope.profiles.map((profile) => profile.provider).sort(),
                },
              }),
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
  readIpcOpenSockets = () => ipcServer.sockets.size;

  const server = defaults.createServerFn((req, res) => {
    void handleRequest(req, res).catch((error) => {
      world.log(`Backend request error: ${formatError(error)}\n`);
      if (!res.headersSent) {
        const response = buildTransportErrorResponse(error);
        sendJson(res, response.statusCode, response.body);
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
    ...(world.systemProviderScope === undefined ? {} : { systemProviderScope: world.systemProviderScope }),
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
    kbDaemonSupervisor: kbDaemonSupervisorWithTrackedShutdown,
    disposeLifecycleReactor: () => {
      disposeChildPrincipalTerminalListeners();
      disposeKbDaemonExitListener();
      disposeDaemonJobTerminalListeners();
      options.disposeLifecycleReactor?.();
    },
    handoffQuiescePorts: () =>
      services
        .listExecutionServices()
        .filter(
          (svc): svc is typeof svc & { quiesceAppServerJobsForHandoff: () => Promise<void> } =>
            typeof (svc as { quiesceAppServerJobsForHandoff?: unknown }).quiesceAppServerJobsForHandoff === 'function',
        ),
    createKbHealthComponentFn: () => createKbDaemonHealthComponent(kbDaemonSupervisorWithTrackedShutdown),
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
    ...(world.systemProviderScope === undefined ? {} : { systemProviderScope: world.systemProviderScope }),
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
