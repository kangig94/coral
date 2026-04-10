import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, isRecord } from '../../shared/utils.js';
import { chunkEntry, type ChunkSeed } from './chunking.js';
import { createEmbeddingProvider, resolveEmbeddingProviderConfig, type EmbeddingProviderConfig } from './embedding.js';
import type { KbIndexState, KbRuntime, KbVectorSpecState, KbVectorTextSnapshot } from '../contracts.js';
import { writeFileAtomic } from '../mutation-helpers.js';
import { readActiveSnapshotId, vectorSnapshotDir, vectorSnapshotsDir, writeActiveSnapshotId } from './store.js';

const VECTOR_STAGING_DIR = 'vec-staging';
const VECTOR_MANIFEST_FILE = 'manifest.json';
const VECTOR_STORE_FILE = 'store.duckdb';

type VectorManifestEntry = {
  entryKind: 'note' | 'source';
  contentHash: string;
  chunkIds: string[];
};

type VectorManifest = {
  specId: string;
  entries: Record<string, VectorManifestEntry>;
};

type VectorSnapshotEntry = {
  entryId: string;
  entryKind: 'note' | 'source';
  contentHash: string;
  chunks: ChunkSeed[];
};

export type EnsureVectorIndexResult = {
  mode: 'text' | 'hybrid';
  specId: string | null;
  vectorStatus: KbVectorSpecState | null;
  warning?: string;
};

function vectorStagingRoot(runtimeDir: string): string {
  return join(runtimeDir, VECTOR_STAGING_DIR);
}

function vectorManifestPath(snapshotDir: string): string {
  return join(snapshotDir, VECTOR_MANIFEST_FILE);
}

function stagingDbPath(stagingDir: string): string {
  return join(stagingDir, VECTOR_STORE_FILE);
}

function nextSnapshotId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashEntryChunks(chunks: ChunkSeed[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        chunks.map((chunk) => ({
          id: chunk.id,
          contentHash: chunk.contentHash,
        })),
      ),
    )
    .digest('hex');
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isManifestEntry(value: unknown): value is VectorManifestEntry {
  return (
    isRecord(value) &&
    (value.entryKind === 'note' || value.entryKind === 'source') &&
    typeof value.contentHash === 'string' &&
    Array.isArray(value.chunkIds) &&
    value.chunkIds.every((chunkId) => typeof chunkId === 'string')
  );
}

function readManifest(snapshotDir: string): VectorManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(vectorManifestPath(snapshotDir), 'utf8')) as unknown;
    if (!isRecord(parsed) || typeof parsed.specId !== 'string' || !isRecord(parsed.entries)) {
      return null;
    }

    const entries: Record<string, VectorManifestEntry> = {};
    for (const [entryId, entry] of Object.entries(parsed.entries)) {
      if (!isManifestEntry(entry)) {
        return null;
      }
      entries[entryId] = {
        entryKind: entry.entryKind,
        contentHash: entry.contentHash,
        chunkIds: [...entry.chunkIds],
      };
    }

    return {
      specId: parsed.specId,
      entries,
    };
  } catch {
    return null;
  }
}

