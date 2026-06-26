declare const __VERSION__: string;

import { readBuildFlavor, readBundleHash } from '../../infra/bundle-manifest.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowDate } from '../../infra/time.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import { AbortError, throwIfAborted } from '../../runtime/abort.js';
import { kbRuntimeDir } from '../../kb/paths.js';
import { createKbRuntime } from '../../kb/runtime.js';
import { createCurateScheduler, type CurateHandle } from '../../kb/curate/scheduler.js';
import type { CurateAssistantPort } from '../../kb/curate/assistant.js';
import { runPromoteRecovery } from '../../kb/ops/promote-recovery.js';
import { cleanupSourceImportRuntimeArtifacts } from '../../kb/ops/source-import.js';
import type {
  KbCorpusPublication,
  KbCorpusSnapshot,
  KbPersistCorpusStateResult,
  KbRuntime,
} from '../../kb/contract.js';
import type { KbChildKbReadHealth } from './protocol.js';
import type { AppendedEvent } from '../../store/append.js';
import { JobStore } from '../../jobs/store.js';
import { noProviderLookupPort } from '../../providers/catalog.js';
import { createDefaultUpcasterRegistry } from '../../store/upcaster-registry.js';
import { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import {
  KbSourceImportService,
  parseKbSourceImportRequest,
  type KbSourceImportReadinessWaiter,
} from '../services/kb/source-import.js';
import { KbReindexService } from '../services/kb/reindex.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { kbError, type KbToolResult } from '../../kb/result.js';
import { ConsumerDriver } from '../consumer-driver/index.js';
import { createHostFactory } from '../expansion/host-factory.js';
import { ExpansionLifecycleService, createLifecycleBundledLoaders } from '../expansion/lifecycle.js';
import { ExpansionStateStore } from '../expansion/state.js';
import { createExpansionManifestCatalog } from '../../expansion/manifest-catalog.js';
import { initializeCapabilityCatalog } from '../../expansion/manifest-fills-validation.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
} from '../../kb/capability/constants.js';
import { waitForCorpusReadiness } from '../services/kb/readiness.js';
import type { Database } from '../../store/db.js';

