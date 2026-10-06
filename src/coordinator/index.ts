import type { ProgressSource } from '../jobs/wait/contract.js';
import { visitJobProgress } from '../jobs/read-queries.js';
import { renderWorkflowReport } from '../workflow/result-report.js';
import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { providerLookupPortFromCatalog } from '../providers/catalog.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime, RuntimeObserver } from '../runtime/ports.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { nowDate } from '../infra/time.js';
import { backendLog } from '../infra/backend-log.js';
import { CORAL_KB_ENABLE_ENV, KB_DISABLED_REASON, resolveKbEnabled } from '../infra/kb-toggle.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './spawn-observer.js';
import { createCoordinatorCore } from './composition/index.js';
import { createCoordinatorProviderHostAdmission } from './live/provider-host-admission.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './composition/types.js';
import type { ShutdownReason } from '../infra/shutdown-contract.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';
import {
  isLifecycleShutdownTerminal,
  type CoordinatorServerInfo,
  type LifecycleShutdownDisposition,
  type LifecycleState,
} from './lifecycle.js';
import { ExecutionService } from './execution-service.js';
import {
  commit as commitJournalEvents,
  type AppendedEvent,
  type CommitEventsFn,
  type PostCommitObserver,
} from '../store/append.js';
import { prepareCached, type Database } from '../store/db.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { loadJobProjectionDetail, loadJobProjectionDetails } from '../jobs/read-queries.js';
import { composeReducers } from '../store/reducers.js';
import { sealCoralStoreFormat } from '../store-format.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { observeTerminalResultExports, resultPathFor } from '../jobs/terminal/export.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { discussRegistry } from '../discuss/event-registry.js';
import { workflowRegistry } from '../workflow/events.js';
import { workflowRecover } from '../workflow/recover.js';
import { resolveDrainDeadlineMs } from '../workflow/execution-constants.js';
import { resolveStaleAbortTimeoutMs } from '../workflow/stale-recovery.js';
import { ConsumerDrainTimeout, ConsumerDriver } from '../projection-consumers/index.js';
import type { KbCorpusPublication, KbCorpusSnapshot } from '../kb/contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { createWorkflowRecoveryFinalizer } from './services/workflow-recovery-finalizer.js';
import { createFailedWorkflowDescendantReleaser } from './services/workflow-recovery-descendants.js';
import { assertDescriberCoverage } from '../read-model/event-describers.js';
import { aggregateWorkflowUsage } from '../jobs/workflow-usage.js';
import { JobStore } from '../jobs/store.js';
import { JobLocationIndex } from '../jobs/location-index.js';
import { recoverJobLocations } from '../jobs/location-recovery.js';
import { deriveLaunchReadiness } from '../jobs/launch-readiness.js';
import { encodeResolvedStoreEpoch, inspectCurrentStore, type ResolvedStoreEpoch } from '../store/epoch/index.js';
import { observeSuccessionWriterGeneration } from '../store/succession-writer-generation.js';
import { createJobsStartupRunner } from '../jobs/startup.js';
import { TypedEventBus } from './event-bus.js';
import { createLifecycleReactor } from '../sessions/lifecycle-reactor.js';
import type { TextProjectionHealthState } from '../transport/server-ports.js';
import {
  createDefaultKbDaemonSupervisor,
  createDisabledKbDaemonSupervisor,
  type KbDaemonSupervisor,
} from './live/kb-daemon-supervisor/index.js';
import type { KbDaemonEventMessage } from '../kb-daemon/protocol.js';
import { createKbCurateAssistantHandler, createKbCurateUsageBudgetHandler } from './services/kb-curate-assistant.js';
import { createProviderEventHandler } from './services/provider-event-application.js';
import type { ProviderEventHandler } from '../provider-proxy/control-client.js';
import { LocalOperationRegistry } from './services/operation-registry.js';
import { errorMessage } from '../infra/error-format.js';

export type CoordinatorServerOptions = Omit<
  CoordinatorCoreOptions,
  | 'runtime'
  | 'storeFormat'
  | 'getConsumerStuck'
  | 'createStoreServicesFromDbFn'
  | 'kbDaemonSupervisor'
  | 'buildProviderEventHandler'
  | 'operationRegistry'
> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
  kbDaemonSupervisor?: KbDaemonSupervisor;
  onFatalShutdownError: (error: unknown) => void;
};

