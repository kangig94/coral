import { registerBuiltInProviders } from '../providers/bootstrap.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime, RuntimeObserver } from '../runtime/ports.js';
import { readBuildFlavor } from '../shared/utils.js';
import {
  EventEmitterObserver,
  asEmittingRuntimeObserver,
  attachRecordingObserver,
  observeRuntimeSpawns,
  resolveSpawnRecordingDir,
} from './recording/observer.js';
import {
  createBackendCore,
  type BackendCoreOptions,
  type BackendCoreResult,
} from '../execution/backend-core.js';
import { createKbSubsystem } from '../execution/kb-tools.js';
import type { BackendServerInfo, LifecycleState } from './control.js';
import { ExecutionService } from './api.js';
import { appendEvents as appendJournalEvents, type AppendEventsFn } from '../store/append.js';
import { persistCorpusState as persistCorpusStateInDb } from '../store/corpus-state.js';
import { openStoreDatabase } from '../store/db.js';
import { createEmptyRegistry } from '../store/envelope.js';
import { readJobProgress, loadJobProjectionDetail } from '../store/queries/jobs.js';
import { composeReducers } from '../store/reducers.js';
import { storePaths } from '../store/paths.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { jobsReconcile } from '../jobs/api.js';
import { jobsRegistry } from '../jobs/events.js';
import { registerJobsConsumer } from '../jobs/consumer.js';
import { registerDiscussConsumer } from '../discuss/consumer.js';
import { sessionsRegistry } from '../sessions/events.js';
import { registerSessionsConsumer } from '../sessions/consumer.js';
import { discussRegistry } from '../discuss/store-registry.js';
import { workflowRegistry } from '../workflow/events.js';
import { registerWorkflowConsumer } from '../workflow/consumer.js';
import { workflowRecover } from '../workflow/api.js';
import { createNotifyCorpusMutation } from './corpus-notify.js';
import { ConsumerDriver } from './consumer-driver.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import { releaseLock, acquireLock, CONTENDER_BUDGET } from './lock.js';

export type CoordinatorServerOptions = Omit<BackendCoreOptions, 'runtime'> & {
  runtime?: Runtime;
  runtimeObserver?: RuntimeObserver;
};

