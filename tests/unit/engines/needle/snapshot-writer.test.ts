import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NeedleSnapshotWriter } from '#src/engines/needle/snapshot-writer.js';
import type { ResolvedNeedleEmbedder } from '#src/engines/needle/projection-identity.js';
import type { ChunkRecord, EmbeddingSpec, NeedleStore } from '#src/engines/needle/store.js';
import type { KbProjectionInput } from '#src/kb/projection-input-contract.js';
import { noteEntryId, type NoteEntry } from '#src/kb/entry-types.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe('NeedleSnapshotWriter', () => {
  it('embeds and upserts snapshot chunks in bounded batches before publishing a manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'needle-writer-'));
    tempRoots.add(root);
    const snapshotDir = join(root, 'snapshot');
    const embedBatchSizes: number[] = [];
    const upsertBatchSizes: number[] = [];
    const store = createMemoryNeedleStore(upsertBatchSizes);
    const embedder = createBatchRecordingEmbedder(embedBatchSizes);

    const writer = new NeedleSnapshotWriter({
      runtime: {
        time: { now: () => 1_765_000_000_000 },
        projectionArtifacts: {
          files: {
            writeTextAtomic: (path, content) => {
              mkdirSyncForFile(path);
              writeFileText(path, content);
            },
          },
        },
      },
      store,
      snapshotDir,
      snapshot: {
        snapshotId: 'snapshot-1',
        contentSeq: 10,
        metadataSeq: 20,
        contentManifestHash: 'content-hash',
        metadataManifestHash: 'metadata-hash',
      },
      input: createProjectionInput(129),
      embedder,
    });

    await expect(writer.write()).resolves.toEqual({ entryCount: 129, chunkCount: 129 });

    expect(embedBatchSizes).toEqual([128, 1]);
    expect(upsertBatchSizes).toEqual([128, 1]);
    expect(store.chunks).toHaveLength(129);
    expect(JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf-8'))).toMatchObject({
      snapshot: {
        snapshotId: 'snapshot-1',
        contentSeq: 10,
        metadataSeq: 20,
        contentManifestHash: 'content-hash',
        metadataManifestHash: 'metadata-hash',
        projectionIdentityHash: 'projection-hash',
      },
      specId: 'test-spec',
      entryCount: 129,
      chunkCount: 129,
    });
  });
});

function createMemoryNeedleStore(upsertBatchSizes: number[]): NeedleStore & { readonly chunks: ChunkRecord[] } {
  let activeSpec: EmbeddingSpec | null = null;
  const chunks: ChunkRecord[] = [];
  return {
    chunks,
    async init() {},
    async close() {},
    async upsertChunks(batch) {
      upsertBatchSizes.push(batch.length);
      chunks.push(...batch);
    },
    async removeByEntryId() {},
    async searchVector() {
      return [];
    },
    async buildIndex() {},
    async getActiveSpec() {
      return activeSpec;
    },
    async setActiveSpec(spec) {
      activeSpec = spec;
    },
    async stats() {
      return {
        chunkCount: chunks.length,
        specId: activeSpec?.specId ?? null,
        engineName: 'memory',
        addonVersion: 'test',
        napiVersion: 8,
        schemaVersion: 1,
      };
    },
  };
}

function createBatchRecordingEmbedder(batchSizes: number[]): ResolvedNeedleEmbedder {
  return {
    service: {
      async embedDocuments(texts) {
        batchSizes.push(texts.length);
        return texts.map((text, index) => Float32Array.from([text.length, index + 1]));
      },
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
    },
    spec: {
      specId: 'test-spec',
      provider: 'test',
      model: 'test-model',
      dims: 2,
      normalization: 'l2',
    },
    projectionIdentityHash: 'projection-hash',
  };
}

function createProjectionInput(count: number): KbProjectionInput {
  const entries: Record<string, NoteEntry> = {};
  const records: Array<KbProjectionInput['records'][number]> = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `note-${String(index).padStart(3, '0')}`;
    const entry: NoteEntry = {
      kind: 'note',
      slug,
      title: `Note ${index}`,
      tags: ['needle'],
      principles: [],
      source: [],
      createdAt: '2026-05-05T00:00:00.000Z',
      updatedAt: '2026-05-05T00:00:00.000Z',
      bodyHash: `note-${index}-body-hash`,
      entrySeq: index + 1,
    };
    entries[noteEntryId(slug)] = entry;
    records.push({
      kind: 'note',
      entry,
      body: `Body ${index}.`,
    });
  }

  return {
    index: {
      entries,
      principles: {},
      entityMeta: {},
      relationships: [],
    },
    records,
    communityFresh: true,
  };
}

function mkdirSyncForFile(path: string): void {
  const dir = dirname(path);
  if (dir !== '.') {
    mkdirSync(dir, { recursive: true });
  }
}

function writeFileText(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}
