import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { providerLookupPortFromCatalog } from '../providers/catalog.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime, RuntimeObserver } from '../runtime/ports.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { nowDate } from '../infra/time.js';
import { backendLog } from '../infra/backend-log.js';
import { CORAL_KB_ENABLE_ENV, resolveKbEnabled } from '../infra/kb-toggle.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './spawn-observer.js';
import { createCoordinatorCore } from './composition/index.js';
import { createClaudeCurateAssistant } from './services/kb/curate-assistant.js';
import { createRunCommunitySummaryJob } from './services/kb/community-summary.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './composition/types.js';
import type { CoordinatorStoreServices, StoreServicesRef } from './composition/store-services-ref.js';
import type { CreateKbSubsystemOptions } from '../kb/subsystem.js';
import { createKbSubsystem, disabledKbSubsystem } from './subsystems/kb.js';
import { KB_ID } from './subsystems/contract.js';
import { isErrorEnvelope } from './subsystems/registry.js';
import type { CoordinatorServerInfo, LifecycleState } from './lifecycle.js';
import { ExecutionService } from './execution-service.js';
import { commit as commitJournalEvents, type CommitEventsFn } from '../store/append.js';
import { persistCorpusState as persistCorpusStateInDb } from '../kb/state/corpus-state.js';
import { prepareCached, type Database } from '../store/db.js';
import { createDefaultUpcasterRegistry } from '../store/upcaster-registry.js';
import { readJobEvents, loadJobProjectionDetail, loadJobProjectionDetails } from '../jobs/read-queries.js';
import { createProjectionSessionLookup } from '../sessions/lookup.js';
import { composeReducers } from '../store/reducers.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { jobsReconcile } from '../jobs/startup.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { discussRegistry } from '../discuss/event-registry.js';
import { workflowRegistry } from '../workflow/events.js';
import { workflowRecover } from '../workflow/recover.js';
import { resolveDrainDeadlineMs } from '../workflow/execution-constants.js';
import { resolveStaleAbortTimeoutMs } from '../workflow/stale-recovery.js';
import { ConsumerDriver, FreshnessTimeout } from './consumer-driver/index.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import type { Backed, FtsRetrieval, KbCorpusSnapshot, KbRuntime } from '../kb/contract.js';
import type { KnowledgeBaseRuntime } from '../kb/subsystem.js';
import type { VectorRetrieval } from '../kb/search/contract.js';
import type { RegisteredKbCapability } from '../kb/capability/contract.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_FTS_CAPABILITY,
  KB_VECTOR_CAPABILITY,
} from '../kb/capability/constants.js';
import { initializeCapabilityCatalog } from '../expansion/manifest-fills-validation.js';
import { createExpansionManifestCatalog } from '../expansion/manifest-catalog.js';
import { detectProjectionArtifactLag } from '../kb/corpus/rescan/drift.js';
import type { SourceImportReadiness } from '../jobs/launch.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import { createHostFactory } from './expansion/host-factory.js';
import {
  createLifecycleBundledLoaders,
  createOramaProjectionReconcileRequester,
  ExpansionLifecycleService,
  isOramaOnlyRepairTarget,
  startKiwiArtifactFetchOnBoot,
} from './expansion/lifecycle.js';
import { ExpansionStateStore } from './expansion/state.js';
import { createWorkflowRecoveryFinalizer } from './services/workflow-recovery-finalizer.js';
import { assertDescriberCoverage } from '../read-model/event-describers.js';
import { JobStore } from '../jobs/store.js';
import { TypedEventBus } from './event-bus.js';
import { createLifecycleReactor } from '../sessions/lifecycle-reactor.js';
import { runPromoteRecovery } from '../kb/ops/promote-recovery.js';
import type { TextProjectionHealthState } from '../transport/server-ports.js';

export type CoordinatorServerOptions = Omit<
  CoordinatorCoreOptions,
  | 'runtime'
  | 'runStartupRecoveryFn'
  | 'getConsumerStuck'
  | 'getMutationBlocked'
  | 'createStoreServicesFromDbFn'
  | 'createKbSubsystemFn'
> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
  /**
   * Test seam: replaces the default `createKbRuntime` build step with a
   * factory returning `KnowledgeBaseRuntime`. Coordinator wraps this into
   * the new `Subsystem<KnowledgeBaseRuntime>` registry contract; the
   * subsystem's retry / dispose / curate-bridge semantics still apply.
   */
  createKbSubsystemFn?: (options: CreateKbSubsystemOptions) => Promise<KnowledgeBaseRuntime>;
};

