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
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './composition/types.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';
import type { CoordinatorServerInfo, LifecycleState } from './lifecycle.js';
import { ExecutionService } from './execution-service.js';
import { commit as commitJournalEvents, type AppendedEvent, type CommitEventsFn } from '../store/append.js';
import { prepareCached, type Database } from '../store/db.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { readJobEvents, loadJobProjectionDetail, loadJobProjectionDetails } from '../jobs/read-queries.js';
import { createProjectionSessionLookup } from '../sessions/lookup.js';
import { composeReducers } from '../store/reducers.js';
import { sealCoralStoreFormat } from '../store-format.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { jobsReconcile } from '../jobs/startup.js';
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
import { TypedEventBus } from './event-bus.js';
import { createLifecycleReactor } from '../sessions/lifecycle-reactor.js';
import type { TextProjectionHealthState } from '../transport/server-ports.js';
import {
  createDefaultKbDaemonSupervisor,
  createDisabledKbDaemonSupervisor,
  type KbDaemonSupervisor,
} from './live/kb-daemon-supervisor.js';
import type { KbDaemonEventMessage } from '../kb-daemon/protocol.js';
import { createKbCurateAssistantHandler, createKbCurateUsageBudgetHandler } from './services/kb-curate-assistant.js';

export type CoordinatorServerOptions = Omit<
  CoordinatorCoreOptions,
  | 'runtime'
  | 'storeFormat'
  | 'runStartupRecoveryFn'
  | 'getConsumerStuck'
  | 'createStoreServicesFromDbFn'
  | 'kbDaemonSupervisor'
> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
  kbDaemonSupervisor?: KbDaemonSupervisor;
};

export type CoordinatorServerController = {
  server: CoordinatorCoreResult['server'];
  start: () => Promise<CoordinatorServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => CoordinatorCoreResult['idleTimer'];
};

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

// Default deadline for waiting on backend boot freshness (KB readiness, store
// projection cursors, etc.). Preserves the prior 90s budget so behavior under
// `CORAL_BOOT_FRESHNESS_TIMEOUT_MS` unset/invalid is unchanged.
const DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS = 90_000;

function resolveBootFreshnessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BOOT_FRESHNESS_TIMEOUT_MS;
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

