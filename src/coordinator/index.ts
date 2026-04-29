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
import { workflowRecover } from '../workflow/recover.js';
import { resolveDrainDeadlineMs } from '../workflow/execution-constants.js';
import { resolveStaleAbortTimeoutMs } from '../workflow/stale-recovery.js';
import { ConsumerDriver } from './consumer-driver.js';
import { createCoordinatorCurateScheduler, createCurateSchedulerHealthBridge } from './live/curate-scheduler.js';
import { releaseLock, acquireLock, CONTENDER_BUDGET } from './lock.js';
import type { KbCorpusSnapshot, KbRuntime } from '../kb/contract.js';
import type { SourceImportReadiness } from '../jobs/launch.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import { createHostFactory } from './expansion/host-factory.js';
import { ExpansionLifecycleService } from './expansion/lifecycle.js';
import { ExpansionStateStore } from './expansion/state.js';
import { createWorkflowRecoveryFinalizer } from './services/workflow-recovery-finalizer.js';
import { assertDescriberCoverage } from '../read-model/event-describers.js';

export type CoordinatorServerOptions = Omit<
  CoordinatorCoreOptions,
  'runtime' | 'runStartupRecoveryFn' | 'getConsumerStuck' | 'getMutationBlocked'
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

function resolveBootFreshnessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return CONTENDER_BUDGET;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CONTENDER_BUDGET;
}

// Bundled Orama always binds kb.fts; engines like needle bind kb.vector when
// equipped. Unbound bindings throw 'binding_empty' from `read()` — catch and
// skip so 'all-equipped' is best-effort over what's currently equipped.
export function readBoundCorpusConsumerIds(kb: Pick<KbRuntime, 'fts' | 'vector'>): string[] {
  const corpusBindings = [kb.fts, kb.vector] as const;
  const ids: string[] = [];
  for (const binding of corpusBindings) {
    try {
      ids.push(binding.read().consumer.id);
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
  kb: Pick<KbRuntime, 'fts' | 'vector'>;
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
        consumerId = kb.fts.read().consumer.id;
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
        consumerId = kb.vector.read().consumer.id;
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
      await Promise.all(
        corpusConsumerIds.map((consumerId) => waitFresh({ consumerId, snapshot, timeoutMs })),
      );
      return;
    }
  }
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
  // Spec §7.1: every Journal event type can be a causeRef target. Verify
  // describer coverage at boot so missing describers fail loudly instead of
  // rendering causeRef chains as bare type names.
  assertDescriberCoverage(reducers.describerKeys);
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
  let resolveLifecyclePhase: (() => 'starting' | 'running' | 'draining' | 'stopped') | null = null;
  // Spec §12.3 lazy non-blocking rescan: shutdown aborts any pending background
  // rebuild kicks so a draining instance does not start fresh KB work. Boot's
  // blocking `wait: true` on the next coordinator picks up the staleness.
  const corpusRescanAbort = new AbortController();
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
    getLifecyclePhase: () => resolveLifecyclePhase?.() ?? 'starting',
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
    getConsumerStuck: () => getConsumerDriver().stuckConsumers(),
    // Phase 3 stub. Phase 4 replaces with the real KbRuntime
    // mutation-lock diagnostics so /health.subsystems.kb.mutationBlocked
    // reports stuck mutations.
    getMutationBlocked: () => ({ blocked: false }),
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
      // Boot uses the blocking variant — downstream consumer apply must see
      // a fresh index. Subsequent KB read paths use the non-blocking lazy
      // variant (spec §12.3); the abort signal stops post-boot rebuilds when
      // shutdown drains.
      await kbSubsystem.kb.ensureCorpusFreshness({ wait: true, signal: corpusRescanAbort.signal });
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
        drainDeadlineMs: resolveDrainDeadlineMs(runtime.env),
        staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(runtime.env),
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
  resolveLifecyclePhase = () => core.runtimeState.getLifecycle();

  return {
    server: core.server,
    start: () => core.lifecycleController.start(),
    shutdown: (reason) => {
      corpusRescanAbort.abort();
      return core.lifecycleController.shutdown(reason);
    },
    waitForShutdown: async () => {
      await core.lifecycleController.waitForShutdown();
      corpusRescanAbort.abort();
      await consumerDriver?.shutdown();
      storeDb?.close();
      consumerDriver = null;
      storeDb = null;
    },
    getLifecycle: () => core.runtimeState.getLifecycle(),
    getIdleTimer: () => core.idleTimer,
  };
}
