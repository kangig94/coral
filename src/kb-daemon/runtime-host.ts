import { renderWorkflowReport } from '../workflow/result-report.js';
declare const __VERSION__: string;

import { dirname } from 'node:path';
import { readBuildFlavor, readBundleHash } from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { backendLog } from '../infra/backend-log.js';
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
import { JobLocationIndex } from '../jobs/location-index.js';
import { deriveLaunchReadiness } from '../jobs/launch-readiness.js';
import { observeTerminalResultExports, resultPathFor } from '../jobs/terminal/export.js';
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
import type { Database } from '../store/db.js';
import {
  encodeResolvedStoreEpoch,
  openWritableStoreDbNoReset,
  resolveCurrentStore,
  type ResolvedStoreEpoch,
} from '../store/epoch/index.js';
import {
  fenceCorpusStorage,
  joinSuccessionWriterGeneration,
  type SuccessionWriterEntitlement,
  type SuccessionWriterGeneration,
} from '../store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '../store-format.js';
import type { KbDaemonExpansionRequest, KbDaemonExpansionResult } from './protocol.js';
import { cleanupRetiredExpansion } from './expansion/retirement.js';
import {
  generationMutationCoordinationSeam,
  type GenerationWriterLease,
} from '../store/generation-mutation-coordination.js';

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
  store?: ResolvedStoreEpoch;
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
  writerEntitlement: SuccessionWriterEntitlement | null;
  generationWriterLease: GenerationWriterLease;
  kbRuntime: DaemonKnowledgeBaseRuntime;
  consumerDriver: ConsumerDriver;
  expansionLifecycleService: ExpansionLifecycleService;
  sourceImportService: KbSourceImportService;
  reindexService: KbReindexService;
  abortRegistry: AbortRegistry;
};

type KbDaemonWriteHostControl = {
  options: KbDaemonWriteRuntimeOptions;
  now: () => number;
  phase: KbDaemonKbReadHealth['phase'];
  initializedAt: number | undefined;
  lastError: string | undefined;
  lastSetupError: SerializedCoralSetupError | undefined;
  active: KbDaemonWriteRuntimeState | null;
  writerParkPending: boolean;
  initPromise: Promise<KbDaemonWriteRuntimeState> | null;
  disposePromise: Promise<void> | null;
  searchWarmupPromise: Promise<void> | null;
  lastSearchWarmupError: string | undefined;
  lastSearchWarmupSetupError: SerializedCoralSetupError | undefined;
  kiwiAnalyzerManager: KiwiSearchAnalyzerPort;
  kiwiArtifactBootTasks: ReturnType<typeof createKiwiArtifactBootTaskOwner>;
};