type KbChildWriteRuntimeOptions = {
  pluginRoot: string;
  backendNamespace?: string;
  bundleHash?: string;
  runtime?: Runtime;
  db?: WritableDatabase;
  version?: string;
  now?: () => number;
  onJournalEvents?: (appended: readonly AppendedEvent[]) => void;
  onCorpusMutation?: (publication: KbCorpusPublication) => void;
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

type KbChildWriteRuntimeState = {
  runtime: Runtime;
  db: WritableDatabase;
  ownsDb: boolean;
  kbSubsystem: ChildKnowledgeBaseRuntime;
  consumerDriver: ConsumerDriver;
  expansionLifecycleService: ExpansionLifecycleService;
  sourceImportService: KbSourceImportService;
  reindexService: KbReindexService;
  abortRegistry: AbortRegistry;
};

const STORE_DB_MODULE = '../../store/db.js';
type StoreDbModule = {
  openWritableStoreDbNoReset(runtime: Runtime): WritableDatabase;
};

const DEFAULT_CHILD_CORPUS_READINESS_TIMEOUT_MS = 90_000;
const DEFAULT_CHILD_JOB_DRAIN_TIMEOUT_MS = 5_000;
const CHILD_JOB_DRAIN_POLL_MS = 25;
const BUILTIN_CAPABILITY_DESCRIPTORS = [
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
] as const;

export type ChildKnowledgeBaseRuntime = {
  kb: KbRuntime;
  readDb: Pick<WritableDatabase, 'prepare' | 'close'>;
  curateScheduler: CurateHandle;
};

type CorpusSnapshotCursorRow = {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
};

function withImmediate<T>(db: WritableDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureCorpusStateRow(db: WritableDatabase): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO kb_corpus_state (
        id,
        snapshot_id,
        content_seq,
        metadata_seq,
        content_manifest_hash,
        metadata_manifest_hash,
        last_mutation
      ) VALUES (1, NULL, 0, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
  ).run();
}

function readCorpusStateRow(db: WritableDatabase): CorpusSnapshotCursorRow {
  ensureCorpusStateRow(db);
  const row = db
    .prepare<[], CorpusSnapshotCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM kb_corpus_state
         WHERE id = 1
      `,
    )
    .get();
  if (row === undefined) {
    throw new Error('kb_corpus_state cursor row is missing after initialization');
  }
  return row;
}

function toSnapshot(row: CorpusSnapshotCursorRow): KbCorpusSnapshot {
  return {
    snapshotId: row.snapshot_id ?? '',
    contentSeq: row.content_seq ?? 0,
    metadataSeq: row.metadata_seq ?? 0,
    contentManifestHash: row.content_manifest_hash ?? '',
    metadataManifestHash: row.metadata_manifest_hash ?? '',
  };
}

function isSnapshotFresh(current: CorpusSnapshotCursorRow, next: KbCorpusSnapshot): boolean {
  return (
    next.contentSeq > (current.content_seq ?? 0) ||
    next.metadataSeq > (current.metadata_seq ?? 0) ||
    (next.contentSeq === (current.content_seq ?? 0) &&
      next.metadataSeq === (current.metadata_seq ?? 0) &&
      next.snapshotId !== (current.snapshot_id ?? ''))
  );
}

function deriveChangedLanes(
  current: CorpusSnapshotCursorRow,
  next: KbCorpusSnapshot,
): KbPersistCorpusStateResult['changedLanes'] {
  const changedLanes: KbPersistCorpusStateResult['changedLanes'] = [];
  if (
    next.contentSeq > (current.content_seq ?? 0) ||
    (next.contentSeq === (current.content_seq ?? 0) &&
      next.contentManifestHash !== (current.content_manifest_hash ?? ''))
  ) {
    changedLanes.push('content');
  }
  if (
    next.metadataSeq > (current.metadata_seq ?? 0) ||
    (next.metadataSeq === (current.metadata_seq ?? 0) &&
      next.metadataManifestHash !== (current.metadata_manifest_hash ?? ''))
  ) {
    changedLanes.push('metadata');
  }
  return changedLanes;
}

function persistChildCorpusState(
  db: WritableDatabase,
  snapshot: KbCorpusSnapshot,
  options: { now: () => Date },
): KbPersistCorpusStateResult {
  return withImmediate(db, () => {
    const current = readCorpusStateRow(db);
    if (!isSnapshotFresh(current, snapshot)) {
      return {
        snapshot: toSnapshot(current),
        changedLanes: [],
      };
    }

    const changedLanes = deriveChangedLanes(current, snapshot);
    const update = db.prepare<
      [string, number, number, string, string, string, number, number, number, number, string],
      unknown
    >(
      `
        UPDATE kb_corpus_state
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?,
               last_mutation = ?
         WHERE id = 1
           AND (
             content_seq < ?
             OR metadata_seq < ?
             OR (content_seq = ? AND metadata_seq = ? AND (snapshot_id IS NULL OR snapshot_id != ?))
           )
      `,
    );
    const result = update.run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      options.now().toISOString(),
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.snapshotId,
    );
    if (Number(result.changes) === 0) {
      return {
        snapshot: toSnapshot(readCorpusStateRow(db)),
        changedLanes: [],
      };
    }
    return {
      snapshot: { ...snapshot },
      changedLanes,
    };
  });
}

export type KbChildWriteRuntimeHost = {
  withKb<T>(fn: (state: KbChildWriteRuntimeState) => Promise<T> | T): Promise<T>;
  createSource(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  reindex(args: Record<string, unknown>, ctx: InvocationContext): Promise<KbToolResult>;
  listActiveJobs(): string[];
  abortJobs(jobIds: string[]): { aborted: string[]; notFound: string[] };
  dispose(options?: { signal?: AbortSignal }): Promise<void>;
  health(): KbChildKbReadHealth;
};

function createRuntime(pluginRoot: string): Runtime {
  return createRealRuntime(readBuildFlavor(pluginRoot));
}

function createChildCurateAssistant(): CurateAssistantPort {
  return {
    async complete() {
      throw new Error('KB child write runtime does not own curate assistant execution yet.');
    },
  };
}

function resolveVersion(version: string | undefined): string {
  if (version !== undefined) {
    return version;
  }
  return typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0';
}

function resolveChildCorpusReadinessTimeoutMs(runtime: Pick<Runtime, 'env'>): number {
  const raw = runtime.env.get('CORAL_BOOT_FRESHNESS_TIMEOUT_MS');
  if (!raw) {
    return DEFAULT_CHILD_CORPUS_READINESS_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHILD_CORPUS_READINESS_TIMEOUT_MS;
}

function notifyChildCorpus(driver: ConsumerDriver | null, publication: KbCorpusPublication): void {
  if (driver === null) {
    return;
  }
  if (publication.changedLanes.length === 1) {
    driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
    return;
  }
  driver.notifyCorpus(publication.snapshot);
}

function notifyChildCorpusDeferred(getDriver: () => ConsumerDriver | null, publication: KbCorpusPublication): void {
  const deferredPublication: KbCorpusPublication = {
    snapshot: { ...publication.snapshot },
    changedLanes: [...publication.changedLanes],
  };
  void Promise.resolve().then(() => {
    notifyChildCorpus(getDriver(), deferredPublication);
  });
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_JOB_DRAIN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CHILD_JOB_DRAIN_POLL_MS;
  const deadline = runtime.time.now() + timeoutMs;
  while (abortRegistry.listActive().length > 0) {
    if (options.signal?.aborted) {
      throw new AbortError({ stage: 'kb_child_job_drain', reason: options.signal.reason });
    }
    if (runtime.time.now() >= deadline) {
      throw new Error(`Timed out waiting for ${abortRegistry.listActive().length} active KB job(s) to stop.`);
    }
    await runtime.time.sleep(pollMs, { signal: options.signal });
  }
}

export function createKbChildWriteRuntimeHost(options: KbChildWriteRuntimeOptions): KbChildWriteRuntimeHost {
  const now = options.now ?? Date.now;
  let phase: KbChildKbReadHealth['phase'] = 'not_initialized';
  let initializedAt: number | undefined;
  let lastError: string | undefined;
  let state: KbChildWriteRuntimeState | null = null;
  let initPromise: Promise<KbChildWriteRuntimeState> | null = null;
  let disposePromise: Promise<void> | null = null;

  const markReady = (): void => {
    phase = 'ready';
    initializedAt ??= now();
    lastError = undefined;
  };
  const markFailure = (error: unknown): void => {
    phase = 'failed';
    lastError = errorMessage(error);
  };
  const markDisposing = (): void => {
    phase = 'disposing';
  };
  const markDisposed = (): void => {
    phase = 'disposed';
    lastError = undefined;
  };
  const disposedError = (): KbToolResult =>
    kbError('kb_unavailable', `KB child write runtime is ${phase}.`);

  const build = async (): Promise<KbChildWriteRuntimeState> => {
    const runtime = options.runtime ?? createRuntime(options.pluginRoot);
    const ownsDb = options.db === undefined;
    let db: WritableDatabase | null = null;
    let consumerDriver: ConsumerDriver | null = null;
    let expansionLifecycleService: ExpansionLifecycleService | null = null;
    let childConsumerDriver: ConsumerDriver | null = null;

    try {
      db = options.db ?? ((await import(STORE_DB_MODULE)) as StoreDbModule).openWritableStoreDbNoReset(runtime);
      const activeDb = db;
      const flavor = readBuildFlavor(options.pluginRoot);
      const backendNamespace = options.backendNamespace ?? pluginRootNamespace(options.pluginRoot);
      const bundleHash = options.bundleHash ?? readBundleHash(options.pluginRoot);
      const markdownRoot = runtime.paths.coral.corpus.kbRoot;
      const runtimeDir = kbRuntimeDir(flavor, runtime.paths.configSlot);
      cleanupSourceImportRuntimeArtifacts(runtimeDir, runtime);
      const curateAssistant = createChildCurateAssistant();
      const abortRegistry = new AbortRegistry(runtime.ids);
      const progressStore = new JobStore(backendNamespace, runtime, createDefaultUpcasterRegistry(), {
        db: activeDb as ConstructorParameters<typeof JobStore>[3]['db'],
        providers: noProviderLookupPort,
        observer: (appended) => options.onJournalEvents?.(appended),
      });
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
            persistChildCorpusState(activeDb, snapshot, {
              now: () => nowDate(runtime.time),
            }),
          // Parent observes successful child mutations from the persisted
          // corpus-state row; the child also wakes its local projection driver.
          notifyCorpusMutation: (publication) => {
            notifyChildCorpusDeferred(() => childConsumerDriver, publication);
            options.onCorpusMutation?.(publication);
          },
        },
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
      consumerDriver = activeConsumerDriver;
      childConsumerDriver = activeConsumerDriver;
      const corpusReadinessTimeoutMs = resolveChildCorpusReadinessTimeoutMs(runtime);
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
        bundledLoaders: createLifecycleBundledLoaders(),
        now: () => nowDate(runtime.time).toISOString(),
        resolveKbRuntime: () => kb,
      });
      expansionLifecycleService = activeExpansionLifecycleService;
      await runPromoteRecovery(kb);
      await kb.retryPendingCorpusPublication();
      await kb.ensureCorpusFreshness({ wait: true });
      await activeExpansionLifecycleService.recoverOnBoot();
      activeConsumerDriver.notifyCorpus(kb.getCorpusStateSnapshot());
      await activeConsumerDriver.drainAll({ timeoutMs: corpusReadinessTimeoutMs });
      const kbSubsystem: ChildKnowledgeBaseRuntime = {
        kb,
        readDb: activeDb,
        curateScheduler: createCurateScheduler({
          kb,
          curateAssistant,
          processPort: runtime.process,
          storagePort: runtime.storage,
          envPort: runtime.env,
        }),
      };
      const waitForReadiness: KbSourceImportReadinessWaiter = async ({ kb, readiness, snapshot, signal }) => {
        activeConsumerDriver.notifyCorpus(snapshot);
        return waitForCorpusReadiness({
          kb,
          readiness,
          snapshot,
          timeoutMs: corpusReadinessTimeoutMs,
          waitFresh: ({ consumerId, snapshot: target, timeoutMs }) =>
            waitAbortable(
              activeConsumerDriver.waitFreshUntil('corpus', target, consumerId, timeoutMs),
              signal,
              `kb_readiness:${readiness}`,
            ),
        });
      };
      const sourceImportService = new KbSourceImportService({
        runtime,
        progressStore,
        backendNamespace,
        bundleHash,
        waitForReadiness,
        abortRegistry,
        internalJobOwner: 'kb-child',
      });
      const reindexService = new KbReindexService({
        runtime,
        progressStore,
        backendNamespace,
        bundleHash,
        waitForReadiness,
        abortRegistry,
        internalJobOwner: 'kb-child',
      });
      state = {
        runtime,
        db: activeDb,
        ownsDb,
        kbSubsystem,
        consumerDriver: activeConsumerDriver,
        expansionLifecycleService: activeExpansionLifecycleService,
        sourceImportService,
        reindexService,
        abortRegistry,
      };
      markReady();
      return state;
    } catch (error: unknown) {
      childConsumerDriver = null;
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

  const init = async (): Promise<KbChildWriteRuntimeState> => {
    if (phase === 'disposing' || phase === 'disposed') {
      throw new Error(`KB child write runtime is ${phase}.`);
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

  const disposeState = async (
    activeState: KbChildWriteRuntimeState,
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
        await activeState.kbSubsystem.curateScheduler.stop();
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
      initialized.kbSubsystem.kb.invalidateKbCache();
      await initialized.kbSubsystem.kb.ensureCorpusFreshness({ wait: true });
      return fn(initialized);
    },
    async createSource(args, ctx) {
      if (phase === 'disposing' || phase === 'disposed') {
        return disposedError();
      }
      const parsed = parseKbSourceImportRequest(args);
      if (!parsed.ok) {
        return kbError('invalid_request', parsed.message);
      }
      const initialized = await init();
      initialized.kbSubsystem.kb.invalidateKbCache();
      await initialized.kbSubsystem.kb.ensureCorpusFreshness({ wait: true });
      return initialized.sourceImportService.start(parsed.data, ctx, initialized.kbSubsystem);
    },
    async reindex(args, ctx) {
      if (phase === 'disposing' || phase === 'disposed') {
        return disposedError();
      }
      const initialized = await init();
      initialized.kbSubsystem.kb.invalidateKbCache();
      await initialized.kbSubsystem.kb.ensureCorpusFreshness({ wait: true });
      return initialized.reindexService.run({ async: args.async === true }, ctx, initialized.kbSubsystem);
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
      return {
        phase,
        ...(initializedAt === undefined ? {} : { initializedAt }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
  };
}