export type CoordinatorServerController = {
  server: CoordinatorCoreResult['server'];
  start: () => Promise<CoordinatorServerInfo>;
  shutdown: (reason: ShutdownReason) => Promise<LifecycleShutdownDisposition>;
  waitForShutdown: () => Promise<LifecycleShutdownDisposition>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => CoordinatorCoreResult['idleTimer'];
  repairSupervision: CoordinatorCoreResult['repairSupervision'];
};

function createCoordinatorStartupRecoveryRunner({
  runtime,
  jobLocations,
  getStoreDb,
  getConsumerDriver,
  activeStoreEpoch,
  getCurrentJournalSeq,
  bootFreshnessTimeoutMs,
  coordinatorCommit,
  eventBus,
  lifecycleReactor,
  lifecycleReactorLifetime,
}: {
  runtime: Runtime;
  jobLocations: JobLocationIndex;
  getStoreDb: () => Database;
  getConsumerDriver: () => ConsumerDriver;
  activeStoreEpoch: () => ResolvedStoreEpoch | null;
  getCurrentJournalSeq: () => number;
  bootFreshnessTimeoutMs: number;
  coordinatorCommit: CommitEventsFn;
  eventBus: TypedEventBus;
  lifecycleReactor: ReturnType<typeof createLifecycleReactor>;
  lifecycleReactorLifetime: AbortController;
}): Parameters<typeof createCoordinatorCore>[1] {
  return async (
    {
      identity,
      progressStore,
      providerRegistry,
      getExecutionService,
      getRecoveryService,
      knownDiscussSources,
      getDiscussStoreForSource,
      getDiscussContext,
      createInvocationContext,
      recoveryCoordinator,
      signal,
      recoverPersistedDiscussFn,
      transferredJobIds,
    },
    runCoordinatorStartupRecovery,
  ) => {
    const runJobsStartup = createJobsStartupRunner(runCoordinatorStartupRecovery);
    const db = getStoreDb();
    const driver = getConsumerDriver();
    const activeEpoch = activeStoreEpoch();
    if (activeEpoch === null) throw new Error('Job recovery requires an active store epoch');
    recoverJobLocations(jobLocations, encodeResolvedStoreEpoch(runtime, activeEpoch), progressStore);

    registerBaseJournalCursors(driver);
    signal.throwIfAborted();

    const currentMaxSeq = getCurrentJournalSeq();
    driver.notify('journal', currentMaxSeq);
    await awaitRecoveryCursorBarrier(driver, currentMaxSeq, bootFreshnessTimeoutMs);
    signal.throwIfAborted();

    const jobsStartup = await runJobsStartup({
      namespace: identity.namespace,
      bundleHash: identity.bundleHash,
      runtime,
      progressStore,
      providerRegistry,
      getRecoveryService,
      createInvocationContext,
      signal,
      log: identity.log,
      coordinatorCommit,
      ...(transferredJobIds === undefined ? {} : { transferredJobIds }),
    });
    const recoveryProgressStore = jobsStartup.progressStore;
    signal.throwIfAborted();

    const recoveredDiscussResumes = await recoverPersistedDiscussFn({
      knownDiscussSources,
      getDiscussStoreForSource,
      getDiscussContext,
      createInvocationContext,
      signal,
    });
    signal.throwIfAborted();

    await workflowRecover.resumeAll({
      db,
      progressStore: recoveryProgressStore,
      jobEpochKey: (jobId) => jobLocations.read(jobId)?.epochKey ?? null,
      loadJobDetails: loadJobProjectionDetails,
      getExecutionService: (ctx) => getExecutionService(ctx) as never,
      createInvocationContext,
      finalizeWorkflow: createWorkflowRecoveryFinalizer({
        runtime,
        progressStore,
        coordinatorCommit,
        log: identity.log,
      }),
      releaseFailedWorkflowDescendants: createFailedWorkflowDescendantReleaser({
        progressStore: recoveryProgressStore,
        runtime,
        coordinatorCommit,
        getExecutionService,
        createInvocationContext,
        releaseAdoptedJob: recoveryCoordinator.releaseAdoptedJob,
        emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
        log: identity.log,
      }),
      signal,
      log: identity.log,
      ids: runtime.ids,
      time: runtime.time,
      drainDeadlineMs: resolveDrainDeadlineMs(runtime.env),
      staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(runtime.env),
    });
    signal.throwIfAborted();

    await scanLifecycleReactorAtStartup(lifecycleReactor, lifecycleReactorLifetime, signal);
    signal.throwIfAborted();

    return recoveredDiscussResumes;
  };
}

