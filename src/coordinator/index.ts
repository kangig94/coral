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
} from './spawn-observer.js';
import { createCoordinatorCore } from './composition/index.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from './composition/types.js';
import { createKbSubsystem } from '../kb/subsystem.js';
import type { CoordinatorServerInfo, LifecycleState } from './lifecycle.js';
import { ExecutionService } from './execution-service.js';
import { commit as commitJournalEvents, type CommitEventsFn } from '../store/append.js';
import { persistCorpusState as persistCorpusStateInDb } from '../kb/state/corpus-state.js';
import { openBackendStoreDb } from '../store/db.js';
import { createDefaultUpcasterRegistry } from '../store/upcaster-registry.js';
import { readJobProgress, loadJobProjectionDetail } from '../jobs/read-queries.js';
import { createProjectionSessionLookup } from '../sessions/lookup.js';
import { composeReducers } from '../store/reducers.js';
import { publishJobEvents, subscribeJobEvents } from '../jobs/shell/event-subscription.js';
import { jobsReconcile } from '../jobs/startup.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { discussRegistry } from '../discuss/event-registry.js';
import { workflowRegistry } from '../workflow/events.js';
import { registerJournalProjectionConsumer } from '../store/projection-consumer.js';
import { workflowRecover } from '../workflow/recover.js';
import { ConsumerDriver } from './consumer-driver.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import { releaseLock, acquireLock, CONTENDER_BUDGET } from './lock.js';
import type { KbRuntime } from '../kb/contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import { createHostFactory } from './expansion/host-factory.js';
import { ExpansionLifecycleService } from './expansion/lifecycle.js';
import { ExpansionStateStore } from './expansion/state.js';
import { createWorkflowRecoveryFinalizer } from './services/workflow-recovery-finalizer.js';

export type CoordinatorServerOptions = Omit<CoordinatorCoreOptions, 'runtime' | 'runStartupRecoveryFn'> & {
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
  const upcasters = createDefaultUpcasterRegistry();
  const readCtx = { schemas: reducers.schemas, upcasters };
  let storeDb: ReturnType<typeof openBackendStoreDb> | null = null;
  let consumerDriver: ConsumerDriver | null = null;
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
  const expansionLifecycleService = new ExpansionLifecycleService({
    makeHost: (id, scope, tier) => {
      const kbRuntime = currentKbRuntime;
      if (kbRuntime === null) {
        throw documentedCoralSetupError('expansion_runtime_unavailable', { name: id });
      }

      return createHostFactory({
        runtime,
        kbRuntime,
        consumerDriver: getConsumerDriver(),
      })(id, scope, tier);
    },
    state: new ExpansionStateStore(getStoreDb()),
    now: () => nowDate(runtime.time).toISOString(),
    resolveKbRuntime: () => currentKbRuntime,
  });

  const getCurrentJournalSeq = () =>
    (getQueryDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const getSessionLookup = () => createProjectionSessionLookup(getQueryDb());

  const coordinatorCommit: CommitEventsFn = (cb) => {
    const db = getStoreDb();
    const appended = commitJournalEvents(db, cb, {
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
  const core = createCoordinatorCore({
    ...coreOptions,
    runtime,
    expansionLifecycleService,
    createKbSubsystemFn: async (ctx) => {
      const kbSubsystem = await (providedCreateKbSubsystemFn ?? createKbSubsystem)({
        ...ctx,
        db: getStoreDb(),
        flavor,
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
      // Boot step 3: replay installed-tier rows + apply bundled fallback to fill empty bindings.
      await expansionLifecycleService.recoverOnBoot();
      // Boot step 4: replay the persisted corpus snapshot into downstream consumers.
      const corpusSnapshot = kbSubsystem.kb.getCorpusStateSnapshot();
      driver.notifyCorpus(corpusSnapshot);
      await driver.waitFreshUntil(
        'corpus',
        corpusSnapshot,
        kbSubsystem.kb.fts.read().consumer.id,
        bootFreshnessTimeoutMs,
      );
      if (kbSubsystem.curateScheduler) {
        // Boot step 5: start background curation only after the read projections are aligned.
        await kbSubsystem.curateScheduler.start();
      }
      return kbSubsystem;
    },
    createExecutionService: (ctx, deps) => {
      const wiredDeps = {
        ...deps,
        coordinatorCommit,
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
      if (readiness === 'base-search') {
        await driver.waitFreshUntil('corpus', snapshot, kb.fts.read().consumer.id, bootFreshnessTimeoutMs);
        return;
      }

      if (readiness === 'active-vector') {
        const vectorBacked = kb.vector.read();
        await driver.waitFreshUntil('corpus', snapshot, vectorBacked.consumer.id, bootFreshnessTimeoutMs);
        return;
      }

      const vectorBacked = kb.vector.read();
      await driver.waitFreshUntil('corpus', snapshot, vectorBacked.consumer.id, bootFreshnessTimeoutMs);
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
        finalizeWorkflow: createWorkflowRecoveryFinalizer({
          runtime,
          progressStore,
          coordinatorCommit,
          log: identity.log,
        }),
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