export type CoordinatorServerController = {
  server: CoordinatorCoreResult['server'];
  start: () => Promise<CoordinatorServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => CoordinatorCoreResult['idleTimer'];
};

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

  await services.consumerDriver?.shutdown();
  services.storeDb.close();
  ref.clear();
}

const BUILTIN_CAPABILITY_DESCRIPTORS = [
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
] as const;

function isTrustedCorpusCapability(record: RegisteredKbCapability): boolean {
  if (record.origin !== 'builtin') {
    return false;
  }
  const { name } = record.descriptor;
  return name === KB_FTS_CAPABILITY || name === KB_VECTOR_CAPABILITY;
}

// Bundled Orama always binds kb.fts; engines like needle bind kb.vector when
// equipped. Unbound capabilities throw 'binding_empty' from `read()` — catch
// and skip so 'all-equipped' is best-effort over what's currently equipped.
export function readBoundCorpusConsumerIds(kb: Pick<KbRuntime, 'capabilityRegistry'>): string[] {
  const runtimeView = kb.capabilityRegistry.runtimeView();
  const ids: string[] = [];
  for (const record of runtimeView.list()) {
    if (!isTrustedCorpusCapability(record)) {
      continue;
    }
    try {
      ids.push(runtimeView.read<Backed<FtsRetrieval | VectorRetrieval>>(record.descriptor.name).consumer.id);
    } catch {
      // binding_empty — corpus consumer not currently equipped; skip.
    }
  }
  return ids;
}

export type CorpusSnapshotWaiter = (params: {
  consumerId: string;
  snapshot: KbCorpusSnapshot;
  timeoutMs: number;
}) => Promise<void>;

function isBindingEmpty(error: unknown): boolean {
  return error instanceof CoralSetupError && error.code === 'binding_empty';
}

// Spec §6.4 readiness contract. Surfaced as a pure function so tests can drive
// it without booting the coordinator. The real coordinator wires this to
// `getConsumerDriver().waitFreshUntil('corpus', snapshot, consumerId, timeoutMs)`.
//
// `base-search` and `active-vector` both depend on a bound retrieval engine
// (`kb.fts` and `kb.vector` respectively). When the binding is empty we surface
// `kb_unavailable` so the readiness failure is consistent across both branches
// (spec §6.4 readiness table) instead of leaking a raw `binding_empty` from the
// runtime-binding internal helper.
export async function waitForCorpusReadiness(params: {
  kb: Pick<KbRuntime, 'capabilityRegistry'>;
  readiness: SourceImportReadiness;
  snapshot: KbCorpusSnapshot;
  timeoutMs: number;
  waitFresh: CorpusSnapshotWaiter;
}): Promise<void> {
  const { kb, readiness, snapshot, timeoutMs, waitFresh } = params;
  switch (readiness) {
    case 'commit':
      return;
    case 'base-search': {
      let consumerId: string;
      try {
        consumerId = kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).consumer.id;
      } catch (error) {
        if (isBindingEmpty(error)) {
          throw documentedCoralSetupError('kb_unavailable', { readiness, binding: 'kb.fts' });
        }
        throw error;
      }
      await waitFresh({ consumerId, snapshot, timeoutMs });
      return;
    }
    case 'active-vector': {
      let consumerId: string;
      try {
        consumerId = kb.capabilityRegistry.runtimeView().read<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY)
          .consumer.id;
      } catch (error) {
        if (isBindingEmpty(error)) {
          throw documentedCoralSetupError('kb_unavailable', { readiness, binding: 'kb.vector' });
        }
        throw error;
      }
      await waitFresh({ consumerId, snapshot, timeoutMs });
      return;
    }
    case 'all-equipped': {
      const corpusConsumerIds = readBoundCorpusConsumerIds(kb);
      await Promise.all(corpusConsumerIds.map((consumerId) => waitFresh({ consumerId, snapshot, timeoutMs })));
      return;
    }
  }
}

type BootProjectionArtifactRepairResult = {
  readonly allowStaleFts: boolean;
};

