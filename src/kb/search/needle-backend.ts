import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readCorpusState } from '../../store/corpus-state.js';
import { backendLog } from '../../shared/backend-log.js';
import { errorMessage, isRecord } from '../../shared/utils.js';
import type { ConsumerApplyError, CorpusConsumerApplyContext, CorpusConsumerRegistration, KbRuntime } from '../contracts.js';
import { writeFileAtomic } from '../corpus/mutation-helpers.js';
import { getEntry, isNoteEntry, isSourceEntry, parseKbEntryId, type KbEntryId, type KbIndex } from '../entry-types.js';
import { needleIndexDir, needleStagingDir } from '../paths.js';
import { loadKbNote, loadKbSource } from '../read.js';
import { chunkEntry, type ChunkSeed } from './chunking.js';
import { createEmbeddingProvider, resolveEmbeddingProviderConfig, type EmbeddingProviderConfig } from './embedding.js';
import { createNeedleStore, type NeedleStore } from './needle-store.js';
import type { RetrievalScope, VectorRetrieval, VectorRetrievalHit, VectorRetrievalResult } from './contract.js';

export const NEEDLE_CONSUMER_ID = 'needle';

const NEEDLE_STORE_FILE = 'store.db';
const NEEDLE_MANIFEST_FILE = 'manifest.json';
const NEEDLE_ACTIVE_POINTER_FILE = 'ACTIVE';
const VECTOR_CANDIDATE_CAP_MULTIPLIER = 10;

export interface NeedleBackendOptions {
  consumerId?: string;
  addonPath: string;
  pluginRoot?: string;
  storeFactory?: (runtimeDir: string) => NeedleStore | null;
}

type NeedleBackendStagingHook = (ctx: {
  snapshot: NeedleApplyContext['snapshot'];
  stagingDir: string;
  specId: string;
}) => void | Promise<void>;

type NeedleApplyContext = CorpusConsumerApplyContext;

type NeedleCursorView = {
  snapshotId: string;
  contentSeq: number;
  contentManifestHash: string;
};

type NeedleSnapshotManifest = {
  snapshot: NeedleCursorView;
  specId: string;
  entryCount: number;
  chunkCount: number;
};

type OpenedNeedleStore = {
  store: NeedleStore;
  close(): Promise<void>;
};

type ActiveNeedleHandle = OpenedNeedleStore & {
  snapshotId: string;
  specId: string;
  leaseCount: number;
  retired: boolean;
  closed: boolean;
};

type ActiveNeedleLease = {
  handle: ActiveNeedleHandle;
  release(): Promise<void>;
};

type StagedVectorEntry = {
  entryId: KbEntryId;
  chunks: ChunkSeed[];
};

const SHARED_NEEDLE_BACKENDS = new WeakMap<KbRuntime, NeedleBackend>();
let needleBackendStagingHookForTests: NeedleBackendStagingHook | null = null;

function isNeedleSnapshotManifest(value: unknown): value is NeedleSnapshotManifest {
  return (
    isRecord(value) &&
    isRecord(value.snapshot) &&
    typeof value.snapshot.snapshotId === 'string' &&
    typeof value.snapshot.contentSeq === 'number' &&
    typeof value.snapshot.contentManifestHash === 'string' &&
    typeof value.specId === 'string' &&
    typeof value.entryCount === 'number' &&
    typeof value.chunkCount === 'number'
  );
}

function needleSnapshotsDir(runtimeDir: string): string {
  return join(needleIndexDir(runtimeDir), 'snapshots');
}

function needleSnapshotDir(runtimeDir: string, snapshotId: string): string {
  return join(needleSnapshotsDir(runtimeDir), snapshotId);
}

function needleSnapshotDbPath(runtimeDir: string, snapshotId: string): string {
  return join(needleSnapshotDir(runtimeDir, snapshotId), NEEDLE_STORE_FILE);
}

function needleSnapshotManifestPath(snapshotDir: string): string {
  return join(snapshotDir, NEEDLE_MANIFEST_FILE);
}

function needleActivePointerPath(runtimeDir: string): string {
  return join(needleIndexDir(runtimeDir), NEEDLE_ACTIVE_POINTER_FILE);
}

function needleHandleDir(runtimeDir: string, handleToken: string): string {
  return join(needleIndexDir(runtimeDir), 'handles', handleToken);
}

function writeActiveSnapshotId(runtimeDir: string, snapshotId: string): void {
  writeFileAtomic(needleActivePointerPath(runtimeDir), `${snapshotId}\n`);
}

