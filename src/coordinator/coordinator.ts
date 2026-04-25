import { registerBuiltInProviders } from '../providers/bootstrap.js';
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
} from './observer.js';
import {
  createBackendCore,
} from './composition/create-backend-core.js';
import type { BackendCoreOptions, BackendCoreResult } from './composition/backend-core-types.js';
import { createKbSubsystem } from '../kb/subsystem.js';
import type { BackendServerInfo, LifecycleState } from './control.js';
import { ExecutionService } from './execution-service.js';
import { appendEvents as appendJournalEvents, type AppendEventsFn } from '../store/append.js';
import { persistCorpusState as persistCorpusStateInDb } from '../kb/state/corpus-state.js';
import { openBackendStoreDb } from '../store/db.js';
import { createDefaultUpcasterRegistry } from '../store/upcasters.js';
import { readJobProgress, loadJobProjectionDetail } from '../jobs/read-queries.js';
import { createProjectionSessionLookup } from '../sessions/lookup.js';
import { composeReducers } from '../store/reducers.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { jobsReconcile } from '../jobs/startup.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { discussRegistry } from '../discuss/store-registry.js';
import { workflowRegistry } from '../workflow/events.js';
import { registerJournalProjectionConsumer } from '../store/projection-consumer.js';
import { workflowRecover } from '../workflow/recover.js';
import { ConsumerDriver } from './consumer-driver.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import { releaseLock, acquireLock, CONTENDER_BUDGET } from './lock.js';
import { ORAMA_BASE_CONSUMER_ID } from '../kb/search/orama-backend.js';
import { NEEDLE_CONSUMER_ID } from '../kb/search/needle-contract.js';
import type { KbRuntime } from '../kb/contracts.js';
import { removeInstallArtifacts } from '../expansion/install.js';
import { EquipmentLifecycleService } from './equipment/lifecycle.js';
import { createEquipmentSlot, createSlotRegistry } from './equipment/slots.js';
import type { VectorRetrieval } from '../kb/search/contract.js';

export type CoordinatorServerOptions = Omit<BackendCoreOptions, 'runtime' | 'runStartupRecoveryFn'> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
};

export type BackendServerOptions = CoordinatorServerOptions;

export type CoordinatorServerController = {
  server: BackendCoreResult['server'];
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => BackendCoreResult['idleTimer'];
};

export type BackendServerController = CoordinatorServerController;

function resolveBootFreshnessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return CONTENDER_BUDGET;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CONTENDER_BUDGET;
}

