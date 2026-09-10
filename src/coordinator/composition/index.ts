// Coordinator assembly root — wires HTTP/IPC transports, domain shells,
// services, coordinator lifecycle, and event subscriptions. This file is
// allowed to be large because its single job is composition; that role does
// not turn it into a magnet for unrelated logic.
// What it MUST NOT absorb:
//   - Domain-specific logic (belongs in jobs/, sessions/, discuss/, kb/, ...)
//   - Coordinator global state (belongs in CoordinatorWorld via world.ts)
//   - Default resolution policy (belongs in defaults.ts)
// Adding any of those here turns this file from "orchestrator" into "magnet".

import type { ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ZodError } from 'zod';
import { resolveRunningBundleDir, resolveStrictBundleIdentity } from '../../infra/bundle-manifest.js';
import { assertNever, formatError } from '../../infra/error-format.js';
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
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import {
  providerHostEvictResponseSchema,
  providerHostInspectResponseSchema,
  providerHostListResponseSchema,
  providerProxySetContainBooleanResponseSchema,
  providerProxySetContainResponseSchema,
  unreadableProviderOperationDiscardResultSchema,
  type ProviderProxySetContainBooleanResponse,
  type ProviderProxySetContainRequest,
  type ProviderProxySetContainResponse,
} from '../../transport/rpc/catalog.js';
import type { KbToolResult } from '../../kb/result.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import {
  canonicalizeWorkDir,
  canonicalWorkDirWireSchema,
  type CanonicalWorkDir,
} from '../../runtime/canonical-work-dir.js';
import type { Principal } from '../../security/principal.js';
import { principalToWire } from '../../security/principal-wire.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { subscribeAll } from '../../transport/http/sse-subscribe.js';
import { buildTransportErrorResponse } from '../../transport/error-response.js';
import {
  createCrashedJobTerminalizationRetryPlan,
  createLifecycle,
  createRuntimeState,
  createStaleJobCleanupRetryPlan,
  type LifecycleController,
  type LifecycleDeps,
  type RunStartupRecoveryOrchestratorFn,
} from '../lifecycle.js';
import { createUnreadableProviderOperationDiscardService } from '../services/recovery/unreadable-provider-operation-discard.js';
import { createSettledUnboundStatusPort } from '../services/recovery/settled-unbound-status.js';
import {
  observeProviderOperationRecord,
  providerOperationRecordKeyPrefix,
  readProviderOperations,
} from '../../store/provider-operation-journal.js';
import { createRuntimeComponentRegistry } from '../runtime-components/registry.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './types.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { createCoordinatorControl } from './job-control.js';
import { resolveCoordinatorDefaults } from './defaults.js';
import { createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { createExecutionServices } from './execution-services.js';
import { createCoordinatorWorld, createStartupRecoveryBarrier } from './world.js';
import { admittedByThisCoordinator, classifyLocalCarriers } from './carrier-observation.js';
import { storeServicesStartupNotReadyError } from './store-services-ref.js';
import { isLivePhase, isTerminalPhase } from '../../jobs/phase.js';
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
import { type KbDaemonHealthSnapshot, type KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { ProviderHostAdministrationAuthority, ProviderHostManager } from '../live/provider-hosts/index.js';
import {
  ProviderHostAdministrationService,
  type ProviderHostAdministrationOwner,
} from '../services/provider-host-administration.js';
import type { KbDaemonRequestContextWire } from '../../kb-daemon/protocol.js';
import { createKbDaemonHealthComponent } from '../runtime-components/kb-health-component.js';
import { readCorpusState } from '../../kb/state/corpus-state.js';
import { markJobAsError } from '../../jobs/reconcile/recovery-effects.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type {
  LaunchPermitReclamationDiagnostic,
  LaunchReclamationProbeResult,
  LaunchReleaseDiagnostic,
} from '../../jobs/contracts/admission.js';
import { LAUNCH_RECLAMATION_SWEEP_INTERVAL_MS, MAX_LAUNCH_RELEASE_DIAGNOSTICS } from '../live/admission.js';
import { RecoveryQuarantineStore } from '../../recovery/quarantine.js';
import {
  assertRecoverySourceRegistryComplete,
  COORDINATOR_JOB_RECOVERY_BOUNDARY,
  createRecoveryQuarantineRetryService,
  createRecoverySourceRegistry,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryRetryQuarantinePort,
} from '../../recovery/source-registry.js';
import {
  createCoordinatorJobSettlementRefusalRecorder,
  createCoordinatorJobRecoveryRetryPlan,
  createUnreadableProviderOperationRetryPlan,
} from '../services/recovery/index.js';
import { createDiscussionCandidateRetryPlan, createDiscussionSourceRetryPlan } from '../../discuss/shell/recovery.js';
import {
  createRetentionReleasePairRetryPlan,
  createRetentionWorkRetryPlan,
  createSessionContinuationLeaseRetryPlan,
  createSessionProjectionRetryPlan,
  createTerminalRetentionOutcomeRetryPlan,
} from '../../sessions/lifecycle-reactor.js';
import { createWorkflowRecoveryRetryPlan } from '../../workflow/recover.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import type { ProviderProxySetBooleanOperatorExitResult } from '../services/provider-proxy-set/index.js';

export const MAX_EVENT_STREAM_CONNECTIONS = 100;
export const LAUNCH_PERMIT_REPORT_AGE_MS = 15 * 60 * 1000;
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

type ProviderProxySetContainSuccess = Extract<ProviderProxySetContainResponse, { kind: 'contained' | 'abandoned' }>;
type ProviderProxySetContainBooleanSuccess = Extract<
  ProviderProxySetContainBooleanResponse,
  { kind: 'contained' | 'abandoned' | 'unattributable-group-abandoned' }
>;

function providerProxySetContainBooleanClaimDischarge(
  discharge: ProviderProxySetContainSuccess['claimDischarge'],
): ProviderProxySetContainBooleanSuccess['claimDischarge'] {
  switch (discharge.kind) {
    case 'completed':
      return discharge;
    case 'initial-disposition-pending':
      return { kind: 'initial-disposition-retry-owned' };
    case 'operational-retry-owned':
      return { kind: discharge.kind, incidents: discharge.incidents };
    default:
      return assertNever(discharge);
  }
}

function providerProxySetContainBooleanResponse(
  response: ProviderProxySetBooleanOperatorExitResult,
): ProviderProxySetContainBooleanResponse {
  if (response.kind === 'contained') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'unattributable-group-abandoned') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'abandoned') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'not-held' && response.state === 'reattachment-hold') {
    return providerProxySetContainBooleanResponseSchema.parse({ ...response, state: 'reattaching' });
  }
  return providerProxySetContainBooleanResponseSchema.parse(response);
}

