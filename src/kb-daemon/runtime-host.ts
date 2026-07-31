declare const __VERSION__: string;

import { readBuildFlavor, readBundleHash } from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { nowDate } from '../infra/time.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import { AbortError, throwIfAborted } from '../runtime/abort.js';
import { serializeCoralSetupError, type SerializedCoralSetupError } from '../runtime/errors.js';
import { createKbRuntime } from '../kb/runtime.js';
import { createCurateScheduler, type CurateHandle } from '../kb/curate/scheduler.js';
import type { CurateAssistantPort } from '../kb/curate/assistant.js';
import type { CurateUsageBudgetPort } from '../kb/curate/usage-budget.js';
import { runCommunitySummaryAgent } from '../kb/curate/community/summary-agent.js';
import { runPromoteRecovery } from '../kb/ops/promote-recovery.js';
import { cleanupSourceImportRuntimeArtifacts } from '../kb/ops/source/import.js';
import type { Backed, FtsRetrieval, KbCorpusPublication, KbRuntime } from '../kb/contract.js';
import { KB_FTS_CAPABILITY } from '../kb/capability/constants.js';
import { persistCorpusState } from '../kb/state/corpus-state.js';
import type { KbDaemonKbReadHealth } from './protocol.js';
import type { AppendedEvent } from '../store/append.js';
import { JobStore } from '../jobs/store.js';
import { noProviderLookupPort } from '../providers/catalog.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { AbortRegistry } from '../jobs/shell/abort-registry.js';
import {
  KbSourceImportService,
  parseKbSourceImportRequest,
  type KbSourceImportReadinessWaiter,
} from './services/source-import.js';
import { KbReindexService } from './services/reindex.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { kbError, type KbToolResult } from '../kb/result.js';
import { ConsumerDriver } from '../projection-consumers/index.js';
import { createHostFactory } from './expansion/host-factory.js';
import { createExpansionRpc } from './expansion/rpc.js';
import { createLifecycleBundledLoaders } from './expansion/bundled-loaders.js';
import {
  createOramaProjectionReconcileRequester,
  repairProjectionArtifactLagOnBoot,
} from './expansion/projection-reconcile.js';
import { startKiwiArtifactFetchOnBoot } from './expansion/kiwi-boot.js';
import { ExpansionLifecycleService, type CoordinatorLifecyclePhase } from './expansion/lifecycle.js';
import { ExpansionStateStore } from './expansion/state.js';
import { createExpansionManifestCatalog } from '../expansion/manifest/catalog.js';
import { INSTALL_ONLY_PACKAGES } from '../expansion/install-only.js';
import { initializeCapabilityCatalog } from '../expansion/manifest/fills-validation.js';
import { resolveKiwiSearchAnalyzerPort, type KiwiSearchAnalyzerPort } from './expansion/bundled-loaders.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
} from '../kb/capability/constants.js';
import { parsePrincipalWire } from '../security/principal-wire.js';
import { waitForCorpusReadiness } from './services/readiness.js';
import { openWritableStoreDbNoReset, type Database } from '../store/db.js';
import { currentCoralStoreFormat } from '../store-format.js';
import type { KbDaemonExpansionRequest, KbDaemonExpansionResult } from './protocol.js';
import { cleanupRetiredExpansion } from './expansion/retirement.js';

type KbDaemonWriteRuntimeOptions = {
  pluginRoot: string;
  backendNamespace?: string;
  bundleHash?: string;
  runtime?: Runtime;
  db?: WritableDatabase;
  version?: string;
  now?: () => number;
  curateAssistant?: CurateAssistantPort;
  curateUsageBudget: CurateUsageBudgetPort;
  onJournalEvents?: (appended: readonly AppendedEvent[]) => void;
  onCorpusMutation?: (publication: KbCorpusPublication) => void;
  kiwiAnalyzer?: KiwiSearchAnalyzerPort;
};

type WritableStatement<TParams extends unknown[] = unknown[], TRow = unknown> = {
  get(...params: TParams): TRow | undefined;
  all(...params: TParams): TRow[];
  iterate(...params: TParams): IterableIterator<TRow>;
  run(...params: TParams): { changes: number | bigint };
};

