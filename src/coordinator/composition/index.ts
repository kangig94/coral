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
import { invocationCoralEnvSnapshot } from '../../infra/env-sanitize.js';
import { formatError } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import { KbJobRecorder, normalizeHostedKbFailureDetail } from '../../jobs/kb/recorder.js';
import { isLivePhase, isTerminalPhase, type JobPhase } from '../../jobs/phase.js';
import type { KbDaemonRequestContextWire } from '../../kb-daemon/protocol.js';
import type { KbToolResult } from '../../kb/result.js';
import { readCorpusState } from '../../kb/state/corpus-state.js';
import { createRecoverySourceRegistry, type RecoveryRetryQuarantinePort } from '../../recovery/source-registry.js';
import { canonicalWorkDirWireSchema } from '../../runtime/canonical-work-dir.js';
import { CoralSetupError } from '../../runtime/errors.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Runtime } from '../../runtime/ports.js';
import { identifyDurableRequest } from '../../runtime/request-lease-identity.js';
import { principalToWire } from '../../security/principal-wire.js';
import type { Principal } from '../../security/principal.js';
import { observeEpochClosure } from '../../store/epoch-closure.js';
import { observeResolvedStoreEpoch } from '../../store/epoch.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import type { TypedEventBus } from '../event-bus.js';
import { type RunStartupRecoveryOrchestratorFn } from '../lifecycle.js';
import { type LaunchCoordinator } from '../live/admission.js';
import { type KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import { createCoordinatorCoreContext } from './core-context.js';
import { createCoordinatorExecutionAssembly, prepareCoordinatorExecutionAssembly } from './execution-assembly.js';
import { createExecutionServices } from './execution-services.js';
import { createKbDaemonJobTracking } from './kb-daemon-job-tracking.js';
import { connectLaunchEvidence } from './launch-evidence.js';
import { createCoordinatorLifecycleAssembly } from './lifecycle-assembly.js';
import { createProviderHostOwners } from './provider-host-owners.js';
import { createProviderProxyContainment } from './provider-proxy-containment.js';
import { createRecoveryAssembly } from './recovery-assembly.js';
import { createCoordinatorRequestPorts } from './request-ports.js';
import { createCoordinatorSuccessionAssembly, createSuccessionJobView } from './succession-assembly.js';
import { createCoordinatorTransportAssembly } from './transport-assembly.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './types.js';

export const MAX_EVENT_STREAM_CONNECTIONS = 100;
export const LAUNCH_PERMIT_REPORT_AGE_MS = 15 * 60 * 1000;
export const MAX_SETTLEMENT_REFUSAL_DIAGNOSTICS = 100;

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

const TERMINAL_DISCUSS_STATUSES = new Set(['ended', 'completed', 'aborted', 'error', 'failed', 'closed']);

/** Every installed listener must be released with the reconciler's lifetime. */
export function subscribeSuccessionObligationChanges(
  eventBus: Pick<TypedEventBus, 'on' | 'off'>,
  launchCoordinator: Pick<LaunchCoordinator, 'subscribeSuccessionObligationChanges'>,
  notify: () => void,
): () => void {
  const onCompleted = (): void => notify();
  const onPhaseChanged = ({ phase }: { phase: JobPhase }): void => {
    if (isTerminalPhase(phase)) notify();
  };
  eventBus.on('job:completed', onCompleted);
  eventBus.on('job:phase_changed', onPhaseChanged);
  const unsubscribeLaunch = launchCoordinator.subscribeSuccessionObligationChanges(notify);
  return () => {
    unsubscribeLaunch();
    eventBus.off('job:completed', onCompleted);
    eventBus.off('job:phase_changed', onPhaseChanged);
  };
}

function isTerminalDiscussStatus(status: string): boolean {
  return TERMINAL_DISCUSS_STATUSES.has(status);
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
    wakeUp: (args, principal, signal) =>
      kbDaemonSupervisor.readKb({ method: 'wakeUp', args, ctx: daemonCtx(principal) }, { signal }),
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
    setCommunitySummary: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb(
        {
          method: 'setCommunitySummary',
          args,
          ctx: daemonCtx(ctx),
        },
        signal,
      );
      return recordAndNotify('community_set_summary', ctx, result, { corpusMutation: true });
    },
    createNote: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createNote', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('promote', ctx, result, { corpusMutation: true });
    },
    updateNote: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'updateNote', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('update', ctx, result, { corpusMutation: true });
    },
    deleteNote: async (slug, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteNote', slug, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('delete', ctx, result, { corpusMutation: true });
    },
    createSource: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createSource', args, ctx: daemonCtx(ctx) }, signal);
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        identifyDurableRequest(signal, { jobId });
        registerDaemonJobAbortProxy(jobId);
      }
      return recordAndNotify('source_import', ctx, result);
    },
    createWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_create', ctx, result, { corpusMutation: true });
    },
    rewriteWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'rewriteWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_rewrite', ctx, result, { corpusMutation: true });
    },
    linkWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'linkWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_link', ctx, result, { corpusMutation: true });
    },
    unlinkWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'unlinkWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_unlink', ctx, result, { corpusMutation: true });
    },
    citeWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'citeWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_cite', ctx, result, { corpusMutation: true });
    },
    adoptWiki: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'adoptWiki', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_adopt', ctx, result, { corpusMutation: true });
    },
    deleteWiki: async (slug, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteWiki', slug, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('wiki_delete', ctx, result, { corpusMutation: true });
    },
    deleteSource: async (slug, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteSource', slug, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('source_delete', ctx, result, { corpusMutation: true });
    },
    createMemo: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'createMemo', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('memo_create', ctx, result);
    },
    deleteMemos: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb({ method: 'deleteMemos', args, ctx: daemonCtx(ctx) }, signal);
      return recordAndNotify('memo_delete', ctx, result);
    },
    reindex: async (args, ctx, signal) => {
      const result = await kbDaemonSupervisor.mutateKb(
        {
          method: 'reindex',
          args,
          ctx: daemonCtx(ctx),
        },
        signal,
      );
      const jobId = readStartedKbJobId(result);
      if (jobId !== null) {
        identifyDurableRequest(signal, { jobId });
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
    signal?: AbortSignal,
  ): Promise<T> => {
    if (principal === undefined) {
      throw new CoralSetupError({
        code: 'invalid_request',
        userMessage: 'Expansion request requires principal context.',
        remediation: "Retry the expansion command. If this persists, run 'coral-cli expansion --help'.",
      });
    }
    const result = await kbDaemonSupervisor.expansionRpc(
      { method, args, ctx: toKbDaemonWireContext(principal) },
      signal,
    );
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
    equipExpansion: (
      request: EquipExpansionRequest,
      principal?: Principal,
      signal?: AbortSignal,
    ): Promise<EquipExpansionResult> => run('equipExpansion', request, principal, signal),
    unequipExpansion: (
      request: UnequipExpansionRequest,
      principal?: Principal,
      signal?: AbortSignal,
    ): Promise<UnequipExpansionResult> => run('unequipExpansion', request, principal, signal),
    removeExpansionCatalog: (
      request: RemoveExpansionCatalogRequest,
      principal?: Principal,
      signal?: AbortSignal,
    ): Promise<RemoveExpansionCatalogResult> => run('removeExpansionCatalog', request, principal, signal),
    listExpansion: (request: ListExpansionRequest, principal?: Principal): Promise<ListExpansionResult> =>
      run('listExpansion', request, principal),
    readBinding: (request: ReadBindingRequest, principal?: Principal): Promise<ReadBindingResult> =>
      run('readBinding', request, principal),
  };
}