function isTerminalDiscussStatus(status: string): boolean {
  return TERMINAL_DISCUSS_STATUSES.has(status);
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
      // No 'kb_disabled' case: every producer of that code (createDisabledKbDaemonSupervisor) already sets
      // its own `result.remediation`, so `result.remediation ?? errorRemediation(result.code)` never reaches
      // this function with that code. A case here would be dead and would drift from the real remediation.
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

export function createCoordinatorCore(
  options: CoordinatorCoreOptions,
  runStartupRecovery: RunStartupRecoveryOrchestratorFn,
): CoordinatorCoreResult {
  const runtime = options.runtime;

  const defaultsPlan = resolveCoordinatorDefaults(options, runtime);
  const startupRecoveryBarrier = createStartupRecoveryBarrier();
  const world = createCoordinatorWorld(options, runtime, defaultsPlan, startupRecoveryBarrier.read);
  const components = createRuntimeComponentRegistry();
  const runtimeState = createRuntimeState(world.now(), components);
  const kbDaemonSupervisor = options.kbDaemonSupervisor;
  const identity = world.identity;
  const strictHealthIdentity = resolveStrictBundleIdentity();
  const strictHealthBundleDir = strictHealthIdentity.ok ? resolveRunningBundleDir(world.pluginRoot) : null;
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
  const getRecoveryQuarantineStore = () => new RecoveryQuarantineStore(getProgressStore().getDb(), runtime.time);
  const recoveryQuarantineStore: RecoveryRetryQuarantinePort = {
    read: (boundary, subjectKey) => getRecoveryQuarantineStore().read(boundary, subjectKey),
    upsert: (write) => getRecoveryQuarantineStore().upsert(write),
    delete: (request) => getRecoveryQuarantineStore().delete(request),
    claimRetry: (request) => getRecoveryQuarantineStore().claimRetry(request),
    reclaimRetry: (request) => getRecoveryQuarantineStore().reclaimRetry(request),
  };
  const recoverySources = createRecoverySourceRegistry();
  const recoveryDb = () => getProgressStore().getDb();
  world.launchCoordinator.connectSettledUnboundStatus(createSettledUnboundStatusPort(recoveryDb, runtime.time));
  world.launchCoordinator.connectProviderOperationBindingJournal((identity) => {
    try {
      const scan = readProviderOperations(recoveryDb());
      if (
        scan.records.some(
          (record) =>
            record.operation.jobId === identity.jobId && record.operation.operationId === identity.operationId,
        )
      ) {
        return { kind: 'present' };
      }
      const keyPrefix = `${providerOperationRecordKeyPrefix(identity.jobId)}${identity.operationId}:`;
      return scan.unreadableKeys.some((key) => key.startsWith(keyPrefix)) ? { kind: 'present' } : { kind: 'absent' };
    } catch (error: unknown) {
      return { kind: 'unknown', reason: formatError(error) };
    }
  });
  const readJobReclamation = (jobId: string): LaunchReclamationProbeResult<'local-execution'> => {
    const status = getProgressStore().readStatus(jobId);
    if (status === null) return { kind: 'job-absent' };
    return isTerminalPhase(status.phase) ? { kind: 'job-terminal', phase: status.phase } : { kind: 'job-live' };
  };
  world.launchCoordinator.connectLaunchReclamationOracle('local-execution', (permit) =>
    readJobReclamation(permit.jobId),
  );
  world.launchCoordinator.connectLaunchReclamationOracle('recovery', (permit) => readJobReclamation(permit.jobId));
  world.launchCoordinator.connectLaunchReclamationOracle('proxy-operation', (permit) => {
    const evidence = readJobReclamation(permit.jobId);
    if (evidence.kind === 'job-live') return evidence;
    const scan = readProviderOperations(recoveryDb());
    if (
      scan.records.some(
        (record) =>
          record.operation.jobId === permit.jobId && record.operation.operationId === permit.holder.operationId,
      )
    ) {
      return { kind: 'job-live' };
    }
    const keyPrefix = `${providerOperationRecordKeyPrefix(permit.jobId)}${permit.holder.operationId}:`;
    return scan.unreadableKeys.some((key) => key.startsWith(keyPrefix))
      ? { kind: 'job-live' }
      : {
          kind: 'provider-operation-absent',
          operationId: permit.holder.operationId,
          jobEvidence: evidence,
        };
  });
  world.launchCoordinator.connectLaunchReclamationOracle('undecided-provider-operation', (permit) => {
    const evidence = readJobReclamation(permit.jobId);
    if (evidence.kind === 'job-live') return evidence;
    return permit.holder.recordKeys.some((key) => observeProviderOperationRecord(recoveryDb(), key).kind !== 'absent')
      ? { kind: 'job-live' }
      : {
          kind: 'provider-operation-records-absent',
          recordKeys: permit.holder.recordKeys,
          jobEvidence: evidence,
        };
  });
  const launchReclamationTimer = runtime.time.setInterval(() => {
    try {
      world.launchCoordinator.sweepStaleLaunchPermits();
    } catch {
      // A maintenance timer must not terminate a coordinator that booted successfully.
    }
  }, LAUNCH_RECLAMATION_SWEEP_INTERVAL_MS);
  launchReclamationTimer.unref?.();
  let adoptRepairedProviderOperation: ReturnType<
    typeof createExecutionServices
  >['adoptRepairedProviderOperation'] = async () => ({
    kind: 'refused',
    reason: 'the coordinator execution services are not composed',
  });
  let releaseUnreadableProviderOperationStartupOwnership: ReturnType<
    typeof createExecutionServices
  >['releaseUnreadableProviderOperationStartupOwnership'] = async () => ({
    kind: 'completed',
    releasedLaunchPermits: 0,
  });
  const createSystemInvocationContext = (
    projectRoot: CanonicalWorkDir,
    credentialId: string,
    coralEnv: Record<string, string> = {},
  ): InvocationContext => ({
    projectRoot,
    pluginRoot: identity.pluginRoot,
    coralEnv,
    principal: {
      subject: 'system',
      transport: 'internal',
      credential: { kind: 'internal', id: credentialId },
      binding: { kind: 'project', root: projectRoot },
    },
  });
  const createRecoveryInvocationContext = (rawProjectRoot: string): InvocationContext => {
    const projectRoot = canonicalizeWorkDir(rawProjectRoot, runtime.env.cwd());
    return createSystemInvocationContext(projectRoot, 'recovery-retry');
  };
  recoverySources.register(COORDINATOR_JOB_RECOVERY_BOUNDARY, (subject, signal, quarantine) =>
    createCoordinatorJobRecoveryRetryPlan(recoveryDb(), subject, signal, quarantine),
  );
  recoverySources.register('discussion-source', (subject, signal) =>
    createDiscussionSourceRetryPlan(
      {
        getDiscussContext: discuss.getDiscussContext,
        createInvocationContext: createRecoveryInvocationContext,
        signal,
      },
      subject,
    ),
  );
  recoverySources.register('discussion-candidate', (subject, signal, quarantine) =>
    createDiscussionCandidateRetryPlan(
      {
        getDiscussContext: discuss.getDiscussContext,
        createInvocationContext: createRecoveryInvocationContext,
        signal,
      },
      subject,
      quarantine,
    ),
  );
  recoverySources.register('session-projection', (subject, _signal, quarantine) =>
    createSessionProjectionRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('session-continuation-lease', (subject, _signal, quarantine) =>
    createSessionContinuationLeaseRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('terminal-retention-outcome', (subject, _signal, quarantine) =>
    createTerminalRetentionOutcomeRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('retention-release-pair', (subject, _signal, quarantine) =>
    createRetentionReleasePairRetryPlan(recoveryDb(), subject, quarantine),
  );
  recoverySources.register('session-retention-work', (subject, signal, quarantine) =>
    createRetentionWorkRetryPlan(recoveryDb(), subject, signal, quarantine),
  );
  recoverySources.register('workflow-recovery', (subject) => createWorkflowRecoveryRetryPlan(recoveryDb(), subject));
  recoverySources.register('stale-job-cleanup', (subject) => createStaleJobCleanupRetryPlan(recoveryDb(), subject));
  recoverySources.register('crashed-job-terminalization', (subject) =>
    createCrashedJobTerminalizationRetryPlan(recoveryDb(), subject),
  );
  recoverySources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
    createUnreadableProviderOperationRetryPlan(recoveryDb(), subject, adoptRepairedProviderOperation),
  );
  assertRecoverySourceRegistryComplete(recoverySources);
  const settlementRefusalRecordingFailures = new Map<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']>[number]
  >();
  const providerOperationAdoptionRefusals = new Map<
    string,
    NonNullable<NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']>[number]
  >();
  const durableSettlementRefusalRecorder = createCoordinatorJobSettlementRefusalRecorder({
    getDb: recoveryDb,
    isBoundaryRegistered: (boundary) => recoverySources.has(boundary),
    upsert: (write) => getRecoveryQuarantineStore().upsert(write),
  });
  const settlementRefusalRecorder = {
    async record(input: Parameters<typeof durableSettlementRefusalRecorder.record>[0]): Promise<boolean> {
      try {
        const recorded = await durableSettlementRefusalRecorder.record(input);
        if (recorded) {
          settlementRefusalRecordingFailures.delete(input.jobId);
          return true;
        }
        settlementRefusalRecordingFailures.set(input.jobId, {
          jobId: input.jobId,
          cause: input.cause,
          error: 'The recovery quarantine write did not persist.',
          observedAtMs: runtime.time.now(),
        });
        return false;
      } catch (error: unknown) {
        settlementRefusalRecordingFailures.set(input.jobId, {
          jobId: input.jobId,
          cause: input.cause,
          error: formatError(error),
          observedAtMs: runtime.time.now(),
        });
        throw error;
      }
    },
  };
  const recoveryQuarantineRetry = createRecoveryQuarantineRetryService({
    instanceId: world.identity.instanceId,
    ids: runtime.ids,
    quarantine: recoveryQuarantineStore,
    sources: recoverySources,
  });
  const recoveryQuarantine: RpcPorts['recoveryQuarantine'] = {
    clear: (request, signal) => recoveryQuarantineRetry.clear(request, signal),
    discardProviderOperation: async (request) => {
      if (runtimeState.getLaunchFenceActive()) {
        return unreadableProviderOperationDiscardResultSchema.parse({
          ...request,
          kind: 'recovery-in-progress',
          code: 'backend_recovering',
          message: 'Provider-operation discard is unavailable while startup recovery owns the launch fence.',
          remediation: 'Wait for startup recovery to finish, then run this command again.',
        });
      }
      const discard = createUnreadableProviderOperationDiscardService({
        instanceId: world.identity.instanceId,
        ids: runtime.ids,
        db: recoveryDb(),
        time: runtime.time,
      });
      const result = unreadableProviderOperationDiscardResultSchema.parse(discard.discard(request));
      if (result.kind === 'discarded' || result.kind === 'absent') {
        const ownership = await releaseUnreadableProviderOperationStartupOwnership(result.key);
        if (ownership.kind === 'adoption-refused') {
          const observedAtMs = runtime.time.now();
          for (const refusal of ownership.refusals) {
            providerOperationAdoptionRefusals.delete(refusal.recordKey);
            providerOperationAdoptionRefusals.set(refusal.recordKey, {
              triggerRecordKey: result.key,
              rowDisposition: result.kind,
              releasedLaunchPermits: ownership.releasedLaunchPermits,
              ...refusal,
              observedAtMs,
            });
            if (providerOperationAdoptionRefusals.size > MAX_LAUNCH_RELEASE_DIAGNOSTICS) {
              const oldestRecordKey = providerOperationAdoptionRefusals.keys().next().value;
              if (oldestRecordKey !== undefined) providerOperationAdoptionRefusals.delete(oldestRecordKey);
            }
          }
          return unreadableProviderOperationDiscardResultSchema.parse({
            ...result,
            kind: 'adoption-refused',
            rowDisposition: result.kind,
            releasedLaunchPermits: ownership.releasedLaunchPermits,
            refusals: ownership.refusals,
          });
        }
      }
      return result;
    },
  };

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
  const streamResponses = new Set<ServerResponse>();
  const eventStreamSubscriptions = new WeakMap<EventStreamHandlers, () => void>();
  let readIpcOpenSockets = () => 0;
  let lifecycleController: LifecycleController | null = null;
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: world.identity.bundleHash,
    backendNamespace: world.namespace,
    settlementRefusalRecorder,
    createExecutionService: defaults.createExecutionService,
    onProviderProxyLifecycleFatal: (error) => {
      world.log(`Fatal provider proxy lifecycle error: ${formatError(error)}\n`);
      void lifecycleController?.shutdown('provider-proxy-lifecycle-fatal').catch(() => undefined);
    },
  });
  adoptRepairedProviderOperation = services.adoptRepairedProviderOperation;
  releaseUnreadableProviderOperationStartupOwnership = services.releaseUnreadableProviderOperationStartupOwnership;

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
    getLifecycleController: () => lifecycleController,
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

  const readOnlyProjectRoot = canonicalWorkDirWireSchema.parse(runtime.env.cwd());
  const readOnlyInvocationContext = createSystemInvocationContext(
    readOnlyProjectRoot,
    'coordinator-readonly',
    invocationCoralEnvSnapshot(world.coralEnvSnapshot),
  );
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
    if (!status || status.sessionId !== sessionId || !isLivePhase(status.phase)) {
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
      const snapshot = readCorpusState(storeServices.storeDb);
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
  const onLaunchReclamationJobPhaseChanged = (): void => {
    try {
      if (world.launchCoordinator.active > 0 && getProgressStore().liveJobCount() === 0) {
        world.launchCoordinator.sweepStaleLaunchPermits();
      }
    } catch {
      // An unreadable liveness view cannot authorize reclamation or escape an event callback.
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
  world.eventBus.on('job:phase_changed', onLaunchReclamationJobPhaseChanged);
  world.eventBus.on('job:completed', onChildPrincipalJobCompleted);
  world.eventBus.on('discuss:updated', onChildPrincipalDiscussUpdated);
  const disposeChildPrincipalTerminalListeners = (): void => {
    world.eventBus.off('job:phase_changed', onChildPrincipalJobPhaseChanged);
    world.eventBus.off('job:phase_changed', onLaunchReclamationJobPhaseChanged);
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
      if (status === null || !isLivePhase(status.phase) || status.jobKind !== 'kb') {
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
        if (status === null || !isLivePhase(status.phase) || status.jobKind !== 'kb') {
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

  const localProviderHosts = world.providerHostManager as ProviderHostManager &
    Partial<ProviderHostAdministrationAuthority>;
  const localProviderHostOwner: ProviderHostAdministrationOwner = {
    ownerId: `coordinator:${world.identity.instanceId}`,
    listProviderHosts: () => {
      if (localProviderHosts.listProviderHosts === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.listProviderHosts();
    },
    inspectProviderHost: (hostRef) => {
      if (localProviderHosts.inspectProviderHost === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.inspectProviderHost(hostRef);
    },
    terminalEviction: (hostRef) => {
      if (localProviderHosts.terminalEviction === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.terminalEviction(hostRef);
    },
    evictProviderHost: async (hostRef) => {
      if (localProviderHosts.evictHost === undefined) {
        throw new Error('provider_host_inventory_unavailable: local manager has no administration authority');
      }
      return localProviderHosts.evictHost(hostRef);
    },
  };
  const providerHostAdministration = new ProviderHostAdministrationService({
    owners: () => {
      const proxySets = world.providerProxyAuthority?.liveSets() ?? [];
      return [
        localProviderHostOwner,
        ...proxySets.map(
          (set): ProviderHostAdministrationOwner => ({
            ownerId: `provider-proxy:${set.proxyInstanceId}`,
            listProviderHosts: async () => {
              if (set.providerHosts === undefined) {
                throw new Error('provider_host_inventory_unavailable: proxy set has no administration control');
              }
              return set.providerHosts.list();
            },
            inspectProviderHost: async (hostRef) => {
              if (set.providerHosts === undefined) {
                throw new Error('provider_host_inventory_unavailable: proxy set has no administration control');
              }
              return set.providerHosts.inspect(hostRef);
            },
            terminalEviction: async (hostRef) => {
              if (set.providerHosts === undefined) {
                throw new Error('provider_host_inventory_unavailable: proxy set has no administration control');
              }
              return set.providerHosts.terminalEviction(hostRef);
            },
            evictProviderHost: async (hostRef) => {
              if (set.providerHosts === undefined) {
                throw new Error('provider_host_inventory_unavailable: proxy set has no administration control');
              }
              return set.providerHosts.evict(hostRef);
            },
          }),
        ),
      ];
    },
  });

  const containProviderProxySet = async (
    request: ProviderProxySetContainRequest,
    contract: 'current' | 'boolean',
    abandonWithoutAbsence: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderProxySetBooleanOperatorExitResult | Readonly<{ kind: 'unsupported-contract' }>> => {
    const lifecycle = world.providerProxyLifecycleRef.get();
    if (lifecycle === null) throw new Error('provider_proxy_set_operator_exit_unavailable');
    const authorization =
      contract === 'boolean'
        ? lifecycle.authorizeBooleanOperatorExit(request.setIdentity)
        : lifecycle.authorizeOperatorExit(request.setIdentity);
    if (authorization.kind === 'unsupported-contract') return authorization;
    if (authorization.kind !== 'authorized') {
      if (contract === 'current' && authorization.kind === 'set-not-found' && abandonWithoutAbsence) {
        const abandonment = lifecycle.abandonDurableAcquisition(request.setIdentity);
        if (abandonment.kind === 'retired') {
          return {
            kind: 'representation-release-abandoned',
            setIdentity: request.setIdentity,
            successor: { owner: 'operator-command', acceptance: 'accepted' },
            effect: {
              signalsSent: [],
              containmentAbsent: false,
              representationAction: 'fatal-release-abandoned',
            },
          };
        }
        if (abandonment.kind === 'held') {
          return {
            kind: 'store-unreadable',
            setIdentity: request.setIdentity,
            effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
          };
        }
        if (abandonment.kind === 'transfer-pending') {
          return {
            kind: 'containment-unconfirmed',
            setIdentity: request.setIdentity,
            recoveryAction: { kind: 'retry-exact-set-containment' },
            effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
          };
        }
      }
      return {
        ...authorization,
        setIdentity: request.setIdentity,
        effect: { signalsSent: [], containmentAbsent: false, representationAction: 'none' },
      };
    }
    const proof = await world.providerProxySetContainmentProver.collectContainmentProof(
      authorization.capability.containmentProofAuthorization,
      getProgressStore().getDb(),
      signal ?? new AbortController().signal,
    );
    return contract === 'boolean'
      ? lifecycle.completeBooleanOperatorExit(authorization.capability, proof, abandonWithoutAbsence, signal)
      : lifecycle.completeOperatorExit(authorization.capability, proof, abandonWithoutAbsence, signal);
  };

  const rpcPorts: RpcPorts = {
    sessions: {
      start: (providerName, input, ctx) => services.getExecutionService(ctx).start(providerName, input, ctx),
    },
    jobs: {
      scopeCheck: control.scopeCheckJobs,
      abort: control.abortJobs,
      waitStream: (request) =>
        services
          .getExecutionService(
            createSystemInvocationContext(
              request.projectRoot === undefined
                ? readOnlyProjectRoot
                : canonicalWorkDirWireSchema.parse(request.projectRoot),
              'coordinator-readonly',
              readOnlyInvocationContext.coralEnv,
            ),
          )
          .waitStream(request),
      list: (filters) => {
        const progressStore = getProgressStore();
        const jobs: ReturnType<typeof progressStore.listJobProjections> = [];
        for (const entry of progressStore.listJobProjections()) {
          if (filters.all !== true && !isLivePhase(entry.status.phase)) {
            continue;
          }
          if (filters.projectRoot !== undefined && !jobInCallerScope(entry.status, filters.projectRoot, 'exact')) {
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
        if (!status) {
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
    recoveryQuarantine,
    providerHosts: {
      list: async () => providerHostListResponseSchema.parse({ hosts: await providerHostAdministration.list() }),
      inspect: async (selector) =>
        providerHostInspectResponseSchema.parse({
          host: await providerHostAdministration.inspect(selector),
        }),
      evict: async (selector) =>
        providerHostEvictResponseSchema.parse(await providerHostAdministration.evict(selector)),
    },
    providerProxySets: {
      contain: async (request, signal) =>
        providerProxySetContainResponseSchema.parse(
          await containProviderProxySet(request, 'current', request.mode === 'abandon', signal),
        ),
      containBoolean: async (request, signal) => {
        const result = await containProviderProxySet(
          { setIdentity: request.setIdentity, mode: 'contain' },
          'boolean',
          request.abandonWithoutAbsence,
          signal,
        );
        return result.kind === 'unsupported-contract' ? result : providerProxySetContainBooleanResponse(result);
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
  /**
   * This process's own incarnation, probed until it is known and then never again.
   *
   * It was probed per health response, and a health response is the most frequently served thing this daemon
   * does. On macOS the probe is two synchronous `execFileSync` calls — `sysctl` and `ps` — so every reader
   * asking whether the coordinator is up forked twice and blocked the loop that was supposed to answer.
   *
   * Remembering a *success* carries no staleness question: an incarnation names the process that holds it,
   * `world.backendPid` is this process, and nothing can change it while there is anyone left to read it.
   *
   * Remembering a *failure* is a different thing entirely, and reading it exactly once got that wrong. The
   * discovery record runs its own probe (`infra/backend-discovery.ts`), so one transient failure here while
   * that one succeeded leaves discovery publishing an incarnation and health publishing none — and
   * `discoveryMatchesHealth` (`coordinator/handoff-routing/runner.ts`) compares the two for equality. A single
   * unlucky read at composition would have made every later takeover fail identity for the life of the
   * daemon, with no path back. So `null` is retried, and only success is kept.
   */
  let rememberedSelfIncarnation: ProcessIncarnation | null = null;
  const readSelfIncarnation = (): ProcessIncarnation | undefined => {
    rememberedSelfIncarnation ??= runtime.process.readProcessIncarnation(
      world.backendPid,
      runtime.env.platform() as NodeJS.Platform,
    );
    return rememberedSelfIncarnation ?? undefined;
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
        const incarnation = readSelfIncarnation();

        // Strip the branded `RuntimeComponentId` to plain string at the wire boundary;
        // transport types use `string` because the brand is enforced producer-side.
        const components = runtimeState.components.list().map((entry) => ({ ...entry, id: entry.id as string }));
        const kbDaemon = kbDaemonSupervisor.read();
        const systemProviderScope = world.systemProviderScope;

        let activeJobs = 0;
        let carrierLivenessByJobId = new Map<string, 'live' | 'absent' | 'unknown'>();
        let carrierDiagnostics: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['carriers']>;
        if (storeServices === null) {
          carrierDiagnostics = {
            coverage: 'unknown',
            liveJobs: 0,
            unknownJobs: activeJobs,
            recoveryDefectJobs: 0,
          };
        } else {
          const progressStore = storeServices.progressStore;
          try {
            const jobIds = progressStore.listStoredNonterminalJobIds();
            const observedMaxJournalSeq =
              progressStore
                .getDb()
                .prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
                .get()?.seq ?? 0;
            const observations = classifyLocalCarriers(
              jobIds,
              {
                getDb: () => progressStore.getDb(),
                loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
                platform,
                hasStartupRecoveryPassed: () => world.startupRecoveryBarrier.hasPassed(),
                isAdmittedByThisCoordinator: (jobId) => admittedByThisCoordinator(world.launchCoordinator, jobId),
                registryStateForJob: (jobId) => world.operationRegistry.stateForJob(jobId),
              },
              observedMaxJournalSeq,
            );
            if (
              observations.length !== jobIds.length ||
              observations.some(({ observation }) => !isLivePhase(observation.storedPhase))
            ) {
              throw new Error('carrier_health_projection_mapping_incomplete');
            }
            const liveJobs = observations.filter(({ observation }) => observation.liveness === 'live').length;
            const unknownJobs = observations.filter(({ observation }) => observation.liveness === 'unknown').length;
            const recoveryDefectJobs = observations.filter(
              ({ observation }) => observation.defect === 'local-unknown-after-recovery-decision',
            ).length;
            carrierLivenessByJobId = new Map(
              observations.map(({ jobId, observation }) => [jobId, observation.liveness]),
            );
            activeJobs = liveJobs + unknownJobs;
            carrierDiagnostics = { coverage: 'complete', liveJobs, unknownJobs, recoveryDefectJobs };
          } catch {
            try {
              activeJobs = progressStore.liveJobCount();
            } catch {
              activeJobs = 0;
            }
            carrierDiagnostics = {
              coverage: 'unknown',
              liveJobs: 0,
              unknownJobs: activeJobs,
              recoveryDefectJobs: 0,
            };
          }
        }

        const consumerStuck: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['consumerStuck']> =
          storeServices === null ? [] : (options.getConsumerStuck() ?? []);
        const mutationBlocked = kbDaemon.kbWrite?.mutationBlocked;
        const diagnostics: {
          carriers?: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['carriers']>;
          mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
          consumerStuck?: NonNullable<HealthSnapshot['diagnostics']>['consumerStuck'];
          providerProxySets?: NonNullable<HealthSnapshot['diagnostics']>['providerProxySets'];
          providerProxyDispositionSkips?: NonNullable<
            NonNullable<HealthSnapshot['diagnostics']>['providerProxyDispositionSkips']
          >;
          settlementRefusalRecordingFailures?: NonNullable<
            NonNullable<HealthSnapshot['diagnostics']>['settlementRefusalRecordingFailures']
          >;
          providerOperationAdoptionRefusals?: NonNullable<
            NonNullable<HealthSnapshot['diagnostics']>['providerOperationAdoptionRefusals']
          >;
          launchPermits?: NonNullable<NonNullable<HealthSnapshot['diagnostics']>['launchPermits']>;
          launchReleaseDispositions?: LaunchReleaseDiagnostic[];
          launchReclamations?: LaunchPermitReclamationDiagnostic[];
        } = { carriers: carrierDiagnostics };
        if (mutationBlocked !== undefined) {
          diagnostics.mutationBlocked = mutationBlocked;
        }
        if (consumerStuck.length > 0) {
          diagnostics.consumerStuck = consumerStuck;
        }
        const providerProxySnapshot = world.providerProxyLifecycleRef.get()?.snapshot();
        const providerProxySets = [...(providerProxySnapshot?.operatorSets ?? [])] satisfies NonNullable<
          NonNullable<HealthSnapshot['diagnostics']>['providerProxySets']
        >;
        if (providerProxySets.length > 0) {
          diagnostics.providerProxySets = providerProxySets;
        }
        const providerProxyDispositionSkips = providerProxySnapshot?.skippedDurableOperatorDispositions ?? [];
        if (providerProxyDispositionSkips.length > 0) {
          diagnostics.providerProxyDispositionSkips = [...providerProxyDispositionSkips];
        }
        if (settlementRefusalRecordingFailures.size > 0) {
          diagnostics.settlementRefusalRecordingFailures = [...settlementRefusalRecordingFailures.values()];
        }
        if (providerOperationAdoptionRefusals.size > 0) {
          diagnostics.providerOperationAdoptionRefusals = [...providerOperationAdoptionRefusals.values()];
        }
        const launchPermits = world.launchCoordinator
          .activeLaunchPermits()
          .filter(
            ({ jobId, heldForMs }) =>
              heldForMs > LAUNCH_PERMIT_REPORT_AGE_MS || carrierLivenessByJobId.get(jobId) !== 'live',
          );
        if (launchPermits.length > 0) {
          diagnostics.launchPermits = launchPermits;
        }
        const launchReleaseDispositions = world.launchCoordinator.launchReleaseDiagnostics();
        if (launchReleaseDispositions.length > 0) {
          diagnostics.launchReleaseDispositions = launchReleaseDispositions;
        }
        const launchReclamations = world.launchCoordinator.launchReclamationDiagnostics();
        if (launchReclamations.length > 0) {
          diagnostics.launchReclamations = launchReclamations;
        }
        const hasDiagnostics =
          diagnostics.carriers !== undefined ||
          diagnostics.mutationBlocked !== undefined ||
          diagnostics.consumerStuck !== undefined ||
          diagnostics.providerProxySets !== undefined ||
          diagnostics.providerProxyDispositionSkips !== undefined ||
          diagnostics.settlementRefusalRecordingFailures !== undefined ||
          diagnostics.providerOperationAdoptionRefusals !== undefined ||
          diagnostics.launchPermits !== undefined ||
          diagnostics.launchReleaseDispositions !== undefined ||
          diagnostics.launchReclamations !== undefined;

        return {
          status: coarseStatus,
          kernel: {
            phase: lifecycleState,
            readyAt: lifecycleState === 'starting' ? null : runtimeState.getStartedAt(),
          },
          version: identity.version,
          bundleHash: identity.bundleHash,
          ...(strictHealthIdentity.ok && strictHealthBundleDir !== null
            ? { manifest: strictHealthIdentity.manifest, bundleDir: strictHealthBundleDir }
            : {}),
          flavor: identity.flavor,
          namespace: identity.namespace,
          instanceId: identity.instanceId,
          pid: world.backendPid,
          ...(incarnation !== undefined ? { incarnation } : {}),
          uptimeMs: identity.now() - runtimeState.getStartedAt(),
          active: world.launchCoordinator.active,
          activeJobs,
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
    storeFormat: options.storeFormat,
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
    connectProviderOperationRecovery: services.connectProviderOperationRecovery,
    reconcileProviderOperationsAtStartup: services.reconcileProviderOperationsAtStartup,
    startProviderOperationReconciler: services.startProviderOperationReconciler,
    stopProviderOperationReconciler: services.stopProviderOperationReconciler,
    startupRecoveryBarrierPublisher: startupRecoveryBarrier.publication,
    getDiscussStoreForSource: discuss.getDiscussStoreForSource,
    knownDiscussSources: () => knownDiscussSources(discuss.readHelpersDeps),
    getDiscussContext: discuss.getDiscussContext,
    writeBackendInfoFn: defaults.writeBackendInfoFn,
    removeBackendInfoIfOwnerFn: defaults.removeBackendInfoIfOwnerFn,
    cleanupStaleJobsFn: defaults.cleanupStaleJobsFn,
    markJobsAsErrorFn: defaults.markJobsAsErrorFn,
    terminateAllFn: defaults.terminateAllFn,
    providerHostManager: world.providerHostManager,
    ...(world.providerProxyAuthority === undefined ? {} : { providerProxyAuthority: world.providerProxyAuthority }),
    kbDaemonSupervisor: kbDaemonSupervisorWithTrackedShutdown,
    disposeLifecycleReactor: async () => {
      runtime.time.clearInterval(launchReclamationTimer);
      disposeChildPrincipalTerminalListeners();
      disposeKbDaemonExitListener();
      disposeDaemonJobTerminalListeners();
      await options.disposeLifecycleReactor?.();
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
    hooks: discuss.hooks,
    closeServerFn: defaults.closeServerFn,
    listenFn: defaults.listenFn,
    ipcServer,
    closeIpcServerFn: closeIpcServer,
    listenIpcFn:
      options.listenIpcFn ??
      ((listener, additionalCompatibilitySocketPaths = [], publishedCompatibilitySocketAddresses = []) =>
        listenIpcServer(
          listener,
          runtime.paths.coral.coordinator.socketPath,
          additionalCompatibilitySocketPaths,
          publishedCompatibilitySocketAddresses,
        )),
    onStopped: options.onStopped,
    ...(options.acceptProcessExitRemainder === undefined
      ? {}
      : { acceptProcessExitRemainder: options.acceptProcessExitRemainder }),
    onFatalShutdownError: options.onFatalShutdownError,
  };

  lifecycleController = createLifecycle(lifecycleDeps, runStartupRecovery);
  const resolvedLifecycleController = lifecycleController;
  // A starting incumbent must accept explicit shutdown before its idle watcher exists.
  ipcServer.onShutdownRequest = (reason) => {
    void resolvedLifecycleController.shutdown(reason).catch(() => {});
  };
  ipcServer.onShutdownObligationAbandonment = (request) =>
    resolvedLifecycleController.abandonShutdownObligation(request);
  ipcServer.onShutdownRecoveryAccepted = () => {
    resolvedLifecycleController.requestShutdownRetry();
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