function registerBaseJournalCursors(driver: ConsumerDriver): void {
  for (const id of ['jobs', 'sessions', 'discuss', 'workflow'] as const) {
    driver.register({ id, authority: 'journal', kind: 'cursor', registrationKind: 'base' });
  }
}

async function scanLifecycleReactorAtStartup(
  lifecycleReactor: ReturnType<typeof createLifecycleReactor>,
  lifecycleReactorLifetime: AbortController,
  signal: AbortSignal,
): Promise<void> {
  // Workflow recovery must renew or consume replacement intents before retention scans them.
  const abortReactorLifetime = () => lifecycleReactorLifetime.abort();
  signal.addEventListener('abort', abortReactorLifetime, { once: true });
  try {
    await lifecycleReactor.scanStartup(signal);
  } finally {
    signal.removeEventListener('abort', abortReactorLifetime);
  }
}

function createJobAppendObserver({
  runtime,
  jobLocations,
  activeStoreEpoch,
  readCore,
}: {
  runtime: Runtime;
  jobLocations: JobLocationIndex;
  activeStoreEpoch: () => ResolvedStoreEpoch | null;
  readCore: () => CoordinatorCoreResult | null;
}): (input: Parameters<JobLocationIndex['beforeAppend']>[0]) => void {
  return (input: Parameters<JobLocationIndex['beforeAppend']>[0]): void => {
    const core = readCore();
    if (input.stream.kind !== 'job' || !['job.launch.requested', 'job.terminal.recorded'].includes(input.type)) return;
    const active = activeStoreEpoch();
    if (active === null) throw new Error('Job append requires an active store epoch');
    const generation = observeSuccessionWriterGeneration(runtime);
    const controller =
      core === null ||
      generation === null ||
      generation.storeRoot !== (active.canonicalStoreRoot ?? active.storeRoot) ||
      generation.epoch !== active.epoch
        ? undefined
        : {
            buildSetId: core.identity.buildSetId,
            instanceId: core.identity.instanceId,
            controlGeneration: generation.generation,
          };
    jobLocations.beforeAppend(input, encodeResolvedStoreEpoch(runtime, active), controller);
  };
}

type KbDaemonEventState = { handle: ((message: KbDaemonEventMessage) => void) | null };

function createCoordinatorKbSupervisor({
  runtime,
  providerRegistry,
  kbEnabled,
  options,
  readCore,
  eventState,
}: {
  runtime: Runtime;
  providerRegistry: ProviderRegistry;
  kbEnabled: boolean;
  options: CoordinatorServerOptions;
  readCore: () => CoordinatorCoreResult | null;
  eventState: KbDaemonEventState;
}): KbDaemonSupervisor {
  const pluginRoot = options.pluginRoot;
  const completeKbDaemonCurateAssistant = createKbCurateAssistantHandler({
    runtime,
    providerRegistry,
    readActiveRuntime: () => {
      const activeCore = readCore();
      return activeCore === null
        ? null
        : {
            systemProviderScope: activeCore.systemProviderScope,
          };
    },
  });
  const readActiveSystemProviderRuntime = () => {
    const activeCore = readCore();
    return activeCore === null ? null : { systemProviderScope: activeCore.systemProviderScope };
  };
  const checkKbDaemonCurateUsageBudget = createKbCurateUsageBudgetHandler({
    runtime,
    providerRegistry,
    readActiveRuntime: readActiveSystemProviderRuntime,
  });
  return (() => {
    if (options.kbDaemonSupervisor) {
      return options.kbDaemonSupervisor;
    }
    if (!kbEnabled) {
      return createDisabledKbDaemonSupervisor(KB_DISABLED_REASON);
    }
    if (pluginRoot === undefined) {
      throw new Error('KB daemon supervisor requires pluginRoot when KB is enabled');
    }
    return createDefaultKbDaemonSupervisor({
      runtime,
      pluginRoot: pluginRoot,
      ...(options.bootSnapshot?.instanceId === undefined ? {} : { instanceId: options.bootSnapshot.instanceId }),
      ...(options.backendNamespace === undefined ? {} : { backendNamespace: options.backendNamespace }),
      ...(options.bootSnapshot?.bundleHash === undefined ? {} : { bundleHash: options.bootSnapshot.bundleHash }),
      curateAssistant: completeKbDaemonCurateAssistant,
      curateUsageBudget: checkKbDaemonCurateUsageBudget,
      onEvent: (message) => eventState.handle?.(message),
      log: (message) => backendLog.warn(message),
    });
  })();
}