function writeManifest(snapshotDir: string, manifest: VectorManifest): void {
  writeFileAtomic(vectorManifestPath(snapshotDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function buildDesiredManifest(
  textSnapshot: KbVectorTextSnapshot,
  specId: string,
): {
  manifest: VectorManifest;
  entries: Map<string, VectorSnapshotEntry>;
} {
  const manifestEntries: Record<string, VectorManifestEntry> = {};
  const entryMap = new Map<string, VectorSnapshotEntry>();

  for (const { entry, body } of [...textSnapshot.notes, ...textSnapshot.sources]) {
    const chunks = chunkEntry(entry, body);
    const entryId = chunks[0]?.entryId;
    if (entryId === undefined) {
      continue;
    }

    const contentHash = hashEntryChunks(chunks);
    manifestEntries[entryId] = {
      entryKind: entry.kind,
      contentHash,
      chunkIds: chunks.map((chunk) => chunk.id),
    };
    entryMap.set(entryId, {
      entryId,
      entryKind: entry.kind,
      contentHash,
      chunks,
    });
  }

  return {
    manifest: {
      specId,
      entries: manifestEntries,
    },
    entries: entryMap,
  };
}

function manifestMatches(left: VectorManifest, right: VectorManifest): boolean {
  const leftEntries = Object.entries(left.entries).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));
  const rightEntries = Object.entries(right.entries).sort(([leftId], [rightId]) => leftId.localeCompare(rightId));

  if (left.specId !== right.specId || leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([entryId, entry], index) => {
    const [rightEntryId, rightEntry] = rightEntries[index] ?? [];
    return (
      entryId === rightEntryId &&
      entry.entryKind === rightEntry?.entryKind &&
      entry.contentHash === rightEntry?.contentHash &&
      arraysEqual(entry.chunkIds, rightEntry?.chunkIds ?? [])
    );
  });
}

function diffManifest(
  desiredEntries: Map<string, VectorSnapshotEntry>,
  currentManifest: VectorManifest | null,
): {
  deletedEntryIds: string[];
  changedEntries: VectorSnapshotEntry[];
} {
  const deletedEntryIds =
    currentManifest === null
      ? []
      : Object.keys(currentManifest.entries).filter((entryId) => !desiredEntries.has(entryId));

  const changedEntries: VectorSnapshotEntry[] = [];
  for (const [entryId, desiredEntry] of desiredEntries) {
    const currentEntry = currentManifest?.entries[entryId];
    const desiredChunkIds = desiredEntry.chunks.map((chunk) => chunk.id);
    if (
      currentEntry === undefined ||
      currentEntry.entryKind !== desiredEntry.entryKind ||
      currentEntry.contentHash !== desiredEntry.contentHash ||
      !arraysEqual(currentEntry.chunkIds, desiredChunkIds)
    ) {
      changedEntries.push(desiredEntry);
    }
  }

  return {
    deletedEntryIds,
    changedEntries,
  };
}

function buildResult(state: KbIndexState, specId: string): EnsureVectorIndexResult {
  const vectorStatus = state.vector.bySpec[specId] ?? null;
  const isFresh =
    vectorStatus !== null &&
    vectorStatus.indexedSeq === state.contentSeq &&
    vectorStatus.staleReason === undefined &&
    vectorStatus.activeSnapshotId !== undefined;

  return {
    mode: isFresh ? 'hybrid' : 'text',
    specId,
    vectorStatus,
    ...(vectorStatus?.staleReason === undefined ? {} : { warning: vectorStatus.staleReason }),
  };
}

function isFreshVectorStatus(
  status: KbVectorSpecState | null,
  contentSeq: number,
  activeSnapshotId: string | null,
): status is KbVectorSpecState {
  return (
    status !== null &&
    status.indexedSeq === contentSeq &&
    status.staleReason === undefined &&
    status.activeSnapshotId === activeSnapshotId
  );
}

async function stageVectorSnapshot(params: {
  kb: KbRuntime;
  desiredSpec: EmbeddingProviderConfig;
  activeSnapshotId: string | null;
  manifest: VectorManifest;
  changedEntries: VectorSnapshotEntry[];
  deletedEntryIds: string[];
}): Promise<{ snapshotId: string; stagingDir: string }> {
  const { kb, desiredSpec, activeSnapshotId, manifest, changedEntries, deletedEntryIds } = params;
  const snapshotId = nextSnapshotId();
  const stagingDir = join(vectorStagingRoot(kb.runtimeDir), snapshotId);

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  if (activeSnapshotId !== null) {
    const activeDir = vectorSnapshotDir(kb.runtimeDir, desiredSpec.specId, activeSnapshotId);
    if (existsSync(activeDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
      cpSync(activeDir, stagingDir, { recursive: true });
    }
  }

  const stagedStore = await kb.openVectorStore(stagingDbPath(stagingDir), `stage-${snapshotId}`);
  if (stagedStore === null) {
    throw new Error('KB vector store is unavailable.');
  }

  try {
    const currentSpec = await stagedStore.store.getActiveSpec();
    if (currentSpec === null || currentSpec.specId !== desiredSpec.specId) {
      await stagedStore.store.setActiveSpec({
        specId: desiredSpec.specId,
        provider: desiredSpec.name,
        model: desiredSpec.model,
        dims: desiredSpec.dims,
        normalization: desiredSpec.normalization,
        createdAt: currentSpec?.createdAt ?? new Date().toISOString(),
      });
    }

    for (const entryId of deletedEntryIds) {
      await stagedStore.store.removeByEntryId(entryId);
    }

    if (changedEntries.length > 0) {
      const provider = await createEmbeddingProvider(kb.runtimeDir, desiredSpec);
      if (provider === null) {
        throw new Error('KB embedding provider is unavailable.');
      }

      const chunkTexts = changedEntries.flatMap((entry) => entry.chunks.map((chunk) => chunk.text));
      const vectors = await provider.embedDocuments(chunkTexts);
      let vectorOffset = 0;

      for (const entry of changedEntries) {
        await stagedStore.store.removeByEntryId(entry.entryId);

        const upserts = entry.chunks.map((chunk) => {
          const vector = vectors[vectorOffset];
          vectorOffset += 1;
          if (vector === undefined) {
            throw new Error(`Embedding provider returned too few vectors for ${entry.entryId}.`);
          }

          return {
            ...chunk,
            specId: desiredSpec.specId,
            vector,
          };
        });

        await stagedStore.store.upsertChunks(upserts);
      }
    }

    await stagedStore.store.buildIndex();
    writeManifest(stagingDir, manifest);
  } catch (error: unknown) {
    await stagedStore.close().catch(() => {});
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  await stagedStore.close();
  return { snapshotId, stagingDir };
}

export async function ensureVectorIndex(kb: KbRuntime): Promise<EnsureVectorIndexResult> {
  let desiredSpec: EmbeddingProviderConfig | null;
  try {
    desiredSpec = resolveEmbeddingProviderConfig();
  } catch (error: unknown) {
    return {
      mode: 'text',
      specId: null,
      vectorStatus: null,
      warning: `KB vector index is unavailable: ${errorMessage(error)}`,
    };
  }

  if (desiredSpec === null) {
    return {
      mode: 'text',
      specId: null,
      vectorStatus: null,
    };
  }

  let startContentSeq = 0;
  let textSnapshot: KbVectorTextSnapshot | null = null;
  let currentVectorStatus: KbVectorSpecState | null = null;
  let activeSnapshotId: string | null = null;
  let currentManifest: VectorManifest | null = null;

  await kb.withMutationLock(async () => {
    textSnapshot = await kb.ensureTextArtifactsFreshUnderLock();
    const stateAfterTextRefresh = kb.readIndexState();
    startContentSeq = stateAfterTextRefresh.contentSeq;
    currentVectorStatus = stateAfterTextRefresh.vector.bySpec[desiredSpec.specId] ?? null;
    activeSnapshotId =
      readActiveSnapshotId(kb.runtimeDir, desiredSpec.specId) ?? currentVectorStatus?.activeSnapshotId ?? null;
    currentManifest =
      activeSnapshotId === null
        ? null
        : readManifest(vectorSnapshotDir(kb.runtimeDir, desiredSpec.specId, activeSnapshotId));
  });

  if (textSnapshot === null) {
    throw new Error('KB text snapshot capture failed.');
  }

  const { manifest, entries } = buildDesiredManifest(textSnapshot, desiredSpec.specId);
  const activeHandle = kb.getActiveVectorHandleInfo();
  const vectorStatus = currentVectorStatus;
  const alreadyActive =
    activeHandle !== null && activeHandle.specId === desiredSpec.specId && activeHandle.snapshotId === activeSnapshotId;
  const stateAfterCapture = kb.readIndexState();
  const isCurrentVectorFresh =
    isFreshVectorStatus(vectorStatus, startContentSeq, activeSnapshotId) &&
    activeSnapshotId !== null &&
    currentManifest !== null &&
    manifestMatches(manifest, currentManifest) &&
    alreadyActive;
  if (isCurrentVectorFresh) {
    return buildResult(stateAfterCapture, desiredSpec.specId);
  }

  if (activeSnapshotId !== null && currentManifest !== null && manifestMatches(manifest, currentManifest)) {
    const reusedSnapshotId = activeSnapshotId;
    try {
      await kb.withMutationLock(async () => {
        if (kb.readIndexState().contentSeq !== startContentSeq) {
          kb.recordVectorSyncFailure(
            desiredSpec.specId,
            'KB vector index freshness changed during reuse.',
            reusedSnapshotId,
          );
          return;
        }

        const liveHandle = kb.getActiveVectorHandleInfo();
        if (liveHandle?.specId !== desiredSpec.specId || liveHandle.snapshotId !== reusedSnapshotId) {
          await kb.activateVectorSnapshot(desiredSpec.specId, reusedSnapshotId);
        }
        kb.recordVectorSyncSuccess(desiredSpec.specId, startContentSeq, reusedSnapshotId);
      });
    } catch (error: unknown) {
      kb.recordVectorSyncFailure(
        desiredSpec.specId,
        `KB vector index activation failed: ${errorMessage(error)}`,
        reusedSnapshotId,
      );
    }

    return buildResult(kb.readIndexState(), desiredSpec.specId);
  }

  const { deletedEntryIds, changedEntries } = diffManifest(entries, currentManifest);
  let stagedSnapshot: { snapshotId: string; stagingDir: string } | null = null;

  try {
    stagedSnapshot = await stageVectorSnapshot({
      kb,
      desiredSpec,
      activeSnapshotId,
      manifest,
      changedEntries,
      deletedEntryIds,
    });
  } catch (error: unknown) {
    kb.recordVectorSyncFailure(
      desiredSpec.specId,
      `KB vector index build failed: ${errorMessage(error)}`,
      activeSnapshotId ?? undefined,
    );
    return buildResult(kb.readIndexState(), desiredSpec.specId);
  }

  const snapshotToInstall = stagedSnapshot!;
  try {
    await kb.withMutationLock(async () => {
      if (kb.readIndexState().contentSeq !== startContentSeq) {
        kb.recordVectorSyncFailure(
          desiredSpec.specId,
          'KB vector index freshness changed during rebuild.',
          activeSnapshotId ?? undefined,
        );
        return;
      }

      const finalSnapshotDir = vectorSnapshotDir(kb.runtimeDir, desiredSpec.specId, snapshotToInstall.snapshotId);
      mkdirSync(vectorSnapshotsDir(kb.runtimeDir, desiredSpec.specId), { recursive: true });
      rmSync(finalSnapshotDir, { recursive: true, force: true });
      renameSync(snapshotToInstall.stagingDir, finalSnapshotDir);
      writeActiveSnapshotId(kb.runtimeDir, desiredSpec.specId, snapshotToInstall.snapshotId);
      await kb.activateVectorSnapshot(desiredSpec.specId, snapshotToInstall.snapshotId);
      kb.recordVectorSyncSuccess(desiredSpec.specId, startContentSeq, snapshotToInstall.snapshotId);
    });
  } catch (error: unknown) {
    kb.recordVectorSyncFailure(
      desiredSpec.specId,
      `KB vector index install failed: ${errorMessage(error)}`,
      activeSnapshotId ?? undefined,
    );
  } finally {
    if (stagedSnapshot !== null) {
      rmSync(stagedSnapshot.stagingDir, { recursive: true, force: true });
    }
  }

  return buildResult(kb.readIndexState(), desiredSpec.specId);
}