export function createCoordinatorServer(options: CoordinatorServerOptions = {}): CoordinatorServerController {
  const {
    runtime: providedRuntime,
    runtimeObserver: providedRuntimeObserver,
    registerBuiltInProvidersFn,
    ...coreOptions
  } = options;
  const flavor = deriveCoordinatorFlavor(options);
  const runtime = providedRuntime ?? createRealRuntime(flavor);
  const runtimeObserver = asEmittingRuntimeObserver(providedRuntimeObserver ?? new EventEmitterObserver());
  observeRuntimeSpawns(runtime, runtimeObserver);

  // KB boot gate: CORAL_KB_ENABLE=0 wires a terminal offline KB daemon health component so
  // the daemon boots without the KB runtime, curate scheduler, or corpus
  // projection. Only the explicit '0' disables; a malformed value warns once
  // and leaves KB enabled.
  const rawKbEnabled = runtime.env.get(CORAL_KB_ENABLE_ENV);
  if (rawKbEnabled !== undefined && !['0', '1'].includes(rawKbEnabled)) {
    backendLog.warn(`${CORAL_KB_ENABLE_ENV}="${rawKbEnabled}" is not 1 or 0; leaving KB enabled.`);
  }
  const kbEnabled = resolveKbEnabled(rawKbEnabled);

  const recordingDir = resolveSpawnRecordingDir(runtime.env.get('CORAL_SIMULATE_RECORD'), runtime.env.cwd());
  if (recordingDir) {
    attachRecordingObserver({
      observer: runtimeObserver,
      runtime,
      recordingDir,
    });
  }

  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const providerRegistry = coreOptions.providerRegistry ?? new ProviderRegistry();
  (registerBuiltInProvidersFn ?? registerBuiltInProviders)(providerRegistry);
  const storeFormat = sealCoralStoreFormat(providerRegistry);
  const eventBus = coreOptions.eventBus ?? new TypedEventBus();
  // Spec §7.1: every Journal event type can be a causeRef target. Verify
  // describer coverage at boot so missing describers fail loudly instead of
  // rendering causeRef chains as bare type names.
  assertDescriberCoverage(reducers.describerKeys);
  const bodyCodec = createEventBodyCodec();
  const readCtx = { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec };
  let core: CoordinatorCoreResult | null = null;
  const bootFreshnessTimeoutMs = resolveBootFreshnessTimeoutMs(runtime);
  const textProjectionHealth = createTextProjectionHealthTracker();
  const providedCreateExecutionService = coreOptions.createExecutionService;
  const explicitPluginRoot = coreOptions.pluginRoot ?? options.pluginRoot;
  let handleKbDaemonEvent: ((message: KbDaemonEventMessage) => void) | null = null;
  const completeKbDaemonCurateAssistant = createKbCurateAssistantHandler({
    runtime,
    providerRegistry,
    readActiveRuntime: () => {
      const activeCore = core;
      return activeCore === null
        ? null
        : {
            systemProviderScope: activeCore.systemProviderScope,
          };
    },
  });
  const readActiveSystemProviderRuntime = () => {
    const activeCore = core;
    return activeCore === null ? null : { systemProviderScope: activeCore.systemProviderScope };
  };
  const checkKbDaemonCurateUsageBudget = createKbCurateUsageBudgetHandler({
    runtime,
    providerRegistry,
    readActiveRuntime: readActiveSystemProviderRuntime,
  });
  const kbDaemonSupervisor = (() => {
    if (coreOptions.kbDaemonSupervisor) {
      return coreOptions.kbDaemonSupervisor;
    }
    if (!kbEnabled) {
      return createDisabledKbDaemonSupervisor(KB_DISABLED_REASON);
    }
    if (explicitPluginRoot === undefined) {
      throw new Error('KB daemon supervisor requires pluginRoot when KB is enabled');
    }
    return createDefaultKbDaemonSupervisor({
      runtime,
      pluginRoot: explicitPluginRoot,
      ...(coreOptions.bootSnapshot?.instanceId === undefined
        ? {}
        : { instanceId: coreOptions.bootSnapshot.instanceId }),
      ...(coreOptions.backendNamespace === undefined ? {} : { backendNamespace: coreOptions.backendNamespace }),
      ...(coreOptions.bootSnapshot?.bundleHash === undefined
        ? {}
        : { bundleHash: coreOptions.bootSnapshot.bundleHash }),
      curateAssistant: completeKbDaemonCurateAssistant,
      curateUsageBudget: checkKbDaemonCurateUsageBudget,
      onEvent: (message) => handleKbDaemonEvent?.(message),
      log: (message) => backendLog.warn(message),
    });
  })();

  const getStoreServices = (): CoordinatorStoreServices => {
    const services = core?.storeServicesRef.tryGet() ?? null;
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

  const createStoreServicesFromDbFn = (storeDb: Database): CoordinatorStoreServices => {
    if (core === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    const progressStore = new JobStore(core.identity.namespace, runtime, bodyCodec, {
      db: storeDb,
      eventBus,
      reducers,
      providers: providerLookupPortFromCatalog(providerRegistry),
      observer: lifecycleReactor.observe,
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
  const getSessionLookup = () => createProjectionSessionLookup(getQueryDb());
  const coordinatorCommit: CommitEventsFn = (cb) => {
    const db = getStoreDb();
    const appended = commitJournalEvents(db, cb, {
      now: () => nowDate(runtime.time),
      reducers,
      bodyCodec,
      providers: providerLookupPortFromCatalog(providerRegistry),
    });
    if (appended.length === 0) {
      return appended;
    }

    publishJobEvents(appended);
    getConsumerDriver().notify('journal', appended[appended.length - 1]?.seq ?? getCurrentJournalSeq());
    lifecycleReactor.observe(appended);
    return appended;
  };
  const lifecycleReactor = createLifecycleReactor({
    db: getQueryDb,
    readCtx,
    providers: providerRegistry,
    runtime,
    time: runtime.time,
    commitEvents: coordinatorCommit,
  });
  handleKbDaemonEvent = (message: KbDaemonEventMessage): void => {
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
      lifecycleReactor.observe(appended);
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

  core = createCoordinatorCore({
    ...coreOptions,
    providerRegistry,
    eventBus,
    runtime,
    storeFormat,
    discardSessionArtifacts: (sessionId) => lifecycleReactor.discardSessionArtifacts(sessionId),
    disposeLifecycleReactor: () => lifecycleReactor.dispose(),
    createStoreServicesFromDbFn,
    getConsumerStuck: () => getConsumerDriver().stuckConsumers(),
    getTextProjectionState: textProjectionHealth.read,
    kbDaemonSupervisor,
    createExecutionService: (ctx, deps) => {
      const wiredDeps = {
        ...deps,
        coordinatorCommit,
        loadJobProjectionDetail: (jobId: string) => loadJobProjectionDetail(getQueryDb(), jobId, readCtx),
        readJobEvents: (jobId: string) => readJobEvents(getQueryDb(), jobId, readCtx),
        aggregateWorkflowUsage: (workflowJobId: string) => aggregateWorkflowUsage(getQueryDb(), workflowJobId),
        subscribeJobEvents,
        getCurrentJournalSeq,
      };
      return providedCreateExecutionService
        ? providedCreateExecutionService(ctx, wiredDeps)
        : new ExecutionService(ctx, wiredDeps);
    },
    runStartupRecoveryFn: async ({
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
      cleanupStaleJobs,
      recoverPersistedDiscussFn,
    }) => {
      const db = getStoreDb();
      const driver = getConsumerDriver();

      // Base journal projection consumers register cursor-only — projection
      // state is written by the commit-time reducer (spec §3.3); the cursor
      // row exists so `waitFreshUntil` can resolve callers waiting on a
      // specific journal seq.
      driver.register({
        id: 'jobs',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      driver.register({
        id: 'sessions',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      driver.register({
        id: 'discuss',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      driver.register({
        id: 'workflow',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      signal.throwIfAborted();

      const currentMaxSeq = getCurrentJournalSeq();
      driver.notify('journal', currentMaxSeq);
      await Promise.all([
        driver.waitFreshUntil('journal', currentMaxSeq, 'jobs', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'sessions', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'discuss', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'workflow', bootFreshnessTimeoutMs),
      ]);
      signal.throwIfAborted();

      const recoveryProgressStore = await jobsReconcile.runStartup({
        recoveryCoordinator,
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        signal,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: getSessionLookup(),
        coordinatorCommit,
      });
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
        time: runtime.time,
        drainDeadlineMs: resolveDrainDeadlineMs(runtime.env),
        staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(runtime.env),
      });
      signal.throwIfAborted();

      // Pending workflow replacement intents must be examined before the
      // retention reactor can expire them. Workflow recovery renews or consumes
      // the intent deterministically; only the remainder is eligible for expiry.
      await lifecycleReactor.scanStartup();
      signal.throwIfAborted();

      return recoveredDiscussResumes;
    },
    registerBuiltInProvidersFn: () => {},
  });
  const coordinatorCore = core;
  // KB lifecycle is owned by the child proxy; the server does not build a KB runtime.

  return {
    server: coordinatorCore.server,
    start: () => coordinatorCore.lifecycleController.start(),
    shutdown: (reason) => coordinatorCore.lifecycleController.shutdown(reason),
    waitForShutdown: async () => {
      await coordinatorCore.lifecycleController.waitForShutdown();
      await finalizeStoreServices(coordinatorCore.storeServicesRef);
    },
    getLifecycle: () => coordinatorCore.runtimeState.getLifecycle(),
    getIdleTimer: () => coordinatorCore.idleTimer,
  };
}