export type CoordinatorServerController = {
  server: BackendCoreResult['server'];
  start: () => Promise<BackendServerInfo>;
  shutdown: (reason: string) => Promise<void>;
  waitForShutdown: () => Promise<void>;
  getLifecycle: () => LifecycleState;
  getIdleTimer: () => BackendCoreResult['idleTimer'];
};

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
  const runtime = providedRuntime ?? createRealRuntime();
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

  const flavor = options.bootSnapshot?.flavor ?? readBuildFlavor(options.pluginRoot ?? runtime.env.cwd());
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const upcasters = createEmptyRegistry();
  let storeDb: ReturnType<typeof openStoreDatabase> | null = null;
  let consumerDriver: ConsumerDriver | null = null;
  const bootFreshnessTimeoutMs = resolveBootFreshnessTimeoutMs(runtime);
  const curateSchedulerHealth = createCurateSchedulerHealthBridge();

  const getStoreDb = () => {
    if (storeDb !== null) {
      return storeDb;
    }

    let storeDbPath = storePaths(flavor).dbFile;
    try {
      storeDbPath = runtime.paths.coral.store.dbFile;
    } catch {
      // Some direct coordinator tests intentionally bypass flavor-settled bootstrap.
    }

    storeDb = openStoreDatabase({
      path: storeDbPath,
      storage: runtime.storage,
    });
    return storeDb;
  };

  const getConsumerDriver = () => {
    if (consumerDriver !== null) {
      return consumerDriver;
    }

    consumerDriver = new ConsumerDriver({
      db: getStoreDb(),
      now: () => new Date(runtime.time.now()),
    });
    return consumerDriver;
  };

  const getCurrentJournalSeq = () =>
    (getStoreDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;

  const coordinatorAppendEvents: AppendEventsFn = (inputs) => {
    const db = getStoreDb();
    const appended = appendJournalEvents(db, inputs, {
      now: () => new Date(runtime.time.now()),
      reducers,
      upcasters,
    });
    if (appended.length === 0) {
      return;
    }

    publishJobEvents(db, appended);
    getConsumerDriver().notify('journal', appended[appended.length - 1]?.seq ?? getCurrentJournalSeq());
  };

  const core = createBackendCore({
    ...coreOptions,
    runtime,
    createKbSubsystemFn: async (ctx) => {
      const kbSubsystem = await createKbSubsystem({
        ...ctx,
        persistCorpusState: (snapshot) =>
          persistCorpusStateInDb(getStoreDb(), snapshot, {
            now: () => new Date(runtime.time.now()),
          }),
        notifyCorpusMutation: createNotifyCorpusMutation(getConsumerDriver()),
        onCorpusPublishFailure: (failure) => {
          curateSchedulerHealth.onCorpusPublishFailure(failure);
        },
        onCorpusPublishSuccess: () => {
          curateSchedulerHealth.onCorpusPublishSuccess();
        },
      });
      kbSubsystem.curateScheduler = createCoordinatorCurateScheduler({
        scheduler: kbSubsystem.curateScheduler,
        db: getStoreDb(),
        runtime,
      });
      await kbSubsystem.curateScheduler.start();
      return kbSubsystem;
    },
    createExecutionService: (ctx, deps) =>
      new ExecutionService(ctx, {
        ...deps,
        appendEvents: coordinatorAppendEvents,
        loadJobProjectionDetail: (jobId) => loadJobProjectionDetail(getStoreDb(), jobId),
        readJobProgress: (jobId) => readJobProgress(getStoreDb(), jobId),
        subscribeJobEvents,
        getCurrentJournalSeq,
      }),
    runStartupRecoveryFn: async ({
      identity,
      progressStore,
      providerRegistry,
      getExecutionService,
      getRecoveryService,
      knownDiscussSources,
      getDiscussStoreForSource,
      getDiscussContext,
      createCallerContext,
      recoveryCoordinator,
      assertStartupStillActive,
      cleanupStaleJobs,
      recoverPersistedDiscussFn,
    }) => {
      const db = getStoreDb();
      const driver = getConsumerDriver();

      registerJobsConsumer(driver, db);
      registerSessionsConsumer(driver, db);
      registerDiscussConsumer(driver, db);
      registerWorkflowConsumer(driver, db);
      assertStartupStillActive();

      const currentMaxSeq = getCurrentJournalSeq();
      driver.notify('journal', currentMaxSeq);
      for (const consumerId of ['jobs', 'sessions', 'discuss', 'workflow']) {
        await driver.waitFreshUntil(currentMaxSeq, consumerId, bootFreshnessTimeoutMs);
      }
      assertStartupStillActive();

      await jobsReconcile.runStartup({
        recoveryCoordinator,
        namespace: identity.namespace,
        bundleHash: identity.bundleHash,
        runtime,
        progressStore,
        providerRegistry,
        getRecoveryService,
        createCallerContext,
        assertStartupStillActive,
        log: identity.log,
        cleanupStaleJobs,
      });
      assertStartupStillActive();

      const recoveredDiscussResumes = await recoverPersistedDiscussFn({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createCallerContext,
        assertStartupStillActive,
      });
      assertStartupStillActive();

      await workflowRecover.resumeAll({
        db,
        progressStore,
        getExecutionService: (ctx) => getExecutionService(ctx) as never,
        createCallerContext,
      });
      assertStartupStillActive();

      return recoveredDiscussResumes;
    },
    acquireLockFn: async (_pluginRoot, instanceId, version, bundleHash, flavor) => {
      await acquireLock(flavor, bundleHash, {
        instanceId,
        version,
        runtime,
      });
    },
    removeLockIfOwnerFn: (_pluginRoot, instanceId) => {
      releaseLock(instanceId, runtime);
    },
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