function createJournalCommitObserver(
  exportTerminalResults: ReturnType<typeof observeTerminalResultExports>,
  getStoreServices: () => CoordinatorStoreServices,
  jobLocations: JobLocationIndex,
  observeLifecycleCommitted: PostCommitObserver,
): PostCommitObserver {
  return (appended) => {
    exportTerminalResults(appended);
    for (const event of appended) {
      if (event.stream.kind !== 'job' || event.type !== 'job.progress.emitted') continue;
      try {
        const detail = getStoreServices().progressStore.loadJobProjectionDetail(event.stream.id);
        if (detail.status === null) continue;
        jobLocations.recordObserved(event.stream.id, {
          status: detail.status,
          events: getStoreServices().progressStore.readJobEvents(event.stream.id),
          readiness: deriveLaunchReadiness(detail),
          exit: detail.exit,
        });
      } catch (error: unknown) {
        backendLog.warn(`Writing job progress address failed for ${event.stream.id}: ${errorMessage(error)}`);
      }
    }
    observeLifecycleCommitted(appended);
  };
}

function createCoordinatorJournalAssembly({
  runtime,
  readCore,
  jobLocations,
  reducers,
  bodyCodec,
  providerRegistry,
  eventBus,
  operationRegistry,
  textProjectionHealth,
  beforeJobAppend,
  observeLifecycleCommitted,
}: {
  runtime: Runtime;
  readCore: () => CoordinatorCoreResult | null;
  jobLocations: JobLocationIndex;
  reducers: ReturnType<typeof composeReducers>;
  bodyCodec: ReturnType<typeof createEventBodyCodec>;
  providerRegistry: ProviderRegistry;
  eventBus: TypedEventBus;
  operationRegistry: LocalOperationRegistry;
  textProjectionHealth: ReturnType<typeof createTextProjectionHealthTracker>;
  beforeJobAppend: (input: Parameters<JobLocationIndex['beforeAppend']>[0]) => void;
  observeLifecycleCommitted: PostCommitObserver;
}) {
  const { getStoreServices, getStoreDb, getQueryDb, getConsumerDriver } = createCoordinatorStoreAccess(readCore);
  const exportTerminalResults = observeTerminalResultExports(
    (jobId) => getStoreServices().progressStore.publishTerminalResult(jobId),
    (jobId, seq) => {
      const progressStore = getStoreServices().progressStore;
      progressStore.configureResultExports(jobLocations);
      const detail = progressStore.loadJobProjectionDetail(jobId);
      if (detail.status === null) throw new Error(`Terminal has no job status: ${jobId}`);
      jobLocations.recordTerminal(
        jobId,
        {
          status: detail.status,
          events: progressStore.readJobEvents(jobId),
          readiness: deriveLaunchReadiness(detail),
          exit: detail.exit,
        },
        resultPathFor(runtime.paths.coral.exports.jobsRoot, jobId),
        seq,
      );
    },
  );
  const observeCommitted = createJournalCommitObserver(
    exportTerminalResults,
    getStoreServices,
    jobLocations,
    observeLifecycleCommitted,
  );

  const createStoreServicesFromDbFn = (storeDb: Database): CoordinatorStoreServices => {
    const core = readCore();
    if (core === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    const progressStore = new JobStore(core.identity.namespace, runtime, bodyCodec, {
      db: storeDb,
      eventBus,
      reducers,
      providers: providerLookupPortFromCatalog(providerRegistry),
      observer: observeCommitted,
      beforeAppend: beforeJobAppend,
    });
    const consumerDriver = new ConsumerDriver({
      db: storeDb,
      now: () => nowDate(runtime.time),
      time: runtime.time,
      onTextProjectionApplyStart: textProjectionHealth.beginReindex,
      onTextProjectionApplyEnd: textProjectionHealth.endReindex,
    });

    return {
      storeDb,
      progressStore,
      consumerDriver,
    };
  };

  const getCurrentJournalSeq = () =>
    prepareCached<[], { seq: number }>(getQueryDb(), 'SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get()?.seq ?? 0;
  const coordinatorCommit: CommitEventsFn = (cb) => {
    const db = getStoreDb();
    const appended = commitJournalEvents(db, cb, {
      now: () => nowDate(runtime.time),
      reducers,
      bodyCodec,
      providers: providerLookupPortFromCatalog(providerRegistry),
      beforeAppend: beforeJobAppend,
    });
    if (appended.length === 0) {
      return appended;
    }

    publishJobEvents(appended);
    getConsumerDriver().notify('journal', appended[appended.length - 1]?.seq ?? getCurrentJournalSeq());
    observeCommitted(appended);
    return appended;
  };
  const buildProviderEventHandler = (): ProviderEventHandler =>
    createCoordinatorProviderEventHandler({
      runtime,
      getStoreDb,
      getStoreServices,
      reducers,
      bodyCodec,
      providerRegistry,
      eventBus,
      operationRegistry,
      beforeJobAppend,
      exportTerminalResults,
    });
  return {
    getStoreDb,
    getQueryDb,
    getConsumerDriver,
    observeCommitted,
    createStoreServicesFromDbFn,
    getCurrentJournalSeq,
    coordinatorCommit,
    buildProviderEventHandler,
  };
}

function createKbDaemonEventHandler({
  getConsumerDriver,
  getCurrentJournalSeq,
  observeCommitted,
}: {
  getConsumerDriver: () => ConsumerDriver;
  getCurrentJournalSeq: () => number;
  observeCommitted: PostCommitObserver;
}): (message: KbDaemonEventMessage) => void {
  return (message: KbDaemonEventMessage): void => {
    if (message.event === 'journal') {
      if (!isAppendedEventArray(message.appended)) {
        backendLog.warn('[kb-daemon] ignored malformed journal event payload.');
        return;
      }
      const appended = message.appended;
      if (appended.length === 0) {
        return;
      }
      publishJobEvents(appended);
      getConsumerDriver().notify('journal', appended[appended.length - 1]?.seq ?? getCurrentJournalSeq());
      observeCommitted(appended);
      return;
    }

    if (!isCorpusPublication(message.publication)) {
      backendLog.warn('[kb-daemon] ignored malformed corpus event payload.');
      return;
    }
    const driver = getConsumerDriver();
    if (message.publication.changedLanes.length === 1) {
      driver.notifyCorpus(message.publication.snapshot, message.publication.changedLanes[0]);
      return;
    }
    driver.notifyCorpus(message.publication.snapshot);
  };
}

function createCoordinatorServerController(
  coordinatorCore: CoordinatorCoreResult,
  shutdownLifecycleReactor: () => void | Promise<void>,
): CoordinatorServerController {
  const triggerLifecycleReactorDisposal = (): void => {
    void Promise.resolve(shutdownLifecycleReactor()).catch((error: unknown) => {
      backendLog.warn(`Lifecycle reactor disposal after shutdown failed: ${errorMessage(error)}`);
    });
  };

  return {
    server: coordinatorCore.server,
    repairSupervision: coordinatorCore.repairSupervision,
    start: () => coordinatorCore.lifecycleController.start(),
    shutdown: async (reason) => {
      const disposition = await coordinatorCore.lifecycleController.shutdown(reason);
      if (isLifecycleShutdownTerminal(disposition)) triggerLifecycleReactorDisposal();
      return disposition;
    },
    waitForShutdown: async () => {
      const disposition = await coordinatorCore.lifecycleController.waitForShutdown();
      if (isLifecycleShutdownTerminal(disposition)) {
        triggerLifecycleReactorDisposal();
        await finalizeStoreServices(coordinatorCore.storeServicesRef);
      }
      return disposition;
    },
    getLifecycle: () => coordinatorCore.runtimeState.getLifecycle(),
    getIdleTimer: () => coordinatorCore.idleTimer,
  };
}

function prepareCoordinatorServerRuntime(
  runtime: Runtime,
  providedRuntimeObserver: RuntimeObserver | undefined,
): boolean {
  const runtimeObserver = asEmittingRuntimeObserver(providedRuntimeObserver ?? new EventEmitterObserver());
  observeRuntimeSpawns(runtime, runtimeObserver);

  const rawKbEnabled = runtime.env.get(CORAL_KB_ENABLE_ENV);
  if (rawKbEnabled !== undefined && !['0', '1'].includes(rawKbEnabled)) {
    backendLog.warn(`${CORAL_KB_ENABLE_ENV}="${rawKbEnabled}" is not 1 or 0; leaving KB enabled.`);
  }
  const kbEnabled = resolveKbEnabled(rawKbEnabled);

  const recordingDir = resolveSpawnRecordingDir(runtime.env.get('CORAL_SIMULATE_RECORD'), runtime.env.cwd());
  if (recordingDir) {
    attachRecordingObserver({ observer: runtimeObserver, runtime, recordingDir });
  }
  return kbEnabled;
}

function prepareCoordinatorServerRegistries(
  options: CoordinatorServerOptions,
  registerBuiltInProvidersFn: CoordinatorServerOptions['registerBuiltInProvidersFn'],
) {
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);

  const operationRegistry = new LocalOperationRegistry();
  const providerRegistry = options.providerRegistry ?? new ProviderRegistry();
  (registerBuiltInProvidersFn ?? registerBuiltInProviders)(providerRegistry);
  const storeFormat = sealCoralStoreFormat(providerRegistry);
  const eventBus = options.eventBus ?? new TypedEventBus();

  assertDescriberCoverage(reducers.describerKeys);
  const bodyCodec = createEventBodyCodec();
  const readCtx = { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec };
  return { reducers, operationRegistry, providerRegistry, storeFormat, eventBus, bodyCodec, readCtx };
}

function createCoordinatorLifecycleReactorDisposal(
  lifecycleReactor: ReturnType<typeof createLifecycleReactor>,
  lifetime: AbortController,
): () => Promise<void> {
  let disposal: Promise<void> | null = null;
  return () => {
    lifetime.abort();
    disposal ??= lifecycleReactor.dispose().catch((error: unknown) => {
      disposal = null;
      throw error;
    });
    return disposal;
  };
}

function createCoordinatorProviderEventHandler({
  runtime,
  getStoreDb,
  getStoreServices,
  reducers,
  bodyCodec,
  providerRegistry,
  eventBus,
  operationRegistry,
  beforeJobAppend,
  exportTerminalResults,
}: {
  runtime: Runtime;
  getStoreDb: () => Database;
  getStoreServices: () => CoordinatorStoreServices;
  reducers: ReturnType<typeof composeReducers>;
  bodyCodec: ReturnType<typeof createEventBodyCodec>;
  providerRegistry: ProviderRegistry;
  eventBus: TypedEventBus;
  operationRegistry: LocalOperationRegistry;
  beforeJobAppend: (input: Parameters<JobLocationIndex['beforeAppend']>[0]) => void;
  exportTerminalResults: PostCommitObserver;
}): ProviderEventHandler {
  return createProviderEventHandler({
    db: getStoreDb(),
    progressStore: getStoreServices().progressStore,
    appendContext: {
      now: () => nowDate(runtime.time),
      reducers,
      bodyCodec,
      providers: providerLookupPortFromCatalog(providerRegistry),
      beforeAppend: beforeJobAppend,
    },
    providerRegistry,
    runtime,
    emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
    // A terminal committed here must release its in-process holdings, including child principal handles.
    observeCommitted: (appended) => {
      exportTerminalResults(appended);
      getStoreServices().progressStore.announceCommitted(appended);
    },

    recordedStopCauseFor: (identity) => operationRegistry.recordedStopCauseFor(identity),
    operations: {
      settled: (identity) => {
        // The saga tombstone must outlive a lost settlement reply, so this callback releases only the
        // process-local admission, abort, and pool bookkeeping owned by this coordinator generation.
        try {
          operationRegistry.settled(identity);
        } catch (error: unknown) {
          backendLog.warn(
            `Failed to release local bookkeeping for job '${identity.jobId}'/operation '${identity.operationId}': ${errorMessage(error)}`,
          );
        }
      },
    },
  });
}

function createCoordinatorStoreAccess(readCore: () => CoordinatorCoreResult | null) {
  const getStoreServices = (): CoordinatorStoreServices => {
    const services = readCore()?.storeServicesRef.tryGet() ?? null;
    if (services === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    return services;
  };
  const getStoreDb = () => {
    return getStoreServices().storeDb;
  };
  const getQueryDb = () => getStoreDb();

  const getConsumerDriver = () => {
    const consumerDriver = getStoreServices().consumerDriver;
    if (consumerDriver === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    return consumerDriver;
  };

  return { getStoreServices, getStoreDb, getQueryDb, getConsumerDriver };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isAppendedEventArray(value: unknown): value is AppendedEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (event) =>
        isRecord(event) &&
        typeof event.seq === 'number' &&
        typeof event.ts === 'string' &&
        typeof event.type === 'string' &&
        isRecord(event.stream),
    )
  );
}

function isCorpusSnapshot(value: unknown): value is KbCorpusSnapshot {
  return (
    isRecord(value) &&
    typeof value.snapshotId === 'string' &&
    typeof value.contentSeq === 'number' &&
    typeof value.metadataSeq === 'number' &&
    typeof value.contentManifestHash === 'string' &&
    typeof value.metadataManifestHash === 'string'
  );
}

function isCorpusPublication(value: unknown): value is KbCorpusPublication {
  if (!isRecord(value) || !isCorpusSnapshot(value.snapshot) || !Array.isArray(value.changedLanes)) {
    return false;
  }
  return value.changedLanes.every((lane) => lane === 'content' || lane === 'metadata');
}

function deriveCoordinatorFlavor(options: CoordinatorServerOptions): 'prod' | 'dev' {
  if (options.bootSnapshot?.flavor) {
    return options.bootSnapshot.flavor;
  }
  if (!options.pluginRoot) {
    throw new Error('createCoordinatorServer requires bootSnapshot.flavor or pluginRoot');
  }
  return readBuildFlavor(options.pluginRoot);
}

const DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS = 90_000;

function resolveBootFreshnessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS;
}