export async function repairProjectionArtifactLagOnBoot(
  kb: KbRuntime,
  driver: ConsumerDriver,
  timeoutMs: number,
): Promise<BootProjectionArtifactRepairResult> {
  const lag = detectProjectionArtifactLag(kb, await kb.engineArtifactRegistry.describeArtifacts());
  const targetConsumerIds: string[] = [];
  const seenTargetConsumers = new Set<string>();
  for (const entry of lag) {
    for (const consumerId of entry.targetConsumerIds) {
      if (seenTargetConsumers.has(consumerId)) {
        continue;
      }
      seenTargetConsumers.add(consumerId);
      targetConsumerIds.push(consumerId);
    }
  }
  if (targetConsumerIds.length === 0) {
    return { allowStaleFts: false };
  }

  const snapshot = kb.getCorpusStateSnapshot();
  const forced = driver.forceCorpusApply(snapshot, {
    reason: 'projection-artifact-lag',
    consumers: targetConsumerIds,
  });
  try {
    await Promise.all(
      forced.consumers.map((consumerId) =>
        driver.waitFreshUntil('corpus', { snapshot, atLeastGeneration: forced.generation }, consumerId, timeoutMs),
      ),
    );
  } catch (error: unknown) {
    if (isOramaOnlyRepairTarget(targetConsumerIds) && error instanceof FreshnessTimeout) {
      backendLog.warn(
        `[kb] Orama projection artifact repair timed out during boot; ` +
          'KB will start with stale or uninitialized FTS while background reconcile continues.',
      );
      return { allowStaleFts: true };
    }
    throw error;
  }
  return { allowStaleFts: false };
}