export function createCoordinatorServer(options: CoordinatorServerOptions = {}): CoordinatorServerController {
  const {
    runtime: providedRuntime,
    runtimeObserver: providedRuntimeObserver,
    registerBuiltInProvidersFn,
    ...coreOptions
  } = options;
  const flavor =
    options.bootSnapshot?.flavor ?? readBuildFlavor(options.pluginRoot ?? process.cwd());
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
  const upcasters = createDefaultUpcasterRegistry();
  const readCtx = { schemas: reducers.schemas, upcasters };
  let storeDb: ReturnType<typeof openBackendStoreDb> | null = null;
  let consumerDriver: ConsumerDriver | null = null;
  const equipmentSlots = createSlotRegistry();
  const bootFreshnessTimeoutMs = resolveBootFreshnessTimeoutMs(runtime);
  const curateSchedulerHealth = createCurateSchedulerHealthBridge();
  const providedCreateKbSubsystemFn = coreOptions.createKbSubsystemFn;
  const providedCreateExecutionService = coreOptions.createExecutionService;
  const providedAcquireLockFn = coreOptions.acquireLockFn;
  const providedRemoveLockIfOwnerFn = coreOptions.removeLockIfOwnerFn;

  const getStoreDb = () => {
    if (storeDb !== null) {
      return storeDb;
    }

    storeDb = openBackendStoreDb(runtime);
    return storeDb;
  };
  const getQueryDb = () => options.progressStore?.getDb() ?? getStoreDb();

  const getConsumerDriver = () => {
    if (consumerDriver !== null) {
      return consumerDriver;
    }

    consumerDriver = new ConsumerDriver({
      db: getStoreDb(),
      now: () => nowDate(runtime.time),
      time: runtime.time,
    });
    return consumerDriver;
  };
  let currentKbRuntime: KbRuntime | null = null;
  const equipmentLifecycleService = new EquipmentLifecycleService({
    db: getStoreDb(),
    runtime,
    consumerDriver: getConsumerDriver(),
    slotRegistry: equipmentSlots,
    resolveKbRuntime: () => currentKbRuntime,
    removeInstallArtifacts: (name) => removeInstallArtifacts(runtime, name),
    now: () => nowDate(runtime.time),
  });

  const getCurrentJournalSeq = () =>
    (getQueryDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const getSessionLookup = () => createProjectionSessionLookup(getQueryDb());

  const coordinatorAppendEvents: AppendEventsFn = (inputs) => {
    const db = getStoreDb();
    const appended = appendJournalEvents(db, inputs, {
      now: () => nowDate(runtime.time),
      reducers,
      upcasters,
    });
    if (appended.length === 0) {
      return appended;
    }

    publishJobEvents(appended);
    getConsumerDriver().notify('journal', appended[appended.length - 1]?.seq ?? getCurrentJournalSeq());
    return appended;
  };

  const core = createBackendCore({
    ...coreOptions,
    runtime,
    equipmentLifecycleService,
    createKbSubsystemFn: async (ctx) => {
      const kbSubsystem = await (providedCreateKbSubsystemFn ?? createKbSubsystem)({
        ...ctx,
        db: getStoreDb(),
        flavor,
        getEquipmentView: () =>
          equipmentLifecycleService.getRuntimeActivation()
          ?? currentKbRuntime?.getEquipmentView()
          ?? null,
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
      const vectorSlot = createEquipmentSlot<VectorRetrieval>({
        id: 'kb.vector',
        defaultOwner: () => kbSubsystem.kb.getBaseRetrievalSurface(),
      });
      equipmentSlots.declare(vectorSlot);
      if (kbSubsystem.curateScheduler) {
        kbSubsystem.curateScheduler = createCoordinatorCurateScheduler({
          scheduler: kbSubsystem.curateScheduler,
          db: getStoreDb(),
          runtime,
        });
      }
      // Boot step 1: replay any corpus publication that committed state before a prior notify failure.
      await kbSubsystem.kb.retryPendingCorpusPublication();
      // Boot step 2: absorb external Corpus edits before replaying consumers.
      await kbSubsystem.kb.ensureCorpusFreshness();
      const driver = getConsumerDriver();
      driver.register(kbSubsystem.kb.getBaseRetrievalSurface());
      // Boot step 3: replay the persisted corpus snapshot into downstream consumers.
      const corpusSnapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      driver.notifyCorpus(corpusSnapshot);
      await driver.waitFreshUntil('corpus', corpusSnapshot, ORAMA_BASE_CONSUMER_ID, bootFreshnessTimeoutMs);
      if (kbSubsystem.curateScheduler) {
        // Boot step 4: start background curation only after the read projections are aligned.
        await kbSubsystem.curateScheduler.start();
      }
      return kbSubsystem;
    },
    createExecutionService: (ctx, deps) => {
      const wiredDeps = {
        ...deps,
        appendEvents: coordinatorAppendEvents,
        loadJobProjectionDetail: (jobId: string) => loadJobProjectionDetail(getQueryDb(), jobId, readCtx),
        readJobProgress: (jobId: string) => readJobProgress(getQueryDb(), jobId, readCtx),
        subscribeJobEvents,
        getCurrentJournalSeq,
        sessionLookup: getSessionLookup(),
      };
      return providedCreateExecutionService
        ? providedCreateExecutionService(ctx, wiredDeps)
        : new ExecutionService(ctx, wiredDeps);
    },
    waitForKbSourceImportReadiness: async ({ kb, readiness, snapshot }) => {
      if (readiness === 'commit') {
        return;
      }

      const driver = getConsumerDriver();
      const waitForOrama = () =>
        driver.waitFreshUntil('corpus', snapshot, ORAMA_BASE_CONSUMER_ID, bootFreshnessTimeoutMs);
      const waitForNeedle = () =>
        driver.waitFreshUntil('corpus', snapshot, NEEDLE_CONSUMER_ID, bootFreshnessTimeoutMs);

      if (readiness === 'base-search') {
        await waitForOrama();
        return;
      }

      if (readiness === 'active-vector') {
        const activeKind = (kb.getActiveVectorSurface() as { backendKind?: string }).backendKind;
        await (activeKind === 'needle' ? waitForNeedle() : waitForOrama());
        return;
      }

      await waitForOrama();
      if ((kb.getActiveVectorSurface() as { backendKind?: string }).backendKind === 'needle') {
        await waitForNeedle();
      }
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

      registerJournalProjectionConsumer(driver, db, 'jobs', jobsRegistry);
      registerJournalProjectionConsumer(driver, db, 'sessions', sessionsRegistry);
      registerJournalProjectionConsumer(driver, db, 'discuss', discussRegistry);
      registerJournalProjectionConsumer(driver, db, 'workflow', workflowRegistry);
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
      });
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
        time: runtime.time,
      });
      assertStartupStillActive();

      return recoveredDiscussResumes;
    },
    acquireLockFn:
      providedAcquireLockFn ??
      (async (_pluginRoot, instanceId, version, bundleHash, flavor) => {
        await acquireLock(flavor, bundleHash, {
          instanceId,
          version,
          runtime,
        });
      }),
    removeLockIfOwnerFn:
      providedRemoveLockIfOwnerFn ??
      ((_pluginRoot, instanceId) => {
        releaseLock(instanceId, runtime);
      }),
    registerBuiltInProvidersFn: registerBuiltInProvidersFn ?? registerBuiltInProviders,
  });
  curateSchedulerHealth.attachRuntimeState(core.runtimeState);

  return {
    server: core.server,
    start: () => core.lifecycleController.start(),
    shutdown: (reason) => core.lifecycleController.shutdown(reason),
    waitForShutdown: async () => {
      await core.lifecycleController.waitForShutdown();
      await consumerDriver?.shutdown();
      storeDb?.close();
      consumerDriver = null;
      storeDb = null;
    },
    getLifecycle: () => core.runtimeState.getLifecycle(),
    getIdleTimer: () => core.idleTimer,
  };
}

export const createBackendServer = createCoordinatorServer;