/** Keeps recovery fatal when a base cursor cannot reach the notified journal snapshot. */
export async function awaitRecoveryCursorBarrier(
  driver: Pick<ConsumerDriver, 'waitFreshUntil'>,
  currentMaxSeq: number,
  timeoutMs: number,
): Promise<void> {
  await Promise.all([
    driver.waitFreshUntil('journal', currentMaxSeq, 'jobs', timeoutMs),
    driver.waitFreshUntil('journal', currentMaxSeq, 'sessions', timeoutMs),
    driver.waitFreshUntil('journal', currentMaxSeq, 'discuss', timeoutMs),
    driver.waitFreshUntil('journal', currentMaxSeq, 'workflow', timeoutMs),
  ]);
}

function createTextProjectionHealthTracker(): {
  readonly beginModelFetch: () => void;
  readonly endModelFetch: () => void;
  readonly beginReindex: () => void;
  readonly endReindex: () => void;
  readonly read: () => TextProjectionHealthState;
} {
  let modelFetchCount = 0;
  let reindexCount = 0;

  return {
    beginModelFetch: () => {
      modelFetchCount += 1;
    },
    endModelFetch: () => {
      modelFetchCount = Math.max(0, modelFetchCount - 1);
    },
    beginReindex: () => {
      reindexCount += 1;
    },
    endReindex: () => {
      reindexCount = Math.max(0, reindexCount - 1);
    },
    read: () => {
      if (modelFetchCount > 0) {
        return 'fetching';
      }
      if (reindexCount > 0) {
        return 'reindexing';
      }
      return 'idle';
    },
  };
}