type KbDaemonBootResources = {
  db: WritableDatabase | null;
  generationWriterLease: GenerationWriterLease | null;
  consumerDriver: ConsumerDriver | null;
  expansionLifecycleService: ExpansionLifecycleService | null;
  daemonConsumerDriver: ConsumerDriver | null;
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
  parkWriterTurn(options?: { signal?: AbortSignal }): Promise<void>;
  reclaimWriterTurn(generation?: SuccessionWriterGeneration, signal?: AbortSignal): void;
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

function markReady(host: KbDaemonWriteHostControl): void {
  host.phase = 'ready';
  host.initializedAt ??= host.now();
  host.lastError = undefined;
  host.lastSetupError = undefined;
}

function markFailure(host: KbDaemonWriteHostControl, error: unknown): void {
  host.phase = 'failed';
  host.lastError = errorMessage(error);
  host.lastSetupError = serializeCoralSetupError(error) ?? undefined;
}

function markDisposing(host: KbDaemonWriteHostControl): void {
  host.phase = 'disposing';
}

function markDisposed(host: KbDaemonWriteHostControl): void {
  host.phase = 'disposed';
  host.lastError = undefined;
  host.lastSetupError = undefined;
}

function getExpansionLifecyclePhase(host: KbDaemonWriteHostControl): CoordinatorLifecyclePhase {
  if (host.phase === 'disposing') {
    return 'draining';
  }
  if (host.phase === 'disposed') {
    return 'stopped';
  }

  return 'running';
}

function createKbDaemonProgressStore({
  options,
  runtime,
  guardedRuntime,
  activeDb,
  resolvedStore,
  backendNamespace,
}: Readonly<{
  options: KbDaemonWriteRuntimeOptions;
  runtime: Runtime;
  guardedRuntime: Runtime;
  activeDb: WritableDatabase;
  resolvedStore: ResolvedStoreEpoch | null;
  backendNamespace: string;
}>): JobStore {
  const jobLocations =
    resolvedStore === null
      ? null
      : new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot, renderWorkflowReport);
  let observeTerminalExports: (appended: readonly AppendedEvent[]) => void = () => {};
  const progressStore = new JobStore(backendNamespace, guardedRuntime, createEventBodyCodec(), {
    db: activeDb as ConstructorParameters<typeof JobStore>[3]['db'],
    providers: noProviderLookupPort,
    beforeAppend:
      jobLocations === null || resolvedStore === null
        ? undefined
        : (input) => {
            if (input.stream.kind !== 'job' || !['job.launch.requested', 'job.terminal.recorded'].includes(input.type))
              return;
            jobLocations.beforeAppend(input, encodeResolvedStoreEpoch(runtime, resolvedStore));
          },
    observer: (appended) => {
      observeTerminalExports(appended);
      if (jobLocations !== null) {
        for (const event of appended) {
          if (event.stream.kind !== 'job' || event.type !== 'job.progress.emitted') continue;
          try {
            const detail = progressStore.loadJobProjectionDetail(event.stream.id);
            if (detail.status === null) continue;
            jobLocations.recordObserved(event.stream.id, {
              status: detail.status,
              events: progressStore.readJobEvents(event.stream.id),
              readiness: deriveLaunchReadiness(detail),
              exit: detail.exit,
            });
          } catch (error: unknown) {
            backendLog.warn(`Writing job progress address failed for ${event.stream.id}: ${errorMessage(error)}`);
          }
        }
      }
      options.onJournalEvents?.(appended);
    },
  });
  progressStore.configureResultExports(jobLocations, renderWorkflowReport);
  if (jobLocations !== null) {
    observeTerminalExports = observeTerminalResultExports(
      (jobId, seq) => progressStore.publishTerminalResult(jobId, seq),
      (jobId, seq) => {
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
          progressStore.getDb(),
          true,
        );
      },
    );
  }
  return progressStore;
}