export function createCoordinatorServer(options: CoordinatorServerOptions = {}): CoordinatorServerController {
  const {
    runtime: providedRuntime,
    runtimeObserver: providedRuntimeObserver,
    registerBuiltInProvidersFn,
    createKbSubsystemFn: providedCreateKbSubsystemFn,
    ...coreOptions
  } = options;
  const flavor = deriveCoordinatorFlavor(options);
  const runtime = providedRuntime ?? createRealRuntime(flavor);
  const runtimeObserver = asEmittingRuntimeObserver(providedRuntimeObserver ?? new EventEmitterObserver());
  observeRuntimeSpawns(runtime, runtimeObserver);

  // KB boot gate: CORAL_KB_ENABLE=0 wires a terminal offline KB subsystem so
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
  const eventBus = coreOptions.eventBus ?? new TypedEventBus();
  // Spec §7.1: every Journal event type can be a causeRef target. Verify
  // describer coverage at boot so missing describers fail loudly instead of
  // rendering causeRef chains as bare type names.
  assertDescriberCoverage(reducers.describerKeys);
  const upcasters = createDefaultUpcasterRegistry();
  const readCtx = { schemas: reducers.schemas, upcasters };
  let core: CoordinatorCoreResult | null = null;
  const bootFreshnessTimeoutMs = resolveBootFreshnessTimeoutMs(runtime);
  const curateSchedulerHealth = createCurateSchedulerHealthBridge();
  const textProjectionHealth = createTextProjectionHealthTracker();
  const providedCreateExecutionService = coreOptions.createExecutionService;

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
  const getKbJobRecorder = () => {
    if (core === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    return core.getKbJobRecorder();
  };

  const getConsumerDriver = () => {
    const consumerDriver = getStoreServices().consumerDriver;
    if (consumerDriver === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    return consumerDriver;
  };

  const getExpansionLifecycleService = () => {
    const expansionLifecycleService = getStoreServices().expansionLifecycleService;
    if (expansionLifecycleService === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    return expansionLifecycleService;
  };
  // Late-bound KB runtime accessor. Normal coordinator requests read via
  // `subsystems.run` once KB is online/degraded. The remaining early-boot
  // gap is narrower: `createKbSubsystem.init()` has already built the runtime
  // but has not yet completed `runBootSequence`, so the registry must still
  // report `initializing`. During that window, boot-only callbacks owned by
  // already-created store services (consumer-driver corpus projection and
  // expansion fallback recovery) need the same built runtime to finish the
  // boot sequence that will make the registry online. `pendingKbRuntime`
  // bridges only that bootstrap callback cycle; external KB RPCs still route
  // through the registry and receive the initializing/offline envelope.
  let pendingKbRuntime: KbRuntime | null = null;
  const resolveKbRuntime = (): KbRuntime | null => {
    if (pendingKbRuntime !== null) return pendingKbRuntime;
    const c = core;
    if (c === null) return null;
    const result = c.runtimeState.subsystems.run<KnowledgeBaseRuntime, KbRuntime>(KB_ID, (kb) => kb.kb);
    return isErrorEnvelope(result) ? null : result;
  };
  const requireKbRuntime = (name: string): KbRuntime => {
    const kbRuntime = resolveKbRuntime();
    if (kbRuntime === null) {
      throw documentedCoralSetupError('expansion_runtime_unavailable', { name });
    }
    return kbRuntime;
  };
  let resolveLifecyclePhase: (() => 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped') | null = null;
  // Spec §12.3 lazy non-blocking rescan: shutdown aborts any pending background
  // rebuild kicks so a draining instance does not start fresh KB work. Boot's
  // blocking `wait: true` on the next coordinator picks up the staleness.
  const corpusRescanAbort = new AbortController();
  const createStoreServicesFromDbFn = (storeDb: Database): CoordinatorStoreServices => {
    if (core === null) {
      throw documentedCoralSetupError('startup_not_ready');
    }
    const progressStore = new JobStore(core.identity.namespace, runtime, upcasters, {
      db: storeDb,
      eventBus,
      reducers,
      providers: providerLookupPortFromCatalog(providerRegistry),
      observer: lifecycleReactor.observe,
    });
    const expansionManifestCatalog = createExpansionManifestCatalog({
      db: storeDb,
      now: () => nowDate(runtime.time).toISOString(),
    });
    const expansionStateStore = new ExpansionStateStore(storeDb);
    const consumerDriver = new ConsumerDriver({
      db: storeDb,
      now: () => nowDate(runtime.time),
      time: runtime.time,
      corpusProjectionReader: {
        resolveCurrentIndex: () =>
          requireKbRuntime('kb.corpusProjectionReader').corpusProjectionReader.resolveCurrentIndex(),
        prepareCurrentProjectionInput: (options) =>
          requireKbRuntime('kb.corpusProjectionReader').corpusProjectionReader.prepareCurrentProjectionInput(options),
      },
      onTextProjectionApplyStart: textProjectionHealth.beginReindex,
      onTextProjectionApplyEnd: textProjectionHealth.endReindex,
      onTextProjectionSync: () => {
        requireKbRuntime('kb.textProjectionSync').recordIndexSyncSuccess();
      },
    });
    const oramaReconcileRequester = createOramaProjectionReconcileRequester({
      kb: {
        getCorpusStateSnapshot: () => requireKbRuntime('orama-reconcile').getCorpusStateSnapshot(),
        invalidateTextSnapshot: (reason) => requireKbRuntime('orama-reconcile').invalidateTextSnapshot(reason),
      },
      driver: consumerDriver,
    });
    const expansionLifecycleService = new ExpansionLifecycleService({
      makeHost: (manifest, scope) => {
        const kbRuntime = requireKbRuntime(manifest.id);
        return createHostFactory({
          runtime,
          kbRuntime,
          consumerDriver,
        })(manifest, scope);
      },
      state: expansionStateStore,
      manifest: expansionManifestCatalog.listManifests(),
      manifestCatalog: expansionManifestCatalog,
      bundledLoaders: createLifecycleBundledLoaders({
        requestProjectionReconcile: oramaReconcileRequester.requestProjectionReconcile,
        onApplyFailure: () => oramaReconcileRequester.requestProjectionReconcile('terminal-analyzer-failure'),
        requestKiwiDegradedReconcile: oramaReconcileRequester.requestKiwiDegradedReconcile,
      }),
      now: () => nowDate(runtime.time).toISOString(),
      resolveKbRuntime,
      getLifecyclePhase: () => {
        const phase = resolveLifecyclePhase?.() ?? 'starting';
        // ExpansionLifecycleService accepts `'starting' | 'running' | 'draining' | 'stopped'`.
        // Map the new `'kernel-ready'` phase to `'starting'` for backward compat — equip
        // semantics during kernel-ready match the historical `'starting'` semantics
        // (subsystems are not online yet, but the listener is bound).
        return phase === 'kernel-ready' ? 'starting' : phase;
      },
    });

    return {
      storeDb,
      progressStore,
      expansionManifestCatalog,
      expansionStateStore,
      expansionLifecycleService,
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
      upcasters,
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
    providers: providerRegistry,
    runtime,
    commitEvents: coordinatorCommit,
  });

  // The seven boot steps (I0..I6) lifted from the previous
  // `createKbSubsystemFn` closure. Runs inside the subsystem's retry loop —
  // each step honors `signal.aborted` between operations.
  const runBootSequence = async (built: KnowledgeBaseRuntime, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    // Boot step 0 (I0): finish or roll back any in-flight promote-to-wiki
    // before any corpus snapshot can be published.
    await runPromoteRecovery(built.kb);
    signal.throwIfAborted();
    // Boot step 1: replay any corpus publication that committed state
    // before a prior notify failure.
    await built.kb.retryPendingCorpusPublication();
    signal.throwIfAborted();
    // Boot step 2: absorb external Corpus edits before replaying consumers.
    await built.kb.ensureCorpusFreshness({ wait: true, signal: corpusRescanAbort.signal });
    signal.throwIfAborted();
    const driver = getConsumerDriver();
    // Boot step 3: replay installed-tier rows + apply bundled fallback to
    // fill empty bindings.
    await getExpansionLifecycleService().recoverOnBoot();
    signal.throwIfAborted();
    // Korean analyzer artifacts are intentionally fetched out-of-band:
    // boot/search stays on the Intl baseline while the model downloads, then
    // the text projection is force-reapplied once the artifact lands.
    startKiwiArtifactFetchOnBoot({
      runtime,
      kb: built.kb,
      driver,
      timeoutMs: bootFreshnessTimeoutMs,
      signal,
      onModelFetchStart: textProjectionHealth.beginModelFetch,
      onModelFetchEnd: textProjectionHealth.endModelFetch,
    });
    // Boot step 4: repair unchanged-snapshot projection artifacts before
    // readiness waits.
    const projectionArtifactRepair = await repairProjectionArtifactLagOnBoot(
      built.kb,
      driver,
      bootFreshnessTimeoutMs,
    );
    signal.throwIfAborted();
    // Boot step 5: replay the persisted corpus snapshot into downstream consumers.
    const corpusSnapshot = built.kb.getCorpusStateSnapshot();
    driver.notifyCorpus(corpusSnapshot);
    const ftsConsumerId = built.kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY)
      .consumer.id;
    if (projectionArtifactRepair.allowStaleFts) {
      backendLog.warn('[kb] Skipping boot FTS freshness wait after stale Orama projection repair timeout.');
    } else {
      await driver.waitFreshUntil('corpus', corpusSnapshot, ftsConsumerId, bootFreshnessTimeoutMs);
    }
    signal.throwIfAborted();
    if (built.curateScheduler) {
      // Boot step 6: start background curation only after the read
      // projections are aligned.
      await built.curateScheduler.start();
    }
  };
  core = createCoordinatorCore({
    ...coreOptions,
    providerRegistry,
    eventBus,
    runtime,
    discardSessionArtifacts: (sessionId) => lifecycleReactor.discardSessionArtifacts(sessionId),
    createStoreServicesFromDbFn,
    getConsumerStuck: () => getConsumerDriver().stuckConsumers(),
    getMutationBlocked: () => resolveKbRuntime()?.mutationLockDiagnostics() ?? { blocked: false },
    getTextProjectionState: textProjectionHealth.read,
    createKbSubsystemFn: (ctx) => {
      // CORAL_KB_ENABLE=0: register a terminal offline KB and skip all
      // corpus/curate wiring below. KB stays off until a daemon restart.
      if (!kbEnabled) {
        return disabledKbSubsystem();
      }
      // Coordinator wires the KB subsystem with its corpus + curate
      // callbacks. The subsystem owns the retry loop; `runBootSequence`
      // below contains the seven boot steps (I0..I6) that previously lived
      // in this closure.
      const buildOptions = {
        ...ctx,
        db: getStoreDb(),
        persistCorpusState: (snapshot: KbCorpusSnapshot) =>
          persistCorpusStateInDb(getStoreDb(), snapshot, {
            now: () => nowDate(runtime.time),
          }),
        notifyCorpusMutation: async (publication: {
          snapshot: KbCorpusSnapshot;
          changedLanes: ('content' | 'metadata')[];
        }) => {
          const driver = getConsumerDriver();
          if (publication.changedLanes.length === 1) {
            driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
            return;
          }
          driver.notifyCorpus(publication.snapshot);
        },
        onCorpusPublishFailure: (failure: Parameters<typeof curateSchedulerHealth.onCorpusPublishFailure>[0]) => {
          curateSchedulerHealth.onCorpusPublishFailure(failure);
        },
        onCorpusPublishSuccess: () => {
          curateSchedulerHealth.onCorpusPublishSuccess();
        },
        // The curate scheduler fills stale community summaries via one recorded,
        // abortable `kb.community_summary` agent turn. The job is backend-global,
        // so it records against the KB corpus root.
        createCommunitySummaryJob: (kb: KbRuntime) =>
          createRunCommunitySummaryJob({
            kb,
            curateAssistant: ctx.curateAssistant,
            recorder: getKbJobRecorder(),
            projectRoot: ctx.paths.markdownRoot,
          }),
      };

      const prepareRuntime = (built: KnowledgeBaseRuntime): void => {
        // Expose the freshly built runtime to coordinator callbacks
        // (consumer-driver, expansion lifecycle) BEFORE `runBootSequence`
        // executes — those callbacks fire during `recoverOnBoot()` /
        // `notifyCorpus` and would otherwise see an offline registry.
        pendingKbRuntime = built.kb;
        initializeCapabilityCatalog(
          built.kb.capabilityRegistry,
          getStoreServices().expansionManifestCatalog.listManifests(),
          BUILTIN_CAPABILITY_DESCRIPTORS,
        );
        if (built.curateScheduler) {
          built.curateScheduler = createCoordinatorCurateScheduler({
            scheduler: built.curateScheduler,
            db: getStoreDb(),
            runtime,
          });
        }
      };

      // Test seam: when a host overrides `createKbSubsystemFn` with an
      // async factory returning `KnowledgeBaseRuntime`, route it through
      // the subsystem's `build` override so retry/dispose semantics still
      // apply. Production omits this branch.
      const buildOverride = providedCreateKbSubsystemFn;

      const subsystem = createKbSubsystem({
        ...buildOptions,
        time: runtime.time,
        curateBridge: curateSchedulerHealth,
        prepareRuntime,
        runBootSequence,
        ...(buildOverride === undefined ? {} : { build: buildOverride }),
      });
      subsystem.onStatusChange((status) => {
        if (status.phase !== 'initializing') {
          pendingKbRuntime = null;
        }
      });
      return subsystem;
    },
    // Production-only wiring of the real Claude-backed curate assistant. The
    // composition layer (shared with `tools/simulation`) only knows the
    // `CurateAssistantFactory` shape, never the provider runtime — see
    // `tools/simulation/sealed-inventory.json`.
    createCurateAssistant: createClaudeCurateAssistant,
    createExecutionService: (ctx, deps) => {
      const wiredDeps = {
        ...deps,
        coordinatorCommit,
        loadJobProjectionDetail: (jobId: string) => loadJobProjectionDetail(getQueryDb(), jobId, readCtx),
        readJobEvents: (jobId: string) => readJobEvents(getQueryDb(), jobId, readCtx),
        subscribeJobEvents,
        getCurrentJournalSeq,
      };
      return providedCreateExecutionService
        ? providedCreateExecutionService(ctx, wiredDeps)
        : new ExecutionService(ctx, wiredDeps);
    },
    waitForKbSourceImportReadiness: ({ kb, readiness, snapshot }) => {
      const driver = getConsumerDriver();
      return waitForCorpusReadiness({
        kb,
        readiness,
        snapshot,
        timeoutMs: bootFreshnessTimeoutMs,
        waitFresh: ({ consumerId, snapshot: target, timeoutMs }) =>
          driver.waitFreshUntil('corpus', target, consumerId, timeoutMs),
      });
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

      await jobsReconcile.runStartup({
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

      await lifecycleReactor.scanStartup();
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
        progressStore,
        loadJobDetails: loadJobProjectionDetails,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createInvocationContext,
        finalizeWorkflow: createWorkflowRecoveryFinalizer({
          runtime,
          progressStore,
          coordinatorCommit,
          log: identity.log,
        }),
        time: runtime.time,
        drainDeadlineMs: resolveDrainDeadlineMs(runtime.env),
        staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(runtime.env),
      });
      signal.throwIfAborted();

      return recoveredDiscussResumes;
    },
    registerBuiltInProvidersFn: registerBuiltInProvidersFn ?? registerBuiltInProviders,
  });
  const coordinatorCore = core;
  // The curate-scheduler health bridge wires into the KB subsystem during
  // its `init()` phase via `attachCurateBridge` — no additional wiring here.
  resolveLifecyclePhase = () => coordinatorCore.runtimeState.getLifecycle();

  return {
    server: coordinatorCore.server,
    start: () => coordinatorCore.lifecycleController.start(),
    shutdown: (reason) => {
      corpusRescanAbort.abort();
      return coordinatorCore.lifecycleController.shutdown(reason);
    },
    waitForShutdown: async () => {
      await coordinatorCore.lifecycleController.waitForShutdown();
      corpusRescanAbort.abort();
      await finalizeStoreServices(coordinatorCore.storeServicesRef);
    },
    getLifecycle: () => coordinatorCore.runtimeState.getLifecycle(),
    getIdleTimer: () => coordinatorCore.idleTimer,
  };
}