export async function finalizeStoreServices(ref: StoreServicesRef): Promise<void> {
  const services = ref.tryGet();
  if (services === null) {
    return;
  }

  try {
    await services.consumerDriver?.shutdown({ drainTimeoutMs: 5_000 });
  } catch (error: unknown) {
    if (error instanceof ConsumerDrainTimeout) {
      backendLog.warn(`ConsumerDriver shutdown drain timed out: ${error.message}`);
    } else {
      throw error;
    }
  }
  services.storeDb.close();
  ref.clear();
}

export function createCoordinatorServer(options: CoordinatorServerOptions): CoordinatorServerController {
  const {
    runtime: providedRuntime,
    runtimeObserver: providedRuntimeObserver,
    registerBuiltInProvidersFn,
    ...coreOptions
  } = options;
  const flavor = deriveCoordinatorFlavor(options);
  const runtime = providedRuntime ?? createRealRuntime(flavor);
  const jobLocations = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot, renderWorkflowReport);
  let core: CoordinatorCoreResult | null = null;
  const activeStoreEpoch = (): ResolvedStoreEpoch | null => {
    const opened = core?.openedStoreEpoch() ?? null;
    if (opened !== null) return opened;
    const inspected = inspectCurrentStore(runtime);
    return inspected.kind === 'current' ? inspected.epoch : null;
  };
  const beforeJobAppend = createJobAppendObserver({ runtime, jobLocations, activeStoreEpoch, readCore: () => core });
  const kbEnabled = prepareCoordinatorServerRuntime(runtime, providedRuntimeObserver);
  const { reducers, operationRegistry, providerRegistry, storeFormat, eventBus, bodyCodec, readCtx } =
    prepareCoordinatorServerRegistries(options, registerBuiltInProvidersFn);
  const bootFreshnessTimeoutMs = resolveBootFreshnessTimeoutMs(runtime);
  const textProjectionHealth = createTextProjectionHealthTracker();
  const providedCreateExecutionService = coreOptions.createExecutionService;
  const kbDaemonEventState: KbDaemonEventState = { handle: null };
  const kbDaemonSupervisor = createCoordinatorKbSupervisor({
    runtime,
    providerRegistry,
    kbEnabled,
    options,
    readCore: () => core,
    eventState: kbDaemonEventState,
  });

  const {
    getStoreDb,
    getQueryDb,
    getConsumerDriver,
    observeCommitted,
    createStoreServicesFromDbFn,
    getCurrentJournalSeq,
    coordinatorCommit,
    buildProviderEventHandler,
  } = createCoordinatorJournalAssembly({
    runtime,
    readCore: () => core,
    jobLocations,
    reducers,
    bodyCodec,
    providerRegistry,
    eventBus,
    operationRegistry,
    textProjectionHealth,
    beforeJobAppend,
    observeLifecycleCommitted: (appended) => lifecycleReactor.observe(appended),
  });
  const lifecycleReactorLifetime = new AbortController();
  const lifecycleReactor = createLifecycleReactor({
    db: getQueryDb,
    readCtx,
    providers: providerRegistry,
    runtime,
    time: runtime.time,
    commitEvents: coordinatorCommit,
    signal: lifecycleReactorLifetime.signal,
  });
  const disposeLifecycleReactor = createCoordinatorLifecycleReactorDisposal(lifecycleReactor, lifecycleReactorLifetime);
  const shutdownLifecycleReactor = coreOptions.disposeLifecycleReactor ?? disposeLifecycleReactor;
  kbDaemonEventState.handle = createKbDaemonEventHandler({ getConsumerDriver, getCurrentJournalSeq, observeCommitted });

  core = createCoordinatorCore(
    {
      ...coreOptions,
      jobLocationIndex: jobLocations,
      providerRegistry,
      providerHostAdmission: createCoordinatorProviderHostAdmission(),
      eventBus,
      runtime,
      storeFormat,
      discardSessionArtifacts: (sessionId) => lifecycleReactor.discardSessionArtifacts(sessionId),
      disposeLifecycleReactor: shutdownLifecycleReactor,
      createStoreServicesFromDbFn,
      buildProviderEventHandler,
      operationRegistry,
      getConsumerStuck: () => getConsumerDriver().stuckConsumers(),
      getTextProjectionState: textProjectionHealth.read,
      kbDaemonSupervisor,
      createExecutionService: (ctx, deps) => {
        const wiredDeps = {
          ...deps,
          coordinatorCommit,
          loadJobProjectionDetail: (jobId: string) => loadJobProjectionDetail(getQueryDb(), jobId, readCtx),

          visitProgress: <T>(_epoch: string, read: (source: ProgressSource) => T) =>
            visitJobProgress(getQueryDb(), readCtx, read),
          aggregateWorkflowUsage: (workflowJobId: string) => aggregateWorkflowUsage(getQueryDb(), workflowJobId),
          subscribeJobEvents,
          getCurrentJournalSeq,
        };
        return providedCreateExecutionService
          ? providedCreateExecutionService(ctx, wiredDeps)
          : new ExecutionService(ctx, wiredDeps);
      },
      registerBuiltInProvidersFn: () => {},
    },
    createCoordinatorStartupRecoveryRunner({
      runtime,
      jobLocations,
      getStoreDb,
      getConsumerDriver,
      activeStoreEpoch,
      getCurrentJournalSeq,
      bootFreshnessTimeoutMs,
      coordinatorCommit,
      eventBus,
      lifecycleReactor,
      lifecycleReactorLifetime,
    }),
  );
  return createCoordinatorServerController(core, shutdownLifecycleReactor);
}