/** An undecidable closure cannot finalize a historical job, even when its retained store is readable. */
export function probeHistoricalJobClosure(runtime: Runtime, epochKey: string): 'pending' | 'decided' {
  let lineageKey: string | undefined;
  try {
    lineageKey = observeResolvedStoreEpoch(runtime, epochKey)?.lineageKey;
  } catch {
    return 'pending';
  }
  if (lineageKey === undefined) return 'pending';
  const closure = observeEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, lineageKey);
  return closure.kind === 'recorded' && closure.evidence.disposition === 'closed' ? 'decided' : 'pending';
}

function subscribeChildPrincipalTerminalEvents(core: ReturnType<typeof createCoordinatorCoreContext>): () => void {
  const { world, getProgressStore } = core;
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
  return disposeChildPrincipalTerminalListeners;
}

function createHostedKbAssembly(
  core: ReturnType<typeof createCoordinatorCoreContext>,
  execution: ReturnType<typeof createCoordinatorExecutionAssembly>,
) {
  const {
    runtime,
    world,
    state,
    identity,
    kbDaemonSupervisor,
    getStoreServices,
    getProgressStore,
    createSystemInvocationContext,
  } = core;
  const { internalJobAbortRegistry } = execution;
  const getKbJobRecorder = (): KbJobRecorder => {
    const existing = state.kbJobRecorder;
    if (existing) return existing;
    const created = new KbJobRecorder({
      runtime,
      progressStore: getProgressStore(),
      backendNamespace: world.namespace,
      bundleHash: identity.bundleHash,
      abortRegistry: internalJobAbortRegistry,
    });
    state.kbJobRecorder = created;
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
  const disposeChildPrincipalTerminalListeners = subscribeChildPrincipalTerminalEvents(core);
  const {
    kbDaemonSupervisorWithTrackedShutdown,
    disposeKbDaemonExitListener,
    disposeDaemonJobTerminalListeners,
    registerDaemonJobAbortProxy,
  } = createKbDaemonJobTracking({ runtime, world, kbDaemonSupervisor, getProgressStore, internalJobAbortRegistry });
  const daemonKbReadPort = createKbDaemonReadPort(kbDaemonSupervisorWithTrackedShutdown);
  const kbRpcPort = createKbDaemonMutationPort(
    daemonKbReadPort,
    kbDaemonSupervisorWithTrackedShutdown,
    recordHostedKbFailure,
    notifyHostedCorpusMutation,
    registerDaemonJobAbortProxy,
    readOnlyInvocationContext,
  );

  return {
    getKbJobRecorder,
    readOnlyProjectRoot,
    readOnlyInvocationContext,
    disposeChildPrincipalTerminalListeners,
    kbDaemonSupervisorWithTrackedShutdown,
    disposeKbDaemonExitListener,
    disposeDaemonJobTerminalListeners,
    kbRpcPort,
  };
}

function assembleCoordinatorCoreResult(
  core: ReturnType<typeof createCoordinatorCoreContext>,
  execution: ReturnType<typeof createCoordinatorExecutionAssembly>,
  hostedKb: ReturnType<typeof createHostedKbAssembly>,
  successionAssembly: ReturnType<typeof createCoordinatorSuccessionAssembly>,
  transport: ReturnType<typeof createCoordinatorTransportAssembly>,
  resolvedLifecycleController: ReturnType<typeof createCoordinatorLifecycleAssembly>,
): CoordinatorCoreResult {
  const { runtime, world, state, identity, runtimeState, storeServicesRef } = core;
  const { services, discuss, control } = execution;
  const { getKbJobRecorder } = hostedKb;
  const { succession } = successionAssembly;
  const { handleRequest, server } = transport;
  return {
    identity,
    repairSupervision: async (target) => {
      const decision = await succession.reconciler.repairSupervision({ requestId: runtime.ids.uuid(), target });
      if (decision.kind !== 'registered')
        throw new Error(
          `Supervision repair was not registered: ${decision.kind}: ${'reason' in decision ? decision.reason : ''}`,
        );
    },
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
    openedStoreEpoch: () => state.openedStoreEpoch,
  };
}

export function createCoordinatorCore(
  options: CoordinatorCoreOptions & Readonly<{ onFatalShutdownError: (error: unknown) => void }>,
  runStartupRecovery: RunStartupRecoveryOrchestratorFn,
): CoordinatorCoreResult {
  const core = createCoordinatorCoreContext(options);
  const { runtime, world, getProgressStore, getRecoveryQuarantineStore } = core;
  const recoveryQuarantineStore: RecoveryRetryQuarantinePort = {
    read: (boundary, subjectKey) => getRecoveryQuarantineStore().read(boundary, subjectKey),
    upsert: (write) => getRecoveryQuarantineStore().upsert(write),
    delete: (request) => getRecoveryQuarantineStore().delete(request),
    claimRetry: (request) => getRecoveryQuarantineStore().claimRetry(request),
    reclaimRetry: (request) => getRecoveryQuarantineStore().reclaimRetry(request),
  };
  const recoverySources = createRecoverySourceRegistry();
  const evidence = connectLaunchEvidence(core, MAX_SETTLEMENT_REFUSAL_DIAGNOSTICS);
  const recovery = createRecoveryAssembly({
    core,
    evidence,
    recoverySources,
    recoveryQuarantineStore,
    getDiscuss: () => discuss,
    getCloseProxySetForEpochClosure: () => closeProxySetForEpochClosure,
  });
  const { settlementRefusalRecorder, recoveryQuarantine } = recovery;

  const preparedExecution = prepareCoordinatorExecutionAssembly(core, options);
  const services = createExecutionServices({
    world,
    runtime,
    getActiveEpochPath: () => core.state.selectedStoreEpochPath,
    bundleHash: world.identity.bundleHash,
    backendNamespace: world.namespace,
    settlementRefusalRecorder,
    createExecutionService: preparedExecution.defaults.createExecutionService,
    onProviderProxyLifecycleFatal: preparedExecution.onProviderProxyLifecycleFatal,
    onProviderProxySlotReleased: () => core.state.notifySuccessionObligationChange(),
    onProviderOperationRemoved: () => core.state.notifySuccessionObligationChange(),
  });
  const execution = createCoordinatorExecutionAssembly(core, options, preparedExecution, services);
  const { discuss } = execution;
  const hostedKb = createHostedKbAssembly(core, execution);
  const { readOnlyProjectRoot, readOnlyInvocationContext, kbDaemonSupervisorWithTrackedShutdown, kbRpcPort } = hostedKb;
  const providerHostOwners = createProviderHostOwners(core);
  const { providerHostAdministration } = providerHostOwners;
  const { containProviderProxySet, closeProxySetForEpochClosure } = createProviderProxyContainment({
    world,
    getProgressStore,
  });
  const requestPorts = createCoordinatorRequestPorts({
    core,
    execution,
    readOnlyProjectRoot,
    readOnlyInvocationContext,
    recoveryQuarantine,
    providerHostAdministration,
    containProviderProxySet,
    kbRpcPort,
    expansion: createKbDaemonExpansionRpc(kbDaemonSupervisorWithTrackedShutdown),
    probeHistoricalClosure: (epochKey) => probeHistoricalJobClosure(runtime, epochKey),
  });
  const jobView = createSuccessionJobView(core, providerHostOwners);
  const successionAssembly = createCoordinatorSuccessionAssembly({
    core,
    options,
    execution,
    jobView,
    kbDaemonSupervisorWithTrackedShutdown,
    getIpcServer: () => ipcServer,
    subscribeObligationChanges: (notify) =>
      subscribeSuccessionObligationChanges(world.eventBus, world.launchCoordinator, notify),
    isTerminalDiscussStatus,
  });
  const transport = createCoordinatorTransportAssembly({
    core,
    options,
    execution,
    recovery,
    evidence,
    jobView,
    successionAssembly,
    requestPorts,
    kbDaemonSupervisorWithTrackedShutdown,
    maxEventStreamConnections: MAX_EVENT_STREAM_CONNECTIONS,
    launchPermitReportAgeMs: LAUNCH_PERMIT_REPORT_AGE_MS,
  });
  const { ipcServer } = transport;

  const resolvedLifecycleController = createCoordinatorLifecycleAssembly({
    core,
    options,
    runStartupRecovery,
    execution,
    evidence,
    jobView,
    successionAssembly,
    transport,
    closeProxySetForEpochClosure,
    hostedKb,
  });

  return assembleCoordinatorCoreResult(
    core,
    execution,
    hostedKb,
    successionAssembly,
    transport,
    resolvedLifecycleController,
  );
}