type WritableDatabase = {
  exec(sql: string): void;
  prepare<TParams extends unknown[] = unknown[], TRow = unknown>(sql: string): WritableStatement<TParams, TRow>;
  close(): void;
};

type KbDaemonWriteRuntimeState = {
  runtime: Runtime;
  db: WritableDatabase;
  ownsDb: boolean;
  kbRuntime: DaemonKnowledgeBaseRuntime;
  consumerDriver: ConsumerDriver;
  expansionLifecycleService: ExpansionLifecycleService;
  sourceImportService: KbSourceImportService;
  reindexService: KbReindexService;
  abortRegistry: AbortRegistry;
};

const DEFAULT_DAEMON_CORPUS_READINESS_TIMEOUT_MS = 90_000;
const DEFAULT_DAEMON_JOB_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_DAEMON_MUTATION_LOCK_DRAIN_TIMEOUT_MS = DEFAULT_DAEMON_JOB_DRAIN_TIMEOUT_MS;
const DAEMON_JOB_DRAIN_POLL_MS = 25;
const BUILTIN_CAPABILITY_DESCRIPTORS = [
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
] as const;

type DaemonKnowledgeBaseRuntime = {
  kb: KbRuntime;
  readDb: Pick<WritableDatabase, 'prepare' | 'close'>;
  curateScheduler: CurateHandle;
};