function createDaemonKnowledgeBase({
  options,
  runtime,
  corpusStorage,
  markdownRoot,
  runtimeDir,
  activeDb,
  curateAssistant,
  boot,
}: Readonly<{
  options: KbDaemonWriteRuntimeOptions;
  runtime: Runtime;
  corpusStorage: Runtime['storage'];
  markdownRoot: string;
  runtimeDir: string;
  activeDb: WritableDatabase;
  curateAssistant: CurateAssistantPort;
  boot: KbDaemonBootResources;
}>): KbRuntime {
  let kbRef: KbRuntime | null = null;
  const kb = createKbRuntime({
    flavor: runtime.flavor,
    markdownRoot,
    runtimeDir,
    version: resolveVersion(options.version),
    db: activeDb as Parameters<typeof createKbRuntime>[0]['db'],
    envPort: runtime.env,
    time: runtime.time,
    ids: runtime.ids,
    storage: corpusStorage,
    curateAssistant,
    processPort: runtime.process,
    corpusPublishCallbacks: {
      persistCorpusState: (snapshot) =>
        persistCorpusState(activeDb as Database, snapshot, {
          now: () => nowDate(runtime.time),
        }),

      notifyCorpusMutation: (publication) => {
        notifyDaemonCorpusDeferred(() => boot.daemonConsumerDriver, publication);
        options.onCorpusMutation?.(publication);
      },
    },
    generatedCommunityProjectionCallbacks: {
      notifyGeneratedCommunityProjection: async (publication) => {
        const activeKb = kbRef;
        const driver = boot.daemonConsumerDriver;
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
  return kb;
}

function createKbDaemonExpansionLifecycle({
  host,
  boot,
  runtime,
  guardedRuntime,
  activeDb,
  kb,
  activeConsumerDriver,
}: Readonly<{
  host: KbDaemonWriteHostControl;
  boot: KbDaemonBootResources;
  runtime: Runtime;
  guardedRuntime: Runtime;
  activeDb: WritableDatabase;
  kb: KbRuntime;
  activeConsumerDriver: ConsumerDriver;
}>) {
  const corpusReadinessTimeoutMs = resolveDaemonCorpusReadinessTimeoutMs(runtime);
  const oramaProjectionReconcileRequester = createOramaProjectionReconcileRequester({
    kb,
    driver: activeConsumerDriver,
  });
  const manifestCatalog = createExpansionManifestCatalog({
    db: activeDb as Database,
    now: () => nowDate(runtime.time).toISOString(),
  });
  initializeCapabilityCatalog(kb.capabilityRegistry, manifestCatalog.listManifests(), BUILTIN_CAPABILITY_DESCRIPTORS);
  const expansionStateStore = new ExpansionStateStore(activeDb as Database);
  const activeExpansionLifecycleService = new ExpansionLifecycleService({
    makeHost: createHostFactory({
      runtime: guardedRuntime,
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
    getLifecyclePhase: () => getExpansionLifecyclePhase(host),
    protectedPackageIds: new Set(INSTALL_ONLY_PACKAGES.map((entry) => entry.id)),
    retireCatalogAbsent: (name, finalizeState) =>
      cleanupRetiredExpansion(name, {
        runtime: guardedRuntime,
        kbRuntimeDir: kb.runtimeDir,
        manifestCatalog,
        consumerDriver: activeConsumerDriver,
        finalizeState,
      }),
  });
  boot.expansionLifecycleService = activeExpansionLifecycleService;
  return { activeExpansionLifecycleService, corpusReadinessTimeoutMs };
}

function createKbDaemonWriteServices({
  options,
  runtime,
  guardedRuntime,
  corpusStorage,
  activeDb,
  kb,
  curateAssistant,
  activeConsumerDriver,
  corpusReadinessTimeoutMs,
  progressStore,
  backendNamespace,
  bundleHash,
  abortRegistry,
}: Readonly<{
  options: KbDaemonWriteRuntimeOptions;
  runtime: Runtime;
  guardedRuntime: Runtime;
  corpusStorage: Runtime['storage'];
  activeDb: WritableDatabase;
  kb: KbRuntime;
  curateAssistant: CurateAssistantPort;
  activeConsumerDriver: ConsumerDriver;
  corpusReadinessTimeoutMs: number;
  progressStore: JobStore;
  backendNamespace: string;
  bundleHash: string;
  abortRegistry: AbortRegistry;
}>) {
  const kbRuntime: DaemonKnowledgeBaseRuntime = {
    kb,
    readDb: activeDb,
    curateScheduler: createCurateScheduler({
      kb,
      curateAssistant,
      processPort: runtime.process,
      storagePort: corpusStorage,
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
    runtime: guardedRuntime,
    progressStore,
    backendNamespace,
    bundleHash,
    waitForReadiness,
    abortRegistry,
    internalJobOwner: 'kb-daemon',
  });
  const reindexService = new KbReindexService({
    runtime: guardedRuntime,
    progressStore,
    backendNamespace,
    bundleHash,
    waitForReadiness,
    abortRegistry,
    internalJobOwner: 'kb-daemon',
  });
  return { kbRuntime, sourceImportService, reindexService };
}

async function openKbDaemonBootStore(
  host: KbDaemonWriteHostControl,
  boot: KbDaemonBootResources,
  runtime: Runtime,
  ownsDb: boolean,
) {
  const { options } = host;
  boot.generationWriterLease = await generationMutationCoordinationSeam.acquireWriterLease(runtime, {
    kind: 'kb-child',
    name: 'write-runtime',
  });
  boot.generationWriterLease.assertOwned();
  const generationWriterLease = boot.generationWriterLease;
  boot.db =
    options.db ??
    (openWritableStoreDbNoReset(runtime, {
      storeFormat: currentCoralStoreFormat(),
      ...(options.store === undefined ? {} : { resolved: options.store }),
    }) as unknown as WritableDatabase);
  const activeDb = boot.db;
  const resolvedStore = options.store ?? resolveCurrentStore(runtime).epoch;
  const writerEntitlement = ownsDb
    ? joinSuccessionWriterGeneration(
        runtime,
        resolvedStore ?? { storeRoot: dirname(resolveCurrentStore(runtime).path), epoch: 'legacy' },
      )
    : null;
  const corpusStorage =
    writerEntitlement === null ? runtime.storage : fenceCorpusStorage(runtime.storage, writerEntitlement);
  const guardedRuntime = { ...runtime, storage: corpusStorage };
  const backendNamespace = options.backendNamespace ?? pluginRootNamespace(options.pluginRoot);
  const bundleHash = options.bundleHash ?? readBundleHash(options.pluginRoot);
  const markdownRoot = runtime.paths.coral.corpus.kbRoot;
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  cleanupSourceImportRuntimeArtifacts(runtimeDir, guardedRuntime);
  const curateAssistant = options.curateAssistant ?? createUnavailableCurateAssistant();
  const abortRegistry = new AbortRegistry(runtime.ids);
  return {
    activeDb,
    generationWriterLease,
    resolvedStore,
    writerEntitlement,
    corpusStorage,
    guardedRuntime,
    backendNamespace,
    bundleHash,
    markdownRoot,
    runtimeDir,
    curateAssistant,
    abortRegistry,
  };
}

async function recoverKbDaemonProjectionBoot(
  host: KbDaemonWriteHostControl,
  guardedRuntime: Runtime,
  kb: KbRuntime,
  activeConsumerDriver: ConsumerDriver,
  activeExpansionLifecycleService: ExpansionLifecycleService,
  corpusReadinessTimeoutMs: number,
  buildKiwiArtifactBootController: AbortController,
): Promise<void> {
  await runPromoteRecovery(kb);
  await kb.retryPendingCorpusPublication();
  await activeExpansionLifecycleService.recoverOnBoot();
  activeConsumerDriver.notifyCorpus(kb.getCorpusStateSnapshot());
  await repairProjectionArtifactLagOnBoot(kb, activeConsumerDriver, corpusReadinessTimeoutMs);

  const kiwiArtifactBootHandle = startKiwiArtifactFetchOnBoot({
    runtime: guardedRuntime,
    kb,
    driver: activeConsumerDriver,
    timeoutMs: corpusReadinessTimeoutMs,
    signal: buildKiwiArtifactBootController.signal,
  });
  host.kiwiArtifactBootTasks.track(buildKiwiArtifactBootController, kiwiArtifactBootHandle.completed);
}

async function releaseFailedKbDaemonBoot(
  host: KbDaemonWriteHostControl,
  boot: KbDaemonBootResources,
  ownsDb: boolean,
  buildKiwiArtifactBootController: AbortController,
): Promise<void> {
  host.kiwiArtifactBootTasks.abort(buildKiwiArtifactBootController);
  boot.daemonConsumerDriver = null;
  await boot.expansionLifecycleService?.shutdownActiveExpansions().catch(() => undefined);
  await boot.consumerDriver?.shutdown({ drainTimeoutMs: 0 }).catch(() => undefined);
  if (ownsDb && boot.db !== null) {
    try {
      boot.db.close();
    } catch {
      // Preserve the initialization error; a failed cleanup is secondary.
    }
  }
  try {
    boot.generationWriterLease?.release();
  } catch {
    // Preserve the initialization error; a failed lease cleanup is secondary.
  }
}

async function buildKbDaemonWriteRuntime(host: KbDaemonWriteHostControl): Promise<KbDaemonWriteRuntimeState> {
  const { options } = host;
  const buildKiwiArtifactBootController = host.kiwiArtifactBootTasks.start();
  const runtime = options.runtime ?? createRealRuntime(readBuildFlavor(options.pluginRoot));
  const ownsDb = options.db === undefined;
  const boot: KbDaemonBootResources = {
    db: null,
    generationWriterLease: null,
    consumerDriver: null,
    expansionLifecycleService: null,
    daemonConsumerDriver: null,
  };

  try {
    const store = await openKbDaemonBootStore(host, boot, runtime, ownsDb);
    const {
      activeDb,
      generationWriterLease,
      resolvedStore,
      writerEntitlement,
      corpusStorage,
      guardedRuntime,
      backendNamespace,
      bundleHash,
      markdownRoot,
      runtimeDir,
      curateAssistant,
      abortRegistry,
    } = store;
    const progressStore = createKbDaemonProgressStore({
      options,
      runtime,
      guardedRuntime,
      activeDb,
      resolvedStore,
      backendNamespace,
    });
    const kb = createDaemonKnowledgeBase({
      options,
      runtime,
      corpusStorage,
      markdownRoot,
      runtimeDir,
      activeDb,
      curateAssistant,
      boot,
    });
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
    boot.consumerDriver = activeConsumerDriver;
    boot.daemonConsumerDriver = activeConsumerDriver;
    const { activeExpansionLifecycleService, corpusReadinessTimeoutMs } = createKbDaemonExpansionLifecycle({
      host,
      boot,
      runtime,
      guardedRuntime,
      activeDb,
      kb,
      activeConsumerDriver,
    });
    await recoverKbDaemonProjectionBoot(
      host,
      guardedRuntime,
      kb,
      activeConsumerDriver,
      activeExpansionLifecycleService,
      corpusReadinessTimeoutMs,
      buildKiwiArtifactBootController,
    );
    const { kbRuntime, sourceImportService, reindexService } = createKbDaemonWriteServices({
      options,
      runtime,
      guardedRuntime,
      corpusStorage,
      activeDb,
      kb,
      curateAssistant,
      activeConsumerDriver,
      corpusReadinessTimeoutMs,
      progressStore,
      backendNamespace,
      bundleHash,
      abortRegistry,
    });
    const activeState: KbDaemonWriteRuntimeState = {
      runtime: guardedRuntime,
      db: activeDb,
      ownsDb,
      writerEntitlement,
      generationWriterLease,
      kbRuntime,
      consumerDriver: activeConsumerDriver,
      expansionLifecycleService: activeExpansionLifecycleService,
      sourceImportService,
      reindexService,
      abortRegistry,
    };
    host.active = activeState;
    markReady(host);
    return activeState;
  } catch (error: unknown) {
    await releaseFailedKbDaemonBoot(host, boot, ownsDb, buildKiwiArtifactBootController);
    throw error;
  }
}

async function initializeKbDaemonWriteRuntime(host: KbDaemonWriteHostControl): Promise<KbDaemonWriteRuntimeState> {
  if (host.phase === 'disposing' || host.phase === 'disposed') {
    throw new Error(`KB daemon write runtime is ${host.phase}.`);
  }
  if (host.active !== null) {
    markReady(host);
    return host.active;
  }
  if (host.initPromise !== null) {
    return host.initPromise;
  }
  host.initPromise = buildKbDaemonWriteRuntime(host)
    .catch((error: unknown) => {
      markFailure(host, error);
      throw error;
    })
    .finally(() => {
      host.initPromise = null;
    });
  return host.initPromise;
}

function assertFtsBindingReady(activeState: KbDaemonWriteRuntimeState): KbDaemonSearchRuntimeReadiness | null {
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
}

function readKbDaemonSearchReadiness(host: KbDaemonWriteHostControl): KbDaemonSearchRuntimeReadiness {
  const activeState = host.active;
  if (activeState === null) {
    if (host.initPromise !== null) {
      return {
        ready: false,
        reason: 'write_runtime_initializing',
        message: 'KB search runtime is still warming.',
      };
    }
    return {
      ready: false,
      reason: host.phase === 'not_initialized' ? 'write_runtime_not_initialized' : 'write_runtime_unavailable',
      message: `KB search runtime is not ready: write runtime is ${host.phase}.`,
      ...(host.lastSearchWarmupSetupError === undefined ? {} : { setupError: host.lastSearchWarmupSetupError }),
      ...(host.lastSearchWarmupError === undefined
        ? {}
        : { detail: { lastSearchWarmupError: host.lastSearchWarmupError } }),
    };
  }

  const ftsReadiness = assertFtsBindingReady(activeState);
  if (ftsReadiness !== null) {
    return ftsReadiness;
  }

  const analyzerReadiness = host.kiwiAnalyzerManager.leaseReadiness(
    activeState.runtime,
    activeState.kbRuntime.kb.declaredAnalyzers,
  );
  if (!analyzerReadiness.ready) {
    return {
      ready: false,
      reason: `kiwi_analyzer_${analyzerReadiness.state}`,
      message: `KB search runtime is not ready: Kiwi analyzer is ${analyzerReadiness.state}.`,
      ...(host.lastSearchWarmupSetupError === undefined ? {} : { setupError: host.lastSearchWarmupSetupError }),
      ...(analyzerReadiness.reason === undefined && host.lastSearchWarmupError === undefined
        ? {}
        : {
            detail: {
              ...(analyzerReadiness.reason === undefined ? {} : { analyzerReason: analyzerReadiness.reason }),
              ...(host.lastSearchWarmupError === undefined
                ? {}
                : { lastSearchWarmupError: host.lastSearchWarmupError }),
            },
          }),
    };
  }

  return { ready: true };
}

function warmKbDaemonSearchRuntime(host: KbDaemonWriteHostControl): void {
  if (host.searchWarmupPromise !== null || host.phase === 'disposing' || host.phase === 'disposed') {
    return;
  }

  host.searchWarmupPromise = initializeKbDaemonWriteRuntime(host)
    .then(async (activeState) => {
      if (activeState.kbRuntime.kb.declaredAnalyzers.includes('ko')) {
        await host.kiwiAnalyzerManager.withAnalyzerLease(
          activeState.runtime,
          activeState.kbRuntime.kb.declaredAnalyzers,
          () => undefined,
        );
      }
      host.lastSearchWarmupError = undefined;
      host.lastSearchWarmupSetupError = undefined;
    })
    .catch((error: unknown) => {
      host.lastSearchWarmupError = errorMessage(error);
      host.lastSearchWarmupSetupError = serializeCoralSetupError(error) ?? undefined;
    })
    .finally(() => {
      host.searchWarmupPromise = null;
    });
}

async function disposeKbDaemonWriteState(
  host: KbDaemonWriteHostControl,
  activeState: KbDaemonWriteRuntimeState,
  signal: AbortSignal | undefined,
): Promise<void> {
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
    host.active = null;
    if (activeState.ownsDb) {
      try {
        activeState.db.close();
      } catch (error: unknown) {
        closeError = error;
      }
    }
    try {
      activeState.generationWriterLease.release();
    } catch (error: unknown) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error ? cleanupError : new Error(errorMessage(cleanupError));
  }
  if (closeError !== undefined) {
    throw closeError instanceof Error ? closeError : new Error(errorMessage(closeError));
  }
}

async function disposeKbDaemonWriteRuntime(
  host: KbDaemonWriteHostControl,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (host.disposePromise !== null) {
    return host.disposePromise;
  }
  host.disposePromise = (async () => {
    markDisposing(host);
    host.kiwiArtifactBootTasks.abortCurrent();
    try {
      let activeState = host.active;
      if (activeState === null && host.initPromise !== null) {
        try {
          activeState = await host.initPromise;
        } catch {
          markDisposed(host);
          return;
        }
      }
      host.kiwiArtifactBootTasks.abortCurrent();
      if (activeState !== null) {
        await disposeKbDaemonWriteState(host, activeState, options.signal);
      }
      markDisposed(host);
    } catch (error: unknown) {
      markFailure(host, error);
      throw error;
    }
  })().finally(() => {
    host.disposePromise = null;
  });
  return host.disposePromise;
}

function kbDisposedError(host: KbDaemonWriteHostControl): KbToolResult {
  return kbError('kb_unavailable', `KB daemon write runtime is ${host.phase}.`);
}

function kbWriterParkRefusal(): KbToolResult {
  return kbError('succession_admission_paused', 'KB work admission is paused during succession. Retry shortly.');
}

async function createKbDaemonSource(
  host: KbDaemonWriteHostControl,
  args: Record<string, unknown>,
  ctx: InvocationContext,
): Promise<KbToolResult> {
  if (host.writerParkPending) return kbWriterParkRefusal();
  if (host.phase === 'disposing' || host.phase === 'disposed') {
    return kbDisposedError(host);
  }
  const parsed = parseKbSourceImportRequest(args);
  if (!parsed.ok) {
    return kbError('invalid_request', parsed.message);
  }
  const initialized = await initializeKbDaemonWriteRuntime(host);
  initialized.kbRuntime.kb.invalidateKbCache();
  await initialized.kbRuntime.kb.ensureCorpusFreshness({ wait: true });
  if (host.writerParkPending) return kbWriterParkRefusal();
  return initialized.sourceImportService.start(parsed.data, ctx, initialized.kbRuntime);
}

async function reindexKbDaemon(
  host: KbDaemonWriteHostControl,
  args: Record<string, unknown>,
  ctx: InvocationContext,
): Promise<KbToolResult> {
  if (host.writerParkPending) return kbWriterParkRefusal();
  if (host.phase === 'disposing' || host.phase === 'disposed') {
    return kbDisposedError(host);
  }
  const initialized = await initializeKbDaemonWriteRuntime(host);
  initialized.kbRuntime.kb.invalidateKbCache();
  await initialized.kbRuntime.kb.ensureCorpusFreshness({ wait: true });
  if (host.writerParkPending) return kbWriterParkRefusal();
  return initialized.reindexService.run({ async: args.async === true }, ctx, initialized.kbRuntime);
}

async function runKbDaemonExpansionRpc(
  host: KbDaemonWriteHostControl,
  request: KbDaemonExpansionRequest,
): Promise<KbDaemonExpansionResult> {
  if (host.phase === 'disposing' || host.phase === 'disposed') {
    return kbDisposedError(host);
  }
  try {
    const initialized = await initializeKbDaemonWriteRuntime(host);
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
}

async function parkKbDaemonWriterTurn(
  host: KbDaemonWriteHostControl,
  options?: { signal?: AbortSignal },
): Promise<void> {
  host.writerParkPending = true;
  const activeState = host.active;
  if (activeState === null || activeState.writerEntitlement === null) {
    host.writerParkPending = false;
    throw new Error('KB daemon writer turn is unavailable.');
  }
  try {
    await drainCorpusMutationLock(activeState.kbRuntime.kb, { signal: options?.signal });
    if (host.active !== activeState) throw new Error('KB daemon writer turn changed during park.');

    const activeJobs = activeState.abortRegistry.listActive();
    if (activeJobs.length > 0) {
      throw new Error(`KB daemon writer turn cannot park while ${activeJobs.length} KB job(s) run.`);
    }
    activeState.writerEntitlement.park();
  } catch (error: unknown) {
    host.writerParkPending = false;
    throw error;
  }
}

function reclaimKbDaemonWriterTurn(
  host: KbDaemonWriteHostControl,
  generation?: SuccessionWriterGeneration,
  signal?: AbortSignal,
): void {
  const writer = host.active?.writerEntitlement;
  if (writer === undefined || writer === null) throw new Error('KB daemon writer turn is unavailable.');
  signal?.throwIfAborted();
  if (generation !== undefined && generation.generation !== writer.generation.generation) writer.rebind(generation);
  writer.unpark();
  if (signal?.aborted) {
    writer.park();
    signal.throwIfAborted();
  }
  host.writerParkPending = false;
}

function readKbDaemonWriteHealth(host: KbDaemonWriteHostControl): KbDaemonKbReadHealth {
  const activeState = host.active;
  const mutationDiagnostics = activeState?.kbRuntime.kb.mutationLockDiagnostics();
  const mutationBlocked =
    mutationDiagnostics?.blocked === true
      ? {
          owner: mutationDiagnostics.owner,
          ageMs: mutationDiagnostics.ageMs,
          signaledAtMs: mutationDiagnostics.signaledAtMs,
        }
      : undefined;
  const healthLastError = host.lastError ?? host.lastSearchWarmupError;
  const healthSetupError = host.lastSetupError ?? host.lastSearchWarmupSetupError;
  return {
    phase: host.phase,
    ...(host.initializedAt === undefined ? {} : { initializedAt: host.initializedAt }),
    ...(healthLastError === undefined ? {} : { lastError: healthLastError }),
    ...(healthSetupError === undefined ? {} : { setupError: healthSetupError }),
    ...(activeState === null ? {} : { curateRunning: activeState.kbRuntime.curateScheduler.isRunning() }),
    ...(mutationBlocked === undefined ? {} : { mutationBlocked }),
  };
}

export function createKbDaemonWriteRuntimeHost(options: KbDaemonWriteRuntimeOptions): KbDaemonWriteRuntimeHost {
  const host: KbDaemonWriteHostControl = {
    options,
    now: options.now ?? Date.now,
    phase: 'not_initialized',
    initializedAt: undefined,
    lastError: undefined,
    lastSetupError: undefined,
    active: null,
    writerParkPending: false,
    initPromise: null,
    disposePromise: null,
    searchWarmupPromise: null,
    lastSearchWarmupError: undefined,
    lastSearchWarmupSetupError: undefined,
    kiwiAnalyzerManager: options.kiwiAnalyzer ?? resolveKiwiSearchAnalyzerPort(),
    kiwiArtifactBootTasks: createKiwiArtifactBootTaskOwner(),
  };

  return {
    async withKb(fn) {
      const initialized = await initializeKbDaemonWriteRuntime(host);
      return fn(initialized);
    },
    warmSearchRuntime: () => warmKbDaemonSearchRuntime(host),
    searchReadiness: () => readKbDaemonSearchReadiness(host),
    createSource: (args, ctx) => createKbDaemonSource(host, args, ctx),
    reindex: (args, ctx) => reindexKbDaemon(host, args, ctx),
    expansionRpc: (request) => runKbDaemonExpansionRpc(host, request),
    abortJobs(jobIds) {
      const activeState = host.active;
      if (activeState === null) {
        return { aborted: [], notFound: [...jobIds] };
      }
      return activeState.abortRegistry.abort(jobIds);
    },
    listActiveJobs() {
      const activeState = host.active;
      return activeState === null ? [] : activeState.abortRegistry.listActive();
    },
    parkWriterTurn: (options) => parkKbDaemonWriterTurn(host, options),
    reclaimWriterTurn: (generation, signal) => reclaimKbDaemonWriterTurn(host, generation, signal),
    dispose: (options) => disposeKbDaemonWriteRuntime(host, options),
    health: () => readKbDaemonWriteHealth(host),
  };
}
