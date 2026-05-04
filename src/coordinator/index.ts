import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { providerLookupPortFromCatalog } from '../providers/catalog.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime, RuntimeObserver } from '../runtime/ports.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { nowDate } from '../infra/time.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './spawn-observer.js';
import { createCoordinatorCore } from './composition/index.js';
import type {
  CoordinatorCoreOptions,
  CoordinatorCoreResult,
  CoordinatorStoreServices,
  StoreServicesRef,
} from './composition/types.js';
import { createKbSubsystem } from '../kb/subsystem.js';
import type { CoordinatorServerInfo, LifecycleState } from './lifecycle.js';
import { ExecutionService } from './execution-service.js';
import { commit as commitJournalEvents, type CommitEventsFn } from '../store/append.js';
import { persistCorpusState as persistCorpusStateInDb } from '../kb/state/corpus-state.js';
import type { Database } from '../store/db.js';
import { createDefaultUpcasterRegistry } from '../store/upcaster-registry.js';
import { readJobEvents, loadJobProjectionDetail } from '../jobs/read-queries.js';
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
import { ConsumerDriver } from './consumer-driver/index.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import type { Backed, FtsRetrieval, KbCorpusSnapshot, KbRuntime } from '../kb/contract.js';
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
import { ExpansionLifecycleService } from './expansion/lifecycle.js';
import { ExpansionStateStore } from './expansion/state.js';
import { createWorkflowRecoveryFinalizer } from './services/workflow-recovery-finalizer.js';
import { assertDescriberCoverage } from '../read-model/event-describers.js';
import { JobStore } from '../jobs/store.js';
import { TypedEventBus } from './event-bus.js';
import { createLifecycleReactor } from '../sessions/lifecycle-reactor.js';
import { registerWakeUpCorpusConsumer } from './services/kb/wake-up.js';
import { runPromoteRecovery } from '../kb/ops/promote-recovery.js';

export type CoordinatorServerOptions = Omit<
  CoordinatorCoreOptions,
  'runtime' | 'runStartupRecoveryFn' | 'getConsumerStuck' | 'getMutationBlocked' | 'createStoreServicesFromDbFn'
> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
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
  const corpusBindings = runtimeView.list().filter(isTrustedCorpusCapability);
  const ids: string[] = [];
  for (const record of corpusBindings) {
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

async function repairProjectionArtifactLagOnBoot(
  kb: KbRuntime,
  driver: ConsumerDriver,
  timeoutMs: number,
): Promise<void> {
  const lag = detectProjectionArtifactLag(kb, await kb.engineArtifactRegistry.describeArtifacts());
  const targetConsumerIds = [...new Set(lag.flatMap((entry) => entry.targetConsumerIds))];
  if (targetConsumerIds.length === 0) {
    return;
  }

  const snapshot = kb.getCorpusStateSnapshot();
  const forced = driver.forceCorpusApply(snapshot, {
    reason: 'projection-artifact-lag',
    consumers: targetConsumerIds,
  });
  await Promise.all(
    forced.consumers.map((consumerId) =>
      driver.waitFreshUntil('corpus', { snapshot, atLeastGeneration: forced.generation }, consumerId, timeoutMs),
    ),
  );
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
  const providedCreateKbSubsystemFn = coreOptions.createKbSubsystemFn;
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
  let currentKbRuntime: KbRuntime | null = null;
  let resolveLifecyclePhase: (() => 'starting' | 'running' | 'draining' | 'stopped') | null = null;
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
        resolveCurrentIndex: () => {
          const kbRuntime = currentKbRuntime;
          if (kbRuntime === null) {
            throw documentedCoralSetupError('expansion_runtime_unavailable', { name: 'kb.corpusProjectionReader' });
          }
          return kbRuntime.corpusProjectionReader.resolveCurrentIndex();
        },
        prepareCurrentProjectionInput: (options) => {
          const kbRuntime = currentKbRuntime;
          if (kbRuntime === null) {
            throw documentedCoralSetupError('expansion_runtime_unavailable', { name: 'kb.corpusProjectionReader' });
          }
          return kbRuntime.corpusProjectionReader.prepareCurrentProjectionInput(options);
        },
      },
      onTextProjectionSync: () => {
        const kbRuntime = currentKbRuntime;
        if (kbRuntime === null) {
          throw documentedCoralSetupError('expansion_runtime_unavailable', { name: 'kb.textProjectionSync' });
        }
        kbRuntime.recordIndexSyncSuccess();
      },
    });
    const expansionLifecycleService = new ExpansionLifecycleService({
      makeHost: (manifest, scope) => {
        const kbRuntime = currentKbRuntime;
        if (kbRuntime === null) {
          throw documentedCoralSetupError('expansion_runtime_unavailable', { name: manifest.id });
        }

        return createHostFactory({
          runtime,
          kbRuntime,
          consumerDriver,
        })(manifest, scope);
      },
      state: expansionStateStore,
      manifest: expansionManifestCatalog.listManifests(),
      manifestCatalog: expansionManifestCatalog,
      now: () => nowDate(runtime.time).toISOString(),
      resolveKbRuntime: () => currentKbRuntime,
      getLifecyclePhase: () => resolveLifecyclePhase?.() ?? 'starting',
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
    (getQueryDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
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
  core = createCoordinatorCore({
    ...coreOptions,
    providerRegistry,
    eventBus,
    runtime,
    createStoreServicesFromDbFn,
    getConsumerStuck: () => getConsumerDriver().stuckConsumers(),
    getMutationBlocked: () => currentKbRuntime?.mutationLockDiagnostics() ?? { blocked: false },
    createKbSubsystemFn: async (ctx) => {
      const kbSubsystem = await (providedCreateKbSubsystemFn ?? createKbSubsystem)({
        ...ctx,
        db: getStoreDb(),
        persistCorpusState: (snapshot) =>
          persistCorpusStateInDb(getStoreDb(), snapshot, {
            now: () => nowDate(runtime.time),
          }),
        notifyCorpusMutation: async (publication) => {
          const driver = getConsumerDriver();
          if (publication.changedLanes.length === 1) {
            driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
            return;
          }
          driver.notifyCorpus(publication.snapshot);
        },
        onCorpusPublishFailure: (failure) => {
          curateSchedulerHealth.onCorpusPublishFailure(failure);
        },
        onCorpusPublishSuccess: () => {
          curateSchedulerHealth.onCorpusPublishSuccess();
        },
      });
      currentKbRuntime = kbSubsystem.kb;
      initializeCapabilityCatalog(
        kbSubsystem.kb.capabilityRegistry,
        getStoreServices().expansionManifestCatalog.listManifests(),
        BUILTIN_CAPABILITY_DESCRIPTORS,
      );
      if (kbSubsystem.curateScheduler) {
        kbSubsystem.curateScheduler = createCoordinatorCurateScheduler({
          scheduler: kbSubsystem.curateScheduler,
          db: getStoreDb(),
          runtime,
        });
      }
      // Boot step 0 (I0): finish or roll back any in-flight promote-to-wiki
      // before any corpus snapshot can be published. Runs strictly before
      // `retryPendingCorpusPublication()`, `ensureCorpusFreshness`, and any
      // `driver.notifyCorpus` so consumers cannot observe a snapshot built
      // from a partially committed promote.
      await runPromoteRecovery(kbSubsystem.kb);
      // Boot step 1: replay any corpus publication that committed state before a prior notify failure.
      await kbSubsystem.kb.retryPendingCorpusPublication();
      // Boot step 2: absorb external Corpus edits before replaying consumers.
      // Boot uses the blocking variant — downstream consumer apply must see
      // a fresh index. Subsequent KB read paths use the non-blocking lazy
      // variant (spec §12.3); the abort signal stops post-boot rebuilds when
      // shutdown drains.
      await kbSubsystem.kb.ensureCorpusFreshness({ wait: true, signal: corpusRescanAbort.signal });
      const driver = getConsumerDriver();
      // Boot step 3: replay installed-tier rows + apply bundled fallback to fill empty bindings.
      await getExpansionLifecycleService().recoverOnBoot();
      // Boot step 4: repair unchanged-snapshot projection artifacts before readiness waits.
      await repairProjectionArtifactLagOnBoot(kbSubsystem.kb, driver, bootFreshnessTimeoutMs);
      const wakeUpConsumer = registerWakeUpCorpusConsumer(driver, kbSubsystem.kb);
      // Boot step 5: replay the persisted corpus snapshot into downstream consumers.
      const corpusSnapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      driver.notifyCorpus(corpusSnapshot);
      const ftsConsumerId = kbSubsystem.kb.capabilityRegistry
        .runtimeView()
        .read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).consumer.id;
      await Promise.all([
        driver.waitFreshUntil('corpus', corpusSnapshot, ftsConsumerId, bootFreshnessTimeoutMs),
        driver.waitFreshUntil('corpus', corpusSnapshot, wakeUpConsumer.id, bootFreshnessTimeoutMs),
      ]);
      if (kbSubsystem.curateScheduler) {
        // Boot step 6: start background curation only after the read projections are aligned.
        await kbSubsystem.curateScheduler.start();
      }
      return kbSubsystem;
    },
    createExecutionService: (ctx, deps) => {
      const wiredDeps = {
        ...deps,
        coordinatorCommit,
        loadJobProjectionDetail: (jobId: string) => loadJobProjectionDetail(getQueryDb(), jobId, readCtx),
        readJobEvents: (jobId: string) => readJobEvents(getQueryDb(), jobId, readCtx),
        subscribeJobEvents,
        getCurrentJournalSeq,
        sessionLookup: getSessionLookup(),
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
      assertStartupStillActive,
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
      assertStartupStillActive();

      const currentMaxSeq = getCurrentJournalSeq();
      driver.notify('journal', currentMaxSeq);
      await Promise.all([
        driver.waitFreshUntil('journal', currentMaxSeq, 'jobs', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'sessions', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'discuss', bootFreshnessTimeoutMs),
        driver.waitFreshUntil('journal', currentMaxSeq, 'workflow', bootFreshnessTimeoutMs),
      ]);
      assertStartupStillActive();

      await jobsReconcile.runStartup({
        recoveryCoordinator,
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createInvocationContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
        sessionLookup: getSessionLookup(),
        coordinatorCommit,
      });
      assertStartupStillActive();

      await lifecycleReactor.scanStartup();
      assertStartupStillActive();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        assertStartupStillActive,
      });
      assertStartupStillActive();

      await workflowRecover.resumeAll({
        db,
        progressStore,
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
      assertStartupStillActive();

      return recoveredDiscussResumes;
    },
    registerBuiltInProvidersFn: registerBuiltInProvidersFn ?? registerBuiltInProviders,
  });
  const coordinatorCore = core;
  curateSchedulerHealth.attachRuntimeState(coordinatorCore.runtimeState);
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