function readSnapshotManifest(runtimeDir: string, snapshotId: string): NeedleSnapshotManifest | null {
  try {
    const raw = readFileSync(needleSnapshotManifestPath(needleSnapshotDir(runtimeDir, snapshotId)), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isNeedleSnapshotManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSnapshotManifest(snapshotDir: string, manifest: NeedleSnapshotManifest): void {
  writeFileAtomic(needleSnapshotManifestPath(snapshotDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createHandleToken(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function compareScoreAndEntryId(
  left: Pick<VectorRetrievalHit, 'score' | 'entryId'>,
  right: Pick<VectorRetrievalHit, 'score' | 'entryId'>,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.entryId.localeCompare(right.entryId);
}

function toUnitVector(embedding: readonly number[]): Float32Array | null {
  if (embedding.length === 0) {
    return null;
  }

  const vector = new Float32Array(embedding.length);
  let normSquared = 0;

  for (const [index, value] of embedding.entries()) {
    if (!Number.isFinite(value)) {
      return null;
    }

    vector[index] = value;
    normSquared += value * value;
  }

  if (normSquared === 0) {
    return null;
  }

  const scale = 1 / Math.sqrt(normSquared);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] *= scale;
  }

  return vector;
}

function scopeAllowsVectorKind(scope: RetrievalScope | undefined, kind: 'note' | 'source' | 'community'): boolean {
  if (scope === undefined || scope === 'all') {
    return kind === 'note' || kind === 'source';
  }
  if (scope === 'notes') {
    return kind === 'note';
  }
  if (scope === 'sources') {
    return kind === 'source';
  }
  return false;
}

function resolveVectorHit(index: KbIndex, rawEntryId: string, score: number): VectorRetrievalHit | null {
  const entryId = parseKbEntryId(rawEntryId);
  if (entryId === null) {
    return null;
  }

  const entry = getEntry(index, entryId);
  if (entry === undefined || (!isNoteEntry(entry) && !isSourceEntry(entry))) {
    return null;
  }

  return {
    entryId,
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    tags: [...entry.tags],
    principles: isNoteEntry(entry) ? [...entry.principles] : [],
    score,
    rank: 0,
  };
}

function aggregateVectorHits(
  hits: Array<{ entryId: string; score: number }>,
  index: KbIndex,
  scope: RetrievalScope | undefined,
): VectorRetrievalHit[] {
  const aggregated = new Map<KbEntryId, VectorRetrievalHit>();

  for (const hit of hits) {
    const resolved = resolveVectorHit(index, hit.entryId, hit.score);
    if (resolved === null || !scopeAllowsVectorKind(scope, resolved.kind)) {
      continue;
    }

    const previous = aggregated.get(resolved.entryId);
    if (previous === undefined || resolved.score > previous.score) {
      aggregated.set(resolved.entryId, resolved);
    }
  }

  return [...aggregated.values()]
    .sort(compareScoreAndEntryId)
    .map((hit, indexPosition) => ({
      ...hit,
      rank: indexPosition + 1,
    }));
}

export class NeedleBackend implements VectorRetrieval, CorpusConsumerRegistration {
  readonly authority = 'corpus';
  readonly backendKind = 'needle';
  readonly corpusInterest = 'content';
  readonly registrationKind = 'equipment';
  readonly id: string;
  onApplyFailure?: (error: ConsumerApplyError) => void;

  private addonPath: string;
  private pluginRoot?: string;
  private storeFactory?: NeedleBackendOptions['storeFactory'];
  private activeHandle: ActiveNeedleHandle | null = null;
  private readonly retiredHandles = new Set<ActiveNeedleHandle>();

  constructor(
    private readonly runtime: KbRuntime,
    options: NeedleBackendOptions,
  ) {
    this.id = options.consumerId ?? NEEDLE_CONSUMER_ID;
    this.addonPath = options.addonPath;
    this.pluginRoot = options.pluginRoot;
    this.storeFactory = options.storeFactory;
  }

  configure(options: NeedleBackendOptions): void {
    this.addonPath = options.addonPath;
    if (options.pluginRoot !== undefined) {
      this.pluginRoot = options.pluginRoot;
    }
    if (options.storeFactory !== undefined) {
      this.storeFactory = options.storeFactory;
    }
  }

  isSnapshotStale(): boolean {
    const latest = readCorpusState(this.runtime.db);
    const cursor = this.readConsumerCursor();
    return cursor.contentManifestHash !== '' && cursor.contentManifestHash !== latest.contentManifestHash;
  }

  isSearchReady(): boolean {
    if (this.resolveInstalledAddonPath() === null) {
      return false;
    }

    const cursor = this.readConsumerCursor();
    if (cursor.snapshotId === '' || cursor.contentManifestHash === '' || this.isSnapshotStale()) {
      return false;
    }

    const manifest = readSnapshotManifest(this.runtime.runtimeDir, cursor.snapshotId);
    return manifest !== null && this.snapshotMatchesCursor(manifest, cursor);
  }

  async search(embedding: number[], topK: number, scope?: RetrievalScope): Promise<VectorRetrievalResult> {
    if (topK <= 0 || !this.isSearchReady()) {
      return { hits: [] };
    }

    const query = toUnitVector(embedding);
    if (query === null) {
      return { hits: [] };
    }

    const cursor = this.readConsumerCursor();
    const lease = await this.acquireActiveHandle(cursor.snapshotId);
    if (lease === null) {
      return { hits: [] };
    }

    try {
      const index = this.runtime.readIndexOrEmpty();
      let candidateK = Math.max(topK, 1);
      const candidateCap = Math.max(topK, VECTOR_CANDIDATE_CAP_MULTIPLIER * topK);
      let chunkHits = await lease.handle.store.searchVector(query, candidateK);
      let hits = aggregateVectorHits(chunkHits, index, scope);
      let exhausted = chunkHits.length < candidateK;

      while (hits.length < topK && !exhausted && candidateK < candidateCap) {
        const nextCandidateK = Math.min(candidateCap, candidateK * 2);
        if (nextCandidateK === candidateK) {
          break;
        }

        candidateK = nextCandidateK;
        chunkHits = await lease.handle.store.searchVector(query, candidateK);
        hits = aggregateVectorHits(chunkHits, index, scope);
        exhausted = chunkHits.length < candidateK;
      }

      return {
        hits: hits.slice(0, topK).map((hit, indexPosition) => ({
          ...hit,
          rank: indexPosition + 1,
        })),
      };
    } finally {
      await lease.release();
    }
  }

  async apply(ctx: NeedleApplyContext): Promise<void> {
    void ctx.db;

    if (this.resolveInstalledAddonPath() === null) {
      return;
    }

    const desiredSpec = resolveEmbeddingProviderConfig();
    if (desiredSpec === null) {
      throw new Error('KB needle backend requires an embedding provider configuration.');
    }

    const stagingDir = await this.stageSnapshot(ctx.snapshot, desiredSpec);
    let preserveStagingDir = false;
    try {
      await needleBackendStagingHookForTests?.({
        snapshot: ctx.snapshot,
        stagingDir,
        specId: desiredSpec.specId,
      });
      await this.installStagedSnapshot(stagingDir, ctx.snapshot.snapshotId, desiredSpec.specId);
    } catch (error: unknown) {
      preserveStagingDir = error instanceof NeedleBackendSimulatedCrashError;
      throw error;
    } finally {
      if (!preserveStagingDir) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  }

  async close(): Promise<void> {
    const handles = [
      this.activeHandle,
      ...this.retiredHandles,
    ].filter((handle): handle is ActiveNeedleHandle => handle !== null);

    this.activeHandle = null;
    this.retiredHandles.clear();

    for (const handle of handles) {
      if (handle.closed) {
        continue;
      }
      handle.closed = true;
      await handle.close().catch(() => {});
    }
  }

  private readConsumerCursor(): NeedleCursorView {
    const row = this.runtime.db
      .prepare(
        `
          SELECT snapshot_id, content_seq, content_manifest_hash
            FROM equipment_cursors
           WHERE consumer_id = ?
        `,
      )
      .get(this.id) as
      | {
          snapshot_id: string | null;
          content_seq: number | null;
          content_manifest_hash: string | null;
        }
      | undefined;

    return {
      snapshotId: row?.snapshot_id ?? '',
      contentSeq: row?.content_seq ?? 0,
      contentManifestHash: row?.content_manifest_hash ?? '',
    };
  }

  private resolveInstalledAddonPath(): string | null {
    return existsSync(this.addonPath) ? this.addonPath : null;
  }

  private snapshotMatchesCursor(manifest: NeedleSnapshotManifest, cursor: NeedleCursorView): boolean {
    return (
      manifest.snapshot.snapshotId === cursor.snapshotId &&
      manifest.snapshot.contentSeq === cursor.contentSeq &&
      manifest.snapshot.contentManifestHash === cursor.contentManifestHash
    );
  }

  private collectVectorEntries(): StagedVectorEntry[] {
    const index = this.runtime.readIndexOrEmpty();

    return Object.entries(index.entries)
      .sort(([leftEntryId], [rightEntryId]) => leftEntryId.localeCompare(rightEntryId))
      .flatMap(([entryId, entry]) => {
        if (isNoteEntry(entry)) {
          return [{
            entryId: entryId as KbEntryId,
            chunks: chunkEntry(entry, loadKbNote(this.runtime.notePath(entry.slug)).body),
          }];
        }
        if (isSourceEntry(entry)) {
          return [{
            entryId: entryId as KbEntryId,
            chunks: chunkEntry(entry, loadKbSource(this.runtime.sourcePath(entry.slug)).body),
          }];
        }
        return [];
      });
  }

  private async stageSnapshot(snapshot: NeedleApplyContext['snapshot'], desiredSpec: EmbeddingProviderConfig): Promise<string> {
    const stagingDir = join(needleStagingDir(this.runtime.runtimeDir), snapshot.snapshotId);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    const stagedStore = await this.openStore(
      join(stagingDir, NEEDLE_STORE_FILE),
      createHandleToken(`needle-stage-${snapshot.snapshotId}`),
    );
    if (stagedStore === null) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw new Error('KB needle backend is unavailable.');
    }

    try {
      const currentSpec = await stagedStore.store.getActiveSpec();
      if (currentSpec?.specId !== desiredSpec.specId) {
        await stagedStore.store.setActiveSpec({
          specId: desiredSpec.specId,
          provider: desiredSpec.name,
          model: desiredSpec.model,
          dims: desiredSpec.dims,
          normalization: desiredSpec.normalization,
          createdAt: currentSpec?.createdAt ?? new Date().toISOString(),
        });
      }

      const vectorEntries = this.collectVectorEntries();
      const chunks = vectorEntries.flatMap((entry) => entry.chunks);
      if (chunks.length > 0) {
        const provider = await createEmbeddingProvider(this.runtime.runtimeDir, desiredSpec);
        if (provider === null) {
          throw new Error('KB needle backend could not initialize the embedding provider.');
        }

        const vectors = await provider.embedDocuments(chunks.map((chunk) => chunk.text));
        const upserts = chunks.map((chunk, indexPosition) => {
          const vector = vectors[indexPosition];
          if (vector === undefined) {
            throw new Error(`Embedding provider returned too few vectors for ${chunk.entryId}.`);
          }

          return {
            ...chunk,
            specId: desiredSpec.specId,
            vector,
          };
        });

        await stagedStore.store.upsertChunks(upserts);
      }

      await stagedStore.store.buildIndex();
      writeSnapshotManifest(stagingDir, {
        snapshot: {
          snapshotId: snapshot.snapshotId,
          contentSeq: snapshot.contentSeq,
          contentManifestHash: snapshot.contentManifestHash,
        },
        specId: desiredSpec.specId,
        entryCount: vectorEntries.length,
        chunkCount: chunks.length,
      });
    } catch (error: unknown) {
      await stagedStore.close().catch(() => {});
      rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }

    await stagedStore.close();
    return stagingDir;
  }

  private async installStagedSnapshot(stagingDir: string, snapshotId: string, specId: string): Promise<void> {
    const finalSnapshotDir = needleSnapshotDir(this.runtime.runtimeDir, snapshotId);
    mkdirSync(dirname(finalSnapshotDir), { recursive: true });
    rmSync(finalSnapshotDir, { recursive: true, force: true });
    renameSync(stagingDir, finalSnapshotDir);

    try {
      const nextHandle = await this.loadHandleFromSnapshot(snapshotId, specId);
      if (nextHandle === null) {
        throw new Error(`Needle snapshot ${snapshotId} could not be opened after install.`);
      }

      writeActiveSnapshotId(this.runtime.runtimeDir, snapshotId);
      this.publishActiveHandle(nextHandle);
    } catch (error: unknown) {
      rmSync(finalSnapshotDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async acquireActiveHandle(expectedSnapshotId: string): Promise<ActiveNeedleLease | null> {
    const handle = await this.ensureActiveHandleLoaded(expectedSnapshotId);
    if (handle === null || handle.closed || handle.snapshotId !== expectedSnapshotId) {
      return null;
    }

    handle.leaseCount += 1;
    let released = false;
    return {
      handle,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        await this.maybeCloseRetiredHandle(handle);
      },
    };
  }

  private async ensureActiveHandleLoaded(expectedSnapshotId: string): Promise<ActiveNeedleHandle | null> {
    const current = this.activeHandle;
    if (current !== null && !current.closed && current.snapshotId === expectedSnapshotId) {
      return current;
    }

    try {
      const nextHandle = await this.loadHandleFromSnapshot(expectedSnapshotId);
      if (nextHandle === null) {
        return null;
      }
      this.publishActiveHandle(nextHandle);
      return nextHandle;
    } catch (error: unknown) {
      backendLog.warn(`KB needle backend could not load snapshot ${expectedSnapshotId}: ${errorMessage(error)}`);
      return null;
    }
  }

  private async loadHandleFromSnapshot(snapshotId: string, expectedSpecId?: string): Promise<ActiveNeedleHandle | null> {
    const manifest = readSnapshotManifest(this.runtime.runtimeDir, snapshotId);
    if (manifest === null) {
      return null;
    }
    if (expectedSpecId !== undefined && manifest.specId !== expectedSpecId) {
      return null;
    }

    const opened = await this.openStore(
      needleSnapshotDbPath(this.runtime.runtimeDir, snapshotId),
      createHandleToken(`needle-active-${snapshotId}`),
    );
    if (opened === null) {
      return null;
    }

    const currentSpec = await opened.store.getActiveSpec();
    if (currentSpec?.specId !== manifest.specId) {
      await opened.close().catch(() => {});
      return null;
    }

    return {
      ...opened,
      snapshotId,
      specId: manifest.specId,
      leaseCount: 0,
      retired: false,
      closed: false,
    };
  }

  private publishActiveHandle(handle: ActiveNeedleHandle): void {
    const previous = this.activeHandle;
    this.activeHandle = handle;

    if (previous !== null && previous !== handle) {
      previous.retired = true;
      this.retiredHandles.add(previous);
      void this.maybeCloseRetiredHandle(previous);
    }
  }

  private async maybeCloseRetiredHandle(handle: ActiveNeedleHandle): Promise<void> {
    if (!handle.retired || handle.closed || handle.leaseCount !== 0) {
      return;
    }

    handle.closed = true;
    this.retiredHandles.delete(handle);
    await handle.close().catch(() => {});
  }

  private async openStore(dbPath: string, handleToken: string): Promise<OpenedNeedleStore | null> {
    const sourceAddonPath = this.resolveInstalledAddonPath();
    if (sourceAddonPath === null) {
      return null;
    }

    const handleDir = needleHandleDir(this.runtime.runtimeDir, handleToken);
    const addonPath = join(handleDir, 'coral-needle.node');
    mkdirSync(handleDir, { recursive: true });
    copyFileSync(sourceAddonPath, addonPath);

    const store =
      this.storeFactory?.(this.runtime.runtimeDir) ??
      createNeedleStore({
        ...(this.pluginRoot === undefined ? {} : { pluginRoot: this.pluginRoot }),
        runtimeDir: this.runtime.runtimeDir,
        addonPath,
      });
    if (store === null) {
      rmSync(handleDir, { recursive: true, force: true });
      return null;
    }

    try {
      await store.init(dbPath);
    } catch (error: unknown) {
      await store.close().catch(() => {});
      rmSync(handleDir, { recursive: true, force: true });
      throw error;
    }

    return {
      store,
      async close() {
        await store.close().catch(() => {});
        rmSync(handleDir, { recursive: true, force: true });
      },
    };
  }
}

/** Returns the shared KB needle backend for a runtime so coordinator wiring stays single-instance. */
export function createNeedleBackend(runtime: KbRuntime, options: NeedleBackendOptions): NeedleBackend {
  const existing = SHARED_NEEDLE_BACKENDS.get(runtime);
  if (existing !== undefined) {
    existing.configure(options);
    return existing;
  }

  const backend = new NeedleBackend(runtime, options);
  SHARED_NEEDLE_BACKENDS.set(runtime, backend);
  return backend;
}

export class NeedleBackendSimulatedCrashError extends Error {
  constructor(message = 'Simulated needle staging crash') {
    super(message);
    this.name = 'NeedleBackendSimulatedCrashError';
    Object.setPrototypeOf(this, NeedleBackendSimulatedCrashError.prototype);
  }
}

export function __setNeedleBackendStagingHookForTests(hook: NeedleBackendStagingHook | null): void {
  needleBackendStagingHookForTests = hook;
}

/** Releases the shared KB needle backend and any leased snapshot handles for a runtime. */
export async function closeNeedleBackend(runtime: KbRuntime): Promise<void> {
  const backend = SHARED_NEEDLE_BACKENDS.get(runtime);
  if (backend === undefined) {
    return;
  }

  SHARED_NEEDLE_BACKENDS.delete(runtime);
  await backend.close();
}