export type KbDaemonWriteRuntimeHost = {
  withKb<T>(fn: (state: KbDaemonWriteRuntimeState) => Promise<T> | T): Promise<T>;
  warmSearchRuntime(): void;
  searchReadiness(): KbDaemonSearchRuntimeReadiness;
  createSource(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  reindex(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  expansionRpc(request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult>;
  listActiveJobs(): string[];
  abortJobs(jobIds: string[]): { aborted: string[]; notFound: string[] };
  dispose(options?: { signal?: AbortSignal }): Promise<void>;
  health(): KbDaemonKbReadHealth;
};

type KbDaemonSearchRuntimeReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | 'write_runtime_not_initialized'
        | 'write_runtime_initializing'
        | 'write_runtime_unavailable'
        | 'fts_binding_unavailable'
        | 'kiwi_analyzer_unloaded'
        | 'kiwi_analyzer_loading'
        | 'kiwi_analyzer_evicting';
      message: string;
      detail?: Record<string, unknown>;
      setupError?: SerializedCoralSetupError;
    };

function createUnavailableCurateAssistant(): CurateAssistantPort {
  return {
    async complete() {
      throw new Error('KB daemon curate assistant was not configured.');
    },
  };
}

function resolveVersion(version: string | undefined): string {
  if (version !== undefined) {
    return version;
  }
  return typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0';
}

function resolveDaemonCorpusReadinessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return DEFAULT_DAEMON_CORPUS_READINESS_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAEMON_CORPUS_READINESS_TIMEOUT_MS;
}

function notifyDaemonCorpus(driver: ConsumerDriver | null, publication: KbCorpusPublication): void {
  if (driver === null) {
    return;
  }
  if (publication.changedLanes.length === 1) {
    driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
    return;
  }
  driver.notifyCorpus(publication.snapshot);
}

function notifyDaemonCorpusDeferred(getDriver: () => ConsumerDriver | null, publication: KbCorpusPublication): void {
  const deferredPublication: KbCorpusPublication = {
    snapshot: { ...publication.snapshot },
    changedLanes: [...publication.changedLanes],
  };
  void Promise.resolve().then(() => {
    notifyDaemonCorpus(getDriver(), deferredPublication);
  });
}

function expansionRpcError(error: unknown): KbDaemonExpansionResult {
  const setupError = serializeCoralSetupError(error);
  if (setupError !== null) {
    return {
      ok: false,
      code: setupError.code,
      message: setupError.userMessage,
      remediation: setupError.remediation,
      ...(setupError.context === undefined ? {} : { detail: setupError.context }),
      setupError,
    };
  }

  const detail = error instanceof Error ? { message: error.message } : error;
  return kbError('kb_error', errorMessage(error), detail);
}

function waitAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, stage: string): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  throwIfAborted(signal, stage);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError({ stage, reason: signal.reason }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function drainAbortRegistry(
  runtime: Pick<Runtime, 'time'>,
  abortRegistry: AbortRegistry,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DAEMON_JOB_DRAIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DAEMON_JOB_DRAIN_POLL_MS;
  const deadline = runtime.time.now() + timeoutMs;
  while (abortRegistry.listActive().length > 0) {
    if (options.signal?.aborted) {
      throw new AbortError({ stage: 'kb_daemon_job_drain', reason: options.signal.reason });
    }
    if (runtime.time.now() >= deadline) {
      throw new Error(`Timed out waiting for ${abortRegistry.listActive().length} active KB job(s) to stop.`);
    }
    await runtime.time.sleep(pollMs, { signal: options.signal });
  }
}

async function drainCorpusMutationLock(
  kb: KbRuntime,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  await kb.withMutationLock(() => undefined, {
    timeoutMs: options.timeoutMs ?? DEFAULT_DAEMON_MUTATION_LOCK_DRAIN_TIMEOUT_MS,
    signal: options.signal,
  });
}

type KiwiArtifactBootTaskOwner = {
  start(): AbortController;
  track(controller: AbortController, completed: Promise<void> | null): void;
  abort(controller: AbortController): void;
  abortCurrent(): void;
};

function createKiwiArtifactBootTaskOwner(): KiwiArtifactBootTaskOwner {
  let current: AbortController | null = null;
  const clear = (controller: AbortController): void => {
    if (current === controller) {
      current = null;
    }
  };
  const abort = (controller: AbortController): void => {
    controller.abort();
    clear(controller);
  };
  return {
    start() {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      return controller;
    },
    track(controller, completed) {
      if (completed === null) {
        clear(controller);
        return;
      }
      void completed.then(
        () => clear(controller),
        () => clear(controller),
      );
    },
    abort,
    abortCurrent() {
      if (current !== null) {
        abort(current);
      }
    },
  };
}

export function createKbDaemonWriteRuntimeHost(options: KbDaemonWriteRuntimeOptions): KbDaemonWriteRuntimeHost {
  const now = options.now ?? Date.now;
  let phase: KbDaemonKbReadHealth['phase'] = 'not_initialized';
  let initializedAt: number | undefined;
  let lastError: string | undefined;
  let lastSetupError: SerializedCoralSetupError | undefined;
  let state: KbDaemonWriteRuntimeState | null = null;
  let initPromise: Promise<KbDaemonWriteRuntimeState> | null = null;
  let disposePromise: Promise<void> | null = null;
  let searchWarmupPromise: Promise<void> | null = null;
  let lastSearchWarmupError: string | undefined;
  let lastSearchWarmupSetupError: SerializedCoralSetupError | undefined;
  const kiwiAnalyzerManager = options.kiwiAnalyzer ?? resolveKiwiSearchAnalyzerPort();
  // Cancels the post-fetch Korean (Kiwi) re-tokenization reproject when the daemon
  // disposes; an in-flight artifact download runs to completion detached.
  const kiwiArtifactBootTasks = createKiwiArtifactBootTaskOwner();

  const markReady = (): void => {
    phase = 'ready';
    initializedAt ??= now();
    lastError = undefined;
    lastSetupError = undefined;
  };
  const markFailure = (error: unknown): void => {
    phase = 'failed';
    lastError = errorMessage(error);
    lastSetupError = serializeCoralSetupError(error) ?? undefined;
  };
  const markDisposing = (): void => {
    phase = 'disposing';
  };
  const markDisposed = (): void => {
    phase = 'disposed';
    lastError = undefined;
    lastSetupError = undefined;
  };
  const getExpansionLifecyclePhase = (): CoordinatorLifecyclePhase => {
    if (phase === 'disposing') {
      return 'draining';
    }
    if (phase === 'disposed') {
      return 'stopped';
    }
    // The expansion lifecycle speaks coordinator phases. Healthy daemon write
    // phases, including `ready`, must map to `running` or normal equips are
    // rejected by the drain fence.
    return 'running';
  };
  const disposedError = (): KbToolResult => kbError('kb_unavailable', `KB daemon write runtime is ${phase}.`);

  const build = async (): Promise<KbDaemonWriteRuntimeState> => {
    const buildKiwiArtifactBootController = kiwiArtifactBootTasks.start();
    const runtime = options.runtime ?? createRealRuntime(readBuildFlavor(options.pluginRoot));
    const ownsDb = options.db === undefined;
    let db: WritableDatabase | null = null;
    let consumerDriver: ConsumerDriver | null = null;
    let expansionLifecycleService: ExpansionLifecycleService | null = null;
    let daemonConsumerDriver: ConsumerDriver | null = null;

    try {
      db =
        options.db ??
        (openWritableStoreDbNoReset(runtime, {
          storeFormat: currentCoralStoreFormat(),
        }) as unknown as WritableDatabase);
      const activeDb = db;
      const backendNamespace = options.backendNamespace ?? pluginRootNamespace(options.pluginRoot);
      const bundleHash = options.bundleHash ?? readBundleHash(options.pluginRoot);
      const markdownRoot = runtime.paths.coral.corpus.kbRoot;
      const runtimeDir = runtime.paths.coral.kbRuntime.root;
      cleanupSourceImportRuntimeArtifacts(runtimeDir, runtime);
      const curateAssistant = options.curateAssistant ?? createUnavailableCurateAssistant();
      const abortRegistry = new AbortRegistry(runtime.ids);
      const progressStore = new JobStore(backendNamespace, runtime, createEventBodyCodec(), {
        db: activeDb as ConstructorParameters<typeof JobStore>[3]['db'],
        providers: noProviderLookupPort,
        observer: (appended) => options.onJournalEvents?.(appended),
      });
      let kbRef: KbRuntime | null = null;
      const kb = createKbRuntime({
        markdownRoot,
        runtimeDir,
        version: resolveVersion(options.version),
        db: activeDb as Parameters<typeof createKbRuntime>[0]['db'],
        envPort: runtime.env,
        time: runtime.time,
        ids: runtime.ids,
        storage: runtime.storage,
        curateAssistant,
        processPort: runtime.process,
        corpusPublishCallbacks: {
          persistCorpusState: (snapshot) =>
            persistCorpusState(activeDb as Database, snapshot, {
              now: () => nowDate(runtime.time),
            }),
          // The parent observes successful daemon mutations from the persisted
          // corpus-state row; the daemon also wakes its local projection driver.
          notifyCorpusMutation: (publication) => {
            notifyDaemonCorpusDeferred(() => daemonConsumerDriver, publication);
            options.onCorpusMutation?.(publication);
          },
        },
        generatedCommunityProjectionCallbacks: {
          notifyGeneratedCommunityProjection: async (publication) => {
            const activeKb = kbRef;
            const driver = daemonConsumerDriver;
            if (activeKb === null || driver === null) {
              return;
            }
            activeKb.invalidateTextSnapshot('generated-community-projection');
            await activeKb.ensureCorpusFreshness({ wait: true });
            const descriptors = await activeKb.engineArtifactRegistry.describeArtifacts();
            const targetConsumerIds: string[] = [];
            const seen = new Set<string>();
            for (const descriptor of descriptors) {
              if (descriptor.projectsGeneratedCommunityDocs !== true) {
                continue;
              }
              for (const consumerId of descriptor.targetConsumerIds) {
                if (seen.has(consumerId)) {
                  continue;
                }
                seen.add(consumerId);
                targetConsumerIds.push(consumerId);
              }
            }
            if (targetConsumerIds.length === 0) {
              return;
            }
            driver.forceCorpusApply(publication.snapshot, {
              reason: 'projection-artifact-lag',
              consumers: targetConsumerIds,
              generatedCommunityFreshness: {
                generatedCommunityGeneration: publication.generatedCommunityGeneration,
                generatedCommunityDocsHash: publication.generatedCommunityDocsHash,
              },
            });
          },
        },
      });
      kbRef = kb;
      const activeConsumerDriver = new ConsumerDriver({
        db: activeDb as Database,
        now: () => nowDate(runtime.time),
        time: runtime.time,
        corpusProjectionReader: {
          resolveCurrentIndex: () => kb.corpusProjectionReader.resolveCurrentIndex(),
          prepareCurrentProjectionInput: (input) => kb.corpusProjectionReader.prepareCurrentProjectionInput(input),
        },
        onTextProjectionSync: () => {
          kb.recordIndexSyncSuccess();
        },
      });
      consumerDriver = activeConsumerDriver;
      daemonConsumerDriver = activeConsumerDriver;
      const corpusReadinessTimeoutMs = resolveDaemonCorpusReadinessTimeoutMs(runtime);
      const oramaProjectionReconcileRequester = createOramaProjectionReconcileRequester({
        kb,
        driver: activeConsumerDriver,
      });
      const manifestCatalog = createExpansionManifestCatalog({
        db: activeDb as Database,
        now: () => nowDate(runtime.time).toISOString(),
      });
      initializeCapabilityCatalog(
        kb.capabilityRegistry,
        manifestCatalog.listManifests(),
        BUILTIN_CAPABILITY_DESCRIPTORS,
      );
      const expansionStateStore = new ExpansionStateStore(activeDb as Database);
      const activeExpansionLifecycleService = new ExpansionLifecycleService({
        makeHost: createHostFactory({
          runtime,
          kbRuntime: kb,
          consumerDriver: activeConsumerDriver,
        }),
        state: expansionStateStore,
        manifest: manifestCatalog.listManifests(),
        manifestCatalog,
        bundledLoaders: createLifecycleBundledLoaders({
          requestProjectionReconcile: oramaProjectionReconcileRequester.requestProjectionReconcile,
          requestKiwiDegradedReconcile: oramaProjectionReconcileRequester.requestKiwiDegradedReconcile,
        }),
        now: () => nowDate(runtime.time).toISOString(),
        resolveKbRuntime: () => kb,
        getLifecyclePhase: getExpansionLifecyclePhase,
        protectedPackageIds: new Set(INSTALL_ONLY_PACKAGES.map((entry) => entry.id)),
        retireCatalogAbsent: (name, finalizeState) =>
          cleanupRetiredExpansion(name, {
            runtime,
            kbRuntimeDir: kb.runtimeDir,
            manifestCatalog,
            consumerDriver: activeConsumerDriver,
            finalizeState,
          }),
      });
      expansionLifecycleService = activeExpansionLifecycleService;
      await runPromoteRecovery(kb);
      await kb.retryPendingCorpusPublication();
      await activeExpansionLifecycleService.recoverOnBoot();
      activeConsumerDriver.notifyCorpus(kb.getCorpusStateSnapshot());
      await repairProjectionArtifactLagOnBoot(kb, activeConsumerDriver, corpusReadinessTimeoutMs);
      // When CORAL_KB_EXTRA_LANGS declares 'ko', fetch the Kiwi runtime artifacts in the background and
      // reproject once it lands. Boot does not await this: the text lane serves Intl-segmented
      // results until the Korean analyzer is ready, so the first note mutation is never blocked
      // on the ~89MB artifact downloads or a corpus-scale Korean re-tokenization.
      const kiwiArtifactBootHandle = startKiwiArtifactFetchOnBoot({
        runtime,
        kb,
        driver: activeConsumerDriver,
        timeoutMs: corpusReadinessTimeoutMs,
        signal: buildKiwiArtifactBootController.signal,
      });
      kiwiArtifactBootTasks.track(buildKiwiArtifactBootController, kiwiArtifactBootHandle.completed);
      const kbRuntime: DaemonKnowledgeBaseRuntime = {
        kb,
        readDb: activeDb,
        curateScheduler: createCurateScheduler({
          kb,
          curateAssistant,
          processPort: runtime.process,
          storagePort: runtime.storage,
          envPort: runtime.env,
          usageBudget: options.curateUsageBudget,
          runCommunitySummaryJob: (signal) => runCommunitySummaryAgent(kb, curateAssistant, signal),
        }),
      };
      const waitForReadiness: KbSourceImportReadinessWaiter = async ({ kb, readiness, snapshot, signal }) => {
        activeConsumerDriver.notifyCorpus(snapshot);
        return waitForCorpusReadiness({
          kb,
          readiness,
          snapshot,
          timeoutMs: corpusReadinessTimeoutMs,
          waitFresh: ({ consumerId, snapshot: target, timeoutMs }) => {
            const generatedCommunityFreshness = kb.generatedCommunityProjectionStore.readActiveFreshness();
            return waitAbortable(
              activeConsumerDriver.waitFreshUntil(
                'corpus',
                {
                  snapshot: target,
                  atLeastGeneration: 0,
                  generatedCommunityGeneration: generatedCommunityFreshness.generatedCommunityGeneration,
                  generatedCommunityDocsHash: generatedCommunityFreshness.generatedCommunityDocsHash,
                },
                consumerId,
                timeoutMs,
              ),
              signal,
              `kb_readiness:${readiness}`,
            );
          },
        });
      };
      const sourceImportService = new KbSourceImportService({
        runtime,
        progressStore,
        backendNamespace,
        bundleHash,
        waitForReadiness,
        abortRegistry,
        internalJobOwner: 'kb-daemon',
      });
      const reindexService = new KbReindexService({
        runtime,
        progressStore,
        backendNamespace,
        bundleHash,
        waitForReadiness,
        abortRegistry,
        internalJobOwner: 'kb-daemon',
      });
      state = {
        runtime,
        db: activeDb,
        ownsDb,
        kbRuntime,
        consumerDriver: activeConsumerDriver,
        expansionLifecycleService: activeExpansionLifecycleService,
        sourceImportService,
        reindexService,
        abortRegistry,
      };
      markReady();
      return state;
    } catch (error: unknown) {
      kiwiArtifactBootTasks.abort(buildKiwiArtifactBootController);
      daemonConsumerDriver = null;
      await expansionLifecycleService?.shutdownActiveExpansions().catch(() => undefined);
      await consumerDriver?.shutdown({ drainTimeoutMs: 0 }).catch(() => undefined);
      if (ownsDb && db !== null) {
        try {
          db.close();
        } catch {
          // Preserve the initialization error; a failed cleanup is secondary.
        }
      }
      throw error;
    }
  };

  const init = async (): Promise<KbDaemonWriteRuntimeState> => {
    if (phase === 'disposing' || phase === 'disposed') {
      throw new Error(`KB daemon write runtime is ${phase}.`);
    }
    if (state !== null) {
      markReady();
      return state;
    }
    if (initPromise !== null) {
      return initPromise;
    }
    initPromise = build()
      .catch((error: unknown) => {
        markFailure(error);
        throw error;
      })
      .finally(() => {
        initPromise = null;
      });
    return initPromise;
  };

  const assertFtsBindingReady = (activeState: KbDaemonWriteRuntimeState): KbDaemonSearchRuntimeReadiness | null => {
    try {
      activeState.kbRuntime.kb.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).read();
      return null;
    } catch (error: unknown) {
      const setupError = serializeCoralSetupError(error);
      return {
        ready: false,
        reason: 'fts_binding_unavailable',
        message: 'KB search runtime is not ready: FTS capability is not bound.',
        detail: { error: errorMessage(error) },
        ...(setupError === null ? {} : { setupError }),
      };
    }
  };

  const searchReadiness = (): KbDaemonSearchRuntimeReadiness => {
    const activeState = state;
    if (activeState === null) {
      if (initPromise !== null) {
        return {
          ready: false,
          reason: 'write_runtime_initializing',
          message: 'KB search runtime is still warming.',
        };
      }
      return {
        ready: false,
        reason: phase === 'not_initialized' ? 'write_runtime_not_initialized' : 'write_runtime_unavailable',
        message: `KB search runtime is not ready: write runtime is ${phase}.`,
        ...(lastSearchWarmupSetupError === undefined ? {} : { setupError: lastSearchWarmupSetupError }),
        ...(lastSearchWarmupError === undefined ? {} : { detail: { lastSearchWarmupError } }),
      };
    }

    const ftsReadiness = assertFtsBindingReady(activeState);
    if (ftsReadiness !== null) {
      return ftsReadiness;
    }

    const analyzerReadiness = kiwiAnalyzerManager.leaseReadiness(
      activeState.runtime,
      activeState.kbRuntime.kb.declaredAnalyzers,
    );
    if (!analyzerReadiness.ready) {
      return {
        ready: false,
        reason: `kiwi_analyzer_${analyzerReadiness.state}`,
        message: `KB search runtime is not ready: Kiwi analyzer is ${analyzerReadiness.state}.`,
        ...(lastSearchWarmupSetupError === undefined ? {} : { setupError: lastSearchWarmupSetupError }),
        ...(analyzerReadiness.reason === undefined && lastSearchWarmupError === undefined
          ? {}
          : {
              detail: {
                ...(analyzerReadiness.reason === undefined ? {} : { analyzerReason: analyzerReadiness.reason }),
                ...(lastSearchWarmupError === undefined ? {} : { lastSearchWarmupError }),
              },
            }),
      };
    }

    return { ready: true };
  };

  const warmSearchRuntime = (): void => {
    if (searchWarmupPromise !== null || phase === 'disposing' || phase === 'disposed') {
      return;
    }

    searchWarmupPromise = init()
      .then(async (activeState) => {
        if (activeState.kbRuntime.kb.declaredAnalyzers.includes('ko')) {
          await kiwiAnalyzerManager.withAnalyzerLease(
            activeState.runtime,
            activeState.kbRuntime.kb.declaredAnalyzers,
            () => undefined,
          );
        }
        lastSearchWarmupError = undefined;
        lastSearchWarmupSetupError = undefined;
      })
      .catch((error: unknown) => {
        lastSearchWarmupError = errorMessage(error);
        lastSearchWarmupSetupError = serializeCoralSetupError(error) ?? undefined;
      })
      .finally(() => {
        searchWarmupPromise = null;
      });
  };

  const disposeState = async (
    activeState: KbDaemonWriteRuntimeState,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    let cleanupError: unknown;
    let closeError: unknown;
    try {
      try {
        const activeJobs = activeState.abortRegistry.listActive();
        if (activeJobs.length > 0) {
          activeState.abortRegistry.abort(activeJobs);
          await drainAbortRegistry(activeState.runtime, activeState.abortRegistry, { signal });
        }
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      try {
        await activeState.kbRuntime.curateScheduler.stop();
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      try {
        // Queue behind any corpus writer before the owned SQLite handle closes;
        // the timeout bounds peer directory-lock contention during shutdown.
        await drainCorpusMutationLock(activeState.kbRuntime.kb, { signal });
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      try {
        await activeState.expansionLifecycleService.shutdownActiveExpansions({ signal });
      } catch (error: unknown) {
        cleanupError ??= error;
      }
      try {
        await activeState.consumerDriver.shutdown({ drainTimeoutMs: 0 });
      } catch (error: unknown) {
        cleanupError ??= error;
      }
    } finally {
      state = null;
      if (activeState.ownsDb) {
        try {
          activeState.db.close();
        } catch (error: unknown) {
          closeError = error;
        }
      }
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error ? cleanupError : new Error(errorMessage(cleanupError));
    }
    if (closeError !== undefined) {
      throw closeError instanceof Error ? closeError : new Error(errorMessage(closeError));
    }
  };

  const dispose = async (options: { signal?: AbortSignal } = {}): Promise<void> => {
    if (disposePromise !== null) {
      return disposePromise;
    }
    disposePromise = (async () => {
      markDisposing();
      kiwiArtifactBootTasks.abortCurrent();
      try {
        let activeState = state;
        if (activeState === null && initPromise !== null) {
          try {
            activeState = await initPromise;
          } catch {
            markDisposed();
            return;
          }
        }
        kiwiArtifactBootTasks.abortCurrent();
        if (activeState !== null) {
          await disposeState(activeState, options.signal);
        }
        markDisposed();
      } catch (error: unknown) {
        markFailure(error);
        throw error;
      }
    })().finally(() => {
      disposePromise = null;
    });
    return disposePromise;
  };

  return {
    async withKb(fn) {
      const initialized = await init();
      return fn(initialized);
    },
    warmSearchRuntime,
    searchReadiness,
    async createSource(args, ctx) {
      if (phase === 'disposing' || phase === 'disposed') {
        return disposedError();
      }
      const parsed = parseKbSourceImportRequest(args);
      if (!parsed.ok) {
        return kbError('invalid_request', parsed.message);
      }
      const initialized = await init();
      initialized.kbRuntime.kb.invalidateKbCache();
      await initialized.kbRuntime.kb.ensureCorpusFreshness({ wait: true });
      return initialized.sourceImportService.start(parsed.data, ctx, initialized.kbRuntime);
    },
    async reindex(args, ctx) {
      if (phase === 'disposing' || phase === 'disposed') {
        return disposedError();
      }
      const initialized = await init();
      initialized.kbRuntime.kb.invalidateKbCache();
      await initialized.kbRuntime.kb.ensureCorpusFreshness({ wait: true });
      return initialized.reindexService.run({ async: args.async === true }, ctx, initialized.kbRuntime);
    },
    async expansionRpc(request) {
      if (phase === 'disposing' || phase === 'disposed') {
        return disposedError();
      }
      try {
        const initialized = await init();
        const rpc = createExpansionRpc(initialized.expansionLifecycleService);
        const principal = parsePrincipalWire(request.ctx.principal, {
          transport: 'kb-daemon',
          credential: { kind: 'daemon-rpc', id: 'expansion-runtime' },
        });
        if (principal === null) {
          return kbError('invalid_request', 'Malformed KB daemon expansion principal.');
        }
        switch (request.method) {
          case 'equipExpansion':
            return { ok: true, data: await rpc.equipExpansion(request.args as never, principal) };
          case 'unequipExpansion':
            return { ok: true, data: await rpc.unequipExpansion(request.args as never, principal) };
          case 'removeExpansionCatalog':
            return { ok: true, data: await rpc.removeExpansionCatalog(request.args as never, principal) };
          case 'listExpansion':
            return { ok: true, data: await rpc.listExpansion((request.args ?? {}) as never, principal) };
          case 'readBinding':
            return { ok: true, data: await rpc.readBinding(request.args as never, principal) };
          default:
            return kbError('invalid_request', `Unknown expansion method: ${String(request.method)}`);
        }
      } catch (error: unknown) {
        return expansionRpcError(error);
      }
    },
    abortJobs(jobIds) {
      const activeState = state;
      if (activeState === null) {
        return { aborted: [], notFound: [...jobIds] };
      }
      return activeState.abortRegistry.abort(jobIds);
    },
    listActiveJobs() {
      const activeState = state;
      return activeState === null ? [] : activeState.abortRegistry.listActive();
    },
    dispose,
    health() {
      const activeState = state;
      const mutationDiagnostics = activeState?.kbRuntime.kb.mutationLockDiagnostics();
      const mutationBlocked =
        mutationDiagnostics?.blocked === true
          ? {
              owner: mutationDiagnostics.owner,
              ageMs: mutationDiagnostics.ageMs,
              signaledAtMs: mutationDiagnostics.signaledAtMs,
            }
          : undefined;
      const healthLastError = lastError ?? lastSearchWarmupError;
      const healthSetupError = lastSetupError ?? lastSearchWarmupSetupError;
      return {
        phase,
        ...(initializedAt === undefined ? {} : { initializedAt }),
        ...(healthLastError === undefined ? {} : { lastError: healthLastError }),
        ...(healthSetupError === undefined ? {} : { setupError: healthSetupError }),
        ...(activeState === null ? {} : { curateRunning: activeState.kbRuntime.curateScheduler.isRunning() }),
        ...(mutationBlocked === undefined ? {} : { mutationBlocked }),
      };
    },
  };
}
