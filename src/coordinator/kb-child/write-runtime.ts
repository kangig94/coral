declare const __VERSION__: string;

import { readBuildFlavor, readBundleHash } from '../../infra/bundle-manifest.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowDate } from '../../infra/time.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import { kbRuntimeDir } from '../../kb/paths.js';
import { createKbRuntime } from '../../kb/runtime.js';
import { createCurateScheduler, type CurateHandle } from '../../kb/curate/scheduler.js';
import type { CurateAssistantPort } from '../../kb/curate/assistant.js';
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
import { KbSourceImportService, parseKbSourceImportRequest } from '../services/kb/source-import.js';
import { KbReindexService } from '../services/kb/reindex.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { kbError, type KbToolResult } from '../../kb/result.js';

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
  run(...params: TParams): { changes: number };
};

type WritableDatabase = {
  exec(sql: string): void;
  prepare<TParams extends unknown[] = unknown[], TRow = unknown>(sql: string): WritableStatement<TParams, TRow>;
  close(): void;
};

type KbChildWriteRuntimeState = {
  runtime: Runtime;
  db: WritableDatabase;
  kbSubsystem: ChildKnowledgeBaseRuntime;
  sourceImportService: KbSourceImportService;
  reindexService: KbReindexService;
  abortRegistry: AbortRegistry;
};

const STORE_DB_MODULE = '../../store/db.js';
type StoreDbModule = {
  openWritableStoreDbNoReset(runtime: Runtime): WritableDatabase;
};

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
    if (result.changes === 0) {
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
  abortJobs(jobIds: string[]): { aborted: string[]; notFound: string[] };
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

export function createKbChildWriteRuntimeHost(options: KbChildWriteRuntimeOptions): KbChildWriteRuntimeHost {
  const now = options.now ?? Date.now;
  let phase: KbChildKbReadHealth['phase'] = 'not_initialized';
  let initializedAt: number | undefined;
  let lastError: string | undefined;
  let state: KbChildWriteRuntimeState | null = null;
  let initPromise: Promise<KbChildWriteRuntimeState> | null = null;

  const markReady = (): void => {
    phase = 'ready';
    initializedAt ??= now();
    lastError = undefined;
  };
  const markFailure = (error: unknown): void => {
    phase = 'failed';
    lastError = errorMessage(error);
  };

  const build = async (): Promise<KbChildWriteRuntimeState> => {
    const runtime = options.runtime ?? createRuntime(options.pluginRoot);
    const db =
      options.db ??
      ((await import(STORE_DB_MODULE)) as StoreDbModule).openWritableStoreDbNoReset(runtime);
    const flavor = readBuildFlavor(options.pluginRoot);
    const backendNamespace = options.backendNamespace ?? pluginRootNamespace(options.pluginRoot);
    const bundleHash = options.bundleHash ?? readBundleHash(options.pluginRoot);
    const markdownRoot = runtime.paths.coral.corpus.kbRoot;
    const runtimeDir = kbRuntimeDir(flavor, runtime.paths.configSlot);
    const curateAssistant = createChildCurateAssistant();
    const abortRegistry = new AbortRegistry(runtime.ids);
    const progressStore = new JobStore(backendNamespace, runtime, createDefaultUpcasterRegistry(), {
      db: db as ConstructorParameters<typeof JobStore>[3]['db'],
      providers: noProviderLookupPort,
      observer: (appended) => options.onJournalEvents?.(appended),
    });
    const kb = createKbRuntime({
      markdownRoot,
      runtimeDir,
      version: resolveVersion(options.version),
      db: db as Parameters<typeof createKbRuntime>[0]['db'],
      envPort: runtime.env,
      time: runtime.time,
      ids: runtime.ids,
      storage: runtime.storage,
      curateAssistant,
      processPort: runtime.process,
      corpusPublishCallbacks: {
        persistCorpusState: (snapshot) =>
          persistChildCorpusState(db, snapshot, {
            now: () => nowDate(runtime.time),
          }),
        // Parent observes successful child mutations and notifies consumers
        // from the persisted corpus-state row. The child must not try to reach
        // parent process memory directly.
        notifyCorpusMutation: (publication) => options.onCorpusMutation?.(publication),
      },
    });
    const kbSubsystem: ChildKnowledgeBaseRuntime = {
      kb,
      readDb: db,
      curateScheduler: createCurateScheduler({
        kb,
        curateAssistant,
        processPort: runtime.process,
        storagePort: runtime.storage,
        envPort: runtime.env,
      }),
    };
    const waitForReadiness = async (): Promise<void> => undefined;
    const sourceImportService = new KbSourceImportService({
      runtime,
      progressStore,
      backendNamespace,
      bundleHash,
      waitForReadiness,
      abortRegistry,
    });
    const reindexService = new KbReindexService({
      runtime,
      progressStore,
      backendNamespace,
      bundleHash,
      waitForReadiness,
      abortRegistry,
    });
    state = { runtime, db, kbSubsystem, sourceImportService, reindexService, abortRegistry };
    markReady();
    return state;
  };

  const init = async (): Promise<KbChildWriteRuntimeState> => {
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

  return {
    async withKb(fn) {
      const initialized = await init();
      initialized.kbSubsystem.kb.invalidateKbCache();
      await initialized.kbSubsystem.kb.ensureCorpusFreshness({ wait: true });
      return fn(initialized);
    },
    async createSource(args, ctx) {
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
    health() {
      return {
        phase,
        ...(initializedAt === undefined ? {} : { initializedAt }),
        ...(lastError === undefined ? {} : { lastError }),
      };
    },
  };
}
