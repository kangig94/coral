import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { Backed, EmbeddingService, KbEngineRuntime, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import type { ConsumerApplyError, CorpusConsumerApplyContext } from '../../store/consumer-contract.js';
import type { KbProjectionInput } from '../../kb/projection-input-contract.js';
import {
  getEntry,
  isNoteEntry,
  isSourceEntry,
  parseKbEntryId,
  type KbEntryId,
  type KbIndex,
} from '../../kb/entry-types.js';
import {
  NEEDLE_STORE_FILE,
  needleActivePointerPath,
  needleAddonPath,
  needleIndexDir,
  needleSnapshotDbPath,
  needleSnapshotDir,
  needleSnapshotManifestPath,
  needleStagingDir,
} from './paths.js';
import { chunkEntry, type ChunkSeed } from '../../kb/chunking.js';
import { createNeedleStore, type ChunkRecord, type NeedleStore } from './store.js';
import { resolveBoundNeedleEmbedder, type ResolvedNeedleEmbedder } from './projection-identity.js';
import {
  NEEDLE_CONSUMER_ID,
  type NeedleBackend as NeedleBackendContract,
  type NeedleBackendOptions,
} from './contract.js';
import { isNeedleSnapshotManifest, type NeedleSnapshotManifest } from './artifact-port.js';
import type {
  RetrievalKind,
  RetrievalScope,
  VectorRetrievalHit,
  VectorRetrievalResult,
  VectorRetrieval as BoundVectorRetrieval,
} from '../../kb/search/contract.js';
import type { Runtime } from '../../runtime/ports.js';

const VECTOR_CANDIDATE_CAP_MULTIPLIER = 10;

type NeedleBackendStagingHook = (ctx: {
  snapshot: NeedleApplyContext['snapshot'];
  stagingDir: string;
  specId: string;
}) => void | Promise<void>;

type NeedleApplyContext = CorpusConsumerApplyContext;

type NeedleCursorView = {
  snapshotId: string;
  contentSeq: number;
  metadataSeq: number;
  contentManifestHash: string;
  metadataManifestHash: string;
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

const SHARED_NEEDLE_BACKENDS = new WeakMap<object, NeedleBackend>();
let needleBackendStagingHookForTests: NeedleBackendStagingHook | null = null;

function needleHandleDir(runtimeDir: string, handleToken: string): string {
  return join(needleIndexDir(runtimeDir), 'handles', handleToken);
}

function writeActiveSnapshotId(
  files: Pick<KbProjectionArtifactFilePort, 'writeTextAtomic'>,
  runtimeDir: string,
  snapshotId: string,
): void {
  files.writeTextAtomic(needleActivePointerPath(runtimeDir), `${snapshotId}\n`);
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

function writeSnapshotManifest(
  files: Pick<KbProjectionArtifactFilePort, 'writeTextAtomic'>,
  snapshotDir: string,
  manifest: NeedleSnapshotManifest,
): void {
  files.writeTextAtomic(needleSnapshotManifestPath(snapshotDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createHandleToken(runtime: KbEngineRuntime, prefix: string): string {
  return `${prefix}-${runtime.time.now()}-${runtime.ids.uuid()}`;
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

  for (let index = 0; index < embedding.length; index += 1) {
    const value = embedding[index];
    if (value === undefined) {
      return null;
    }
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

function scopeAllowsVectorKind(scope: RetrievalScope | undefined, kind: RetrievalKind): boolean {
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

  const ranked = [...aggregated.values()].sort(compareScoreAndEntryId);
  for (let indexPosition = 0; indexPosition < ranked.length; indexPosition += 1) {
    const hit = ranked[indexPosition];
    if (hit !== undefined) {
      hit.rank = indexPosition + 1;
    }
  }
  return ranked;
}

export class NeedleBackend implements NeedleBackendContract {
  readonly authority = 'corpus';
  readonly corpusInterest = 'content';
  readonly kind = 'apply';
  registrationKind: 'base' | 'expansion' = 'expansion';
  readonly id: string;
  onApplyFailure?: (error: ConsumerApplyError) => void;

  private addonPath: string;
  private pluginRoot?: string;
  private storeFactory?: NeedleBackendOptions['storeFactory'];
  private boundEmbedder?: ResolvedNeedleEmbedder;
  private activeHandle: ActiveNeedleHandle | null = null;
  private readonly retiredHandles = new Set<ActiveNeedleHandle>();

  constructor(
    private readonly runtime: KbEngineRuntime,
    options: NeedleBackendOptions & { embedder?: ResolvedNeedleEmbedder },
  ) {
    this.id = options.consumerId ?? NEEDLE_CONSUMER_ID;
    this.addonPath = options.addonPath;
    this.pluginRoot = options.pluginRoot;
    this.storeFactory = options.storeFactory;
    this.boundEmbedder = options.embedder;
  }

  configure(options: NeedleBackendOptions & { embedder?: ResolvedNeedleEmbedder }): void {
    this.addonPath = options.addonPath;
    if (options.pluginRoot !== undefined) {
      this.pluginRoot = options.pluginRoot;
    }
    if (options.storeFactory !== undefined) {
      this.storeFactory = options.storeFactory;
    }
    if (options.embedder !== undefined) {
      this.boundEmbedder = options.embedder;
    }
  }

  isSnapshotStale(): boolean {
    const latest = this.runtime.corpusStateReader.readCurrentSnapshot();
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
      const index = this.runtime.corpusProjectionReader.resolveCurrentIndex();
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
    if (this.resolveInstalledAddonPath() === null) {
      return;
    }

    const embedder = this.boundEmbedder ?? null;
    if (embedder === null) {
      throw new Error('KB needle backend requires an embedding provider configuration.');
    }

    const stagingDir = await this.stageSnapshot(ctx.snapshot, embedder, ctx.projectionInput);
    let preserveStagingDir = false;
    try {
      await needleBackendStagingHookForTests?.({
        snapshot: ctx.snapshot,
        stagingDir,
        specId: embedder.spec.specId,
      });
      await this.installStagedSnapshot(stagingDir, ctx.snapshot.snapshotId, embedder.spec.specId);
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
    const activeHandle = this.activeHandle;
    const retiredHandles = [...this.retiredHandles];

    this.activeHandle = null;
    this.retiredHandles.clear();

    if (activeHandle !== null && !activeHandle.closed) {
      activeHandle.closed = true;
      await activeHandle.close().catch(() => {});
    }

    for (const handle of retiredHandles) {
      if (!handle.closed) {
        handle.closed = true;
        await handle.close().catch(() => {});
      }
    }
  }

  private readConsumerCursor(): NeedleCursorView {
    const cursor = this.runtime.corpusStateReader.readConsumerCursor(this.id);
    return {
      snapshotId: cursor.snapshotId,
      contentSeq: cursor.contentSeq,
      metadataSeq: cursor.metadataSeq,
      contentManifestHash: cursor.contentManifestHash,
      metadataManifestHash: cursor.metadataManifestHash,
    };
  }

  private resolveInstalledAddonPath(): string | null {
    return existsSync(this.addonPath) ? this.addonPath : null;
  }

  private snapshotMatchesCursor(manifest: NeedleSnapshotManifest, cursor: NeedleCursorView): boolean {
    return (
      manifest.snapshot.snapshotId === cursor.snapshotId &&
      manifest.snapshot.contentSeq === cursor.contentSeq &&
      manifest.snapshot.metadataSeq === cursor.metadataSeq &&
      manifest.snapshot.contentManifestHash === cursor.contentManifestHash &&
      manifest.snapshot.metadataManifestHash === cursor.metadataManifestHash
    );
  }

  private collectVectorEntries(input: KbProjectionInput): StagedVectorEntry[] {
    const entries: StagedVectorEntry[] = [];
    for (const record of input.records) {
      if (record.kind !== 'note' && record.kind !== 'source') {
        continue;
      }

      entries.push({
        entryId: `${record.kind}:${record.entry.slug}` as KbEntryId,
        chunks: chunkEntry(record.entry, record.body),
      });
    }
    return entries;
  }

  private async stageSnapshot(
    snapshot: NeedleApplyContext['snapshot'],
    embedder: ResolvedNeedleEmbedder,
    input: KbProjectionInput,
  ): Promise<string> {
    const desiredSpec = embedder.spec;
    const stagingDir = join(needleStagingDir(this.runtime.runtimeDir), snapshot.snapshotId);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });

    const stagedStore = await this.openStore(
      join(stagingDir, NEEDLE_STORE_FILE),
      createHandleToken(this.runtime, `needle-stage-${snapshot.snapshotId}`),
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
          provider: desiredSpec.provider,
          model: desiredSpec.model,
          dims: desiredSpec.dims,
          normalization: desiredSpec.normalization,
          createdAt: currentSpec?.createdAt ?? nowIsoString(this.runtime.time),
        });
      }

      const vectorEntries = this.collectVectorEntries(input);
      const chunks: ChunkSeed[] = [];
      for (const entry of vectorEntries) {
        for (const chunk of entry.chunks) {
          chunks.push(chunk);
        }
      }
      if (chunks.length > 0) {
        const texts: string[] = [];
        for (const chunk of chunks) {
          texts.push(chunk.text);
        }

        const vectors = await embedder.service.embedDocuments(texts);
        const upserts: ChunkRecord[] = [];
        for (let indexPosition = 0; indexPosition < chunks.length; indexPosition += 1) {
          const chunk = chunks[indexPosition];
          if (chunk === undefined) {
            continue;
          }
          const vector = vectors[indexPosition];
          if (vector === undefined) {
            throw new Error(`Embedding provider returned too few vectors for ${chunk.entryId}.`);
          }

          upserts.push({
            ...chunk,
            specId: desiredSpec.specId,
            vector,
          });
        }

        await stagedStore.store.upsertChunks(upserts);
      }

      await stagedStore.store.buildIndex();
      writeSnapshotManifest(this.runtime.projectionArtifacts.files, stagingDir, {
        snapshot: {
          snapshotId: snapshot.snapshotId,
          contentSeq: snapshot.contentSeq,
          metadataSeq: snapshot.metadataSeq,
          contentManifestHash: snapshot.contentManifestHash,
          metadataManifestHash: snapshot.metadataManifestHash,
          projectionIdentityHash: embedder.projectionIdentityHash,
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

      writeActiveSnapshotId(this.runtime.projectionArtifacts.files, this.runtime.runtimeDir, snapshotId);
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

  private async loadHandleFromSnapshot(
    snapshotId: string,
    expectedSpecId?: string,
  ): Promise<ActiveNeedleHandle | null> {
    const manifest = readSnapshotManifest(this.runtime.runtimeDir, snapshotId);
    if (manifest === null) {
      return null;
    }
    if (expectedSpecId !== undefined && manifest.specId !== expectedSpecId) {
      return null;
    }

    const opened = await this.openStore(
      needleSnapshotDbPath(this.runtime.runtimeDir, snapshotId),
      createHandleToken(this.runtime, `needle-active-${snapshotId}`),
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
export function createNeedleBackend(
  runtime: KbEngineRuntime,
  options: NeedleBackendOptions & { embedder?: ResolvedNeedleEmbedder },
): NeedleBackend {
  const existing = SHARED_NEEDLE_BACKENDS.get(runtime);
  if (existing !== undefined) {
    existing.configure(options);
    return existing;
  }

  const backend = new NeedleBackend(runtime, options);
  SHARED_NEEDLE_BACKENDS.set(runtime, backend);
  return backend;
}

export async function createNeedleBacked(
  kbRuntime: KbEngineRuntime,
  runtime: Pick<Runtime, 'paths'>,
  embedder: Backed<EmbeddingService>,
  resolvedEmbedder: ResolvedNeedleEmbedder = resolveBoundNeedleEmbedder(embedder),
): Promise<Backed<BoundVectorRetrieval>> {
  const backend = new NeedleBackend(kbRuntime, {
    addonPath: needleAddonPath(runtime),
    embedder: resolvedEmbedder,
  });
  const retrieval: BoundVectorRetrieval = {
    search(embedding, topK, scope) {
      return backend.search(embedding, topK, scope);
    },
  };

  return {
    read: () => retrieval,
    consumer: backend,
  };
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
export async function closeNeedleBackend(runtime: object): Promise<void> {
  const backend = SHARED_NEEDLE_BACKENDS.get(runtime);
  if (backend === undefined) {
    return;
  }

  SHARED_NEEDLE_BACKENDS.delete(runtime);
  await backend.close();
}
