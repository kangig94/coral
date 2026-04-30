import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NeedleStoreModule from '#src/engines/needle/store.js';

import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { persistCorpusState, readCorpusState } from '#src/kb/state/corpus-state.js';
import type { KbEngineRuntime, KbRuntime, VectorRetrieval as BoundVectorRetrieval } from '#src/kb/contract.js';
import type { ConsumerHandle } from '#src/store/consumer-contract.js';
import { bindEmbedding } from '#tests/unit/kb/expansion-test-helpers.js';

function createNotifyCorpusMutation(driver: ConsumerDriver) {
  return async (publication: {
    snapshot: ReturnType<typeof readCorpusState>;
    changedLanes: readonly ('content' | 'metadata')[];
  }) => {
    if (publication.changedLanes.length === 1) {
      driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
      return;
    }
    driver.notifyCorpus(publication.snapshot);
  };
}

function createNeedleRuntime(kb: KbRuntime, driver: ConsumerDriver): KbEngineRuntime {
  return {
    runtimeDir: kb.runtimeDir,
    time: kb.time,
    ids: kb.ids,
    projectionArtifacts: kb.projectionArtifacts,
    corpusProjectionReader: kb.corpusProjectionReader,
    journalReader: driver.getJournalReader(),
    corpusStateReader: driver.getCorpusStateReader(),
    vector: kb.vector,
    embedding: kb.embedding,
    fts: kb.fts,
  };
}

import { reindex } from '#src/kb/ops/reindex.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import {
  __setNeedleBackendStagingHookForTests,
  closeNeedleBackend,
  createNeedleBackend,
  NeedleBackendSimulatedCrashError,
} from '#src/engines/needle/backend.js';
import { NEEDLE_CONSUMER_ID } from '#src/engines/needle/contract.js';

const FIXED_NOW = new Date('2026-04-21T00:00:00.000Z');
const tempRoots: string[] = [];

type PersistedMockStore = {
  activeSpec: {
    specId: string;
    provider: string;
    model: string;
    dims: number;
    normalization: 'l2' | 'none';
    createdAt: string;
  } | null;
  chunks: Array<{
    id: string;
    entryId: string;
    entryKind: string;
    chunkIndex: number;
    text: string;
    contentHash: string;
    specId: string;
    vector: number[];
  }>;
  buildCount: number;
};

const mockState = vi.hoisted(() => ({
  openedDbPaths: [] as string[],
}));

vi.mock('#src/engines/needle/store.js', async () => {
  const actual = await vi.importActual<typeof NeedleStoreModule>('#src/engines/needle/store.js');

  function persistStore(dbPath: string, state: PersistedMockStore): void {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  function loadStore(dbPath: string): PersistedMockStore {
    if (!existsSync(dbPath)) {
      return {
        activeSpec: null,
        chunks: [],
        buildCount: 0,
      };
    }

    return JSON.parse(readFileSync(dbPath, 'utf-8')) as PersistedMockStore;
  }

  return {
    ...actual,
    createNeedleStore: vi.fn((_options: unknown) => {
      let dbPath: string | null = null;
      let state: PersistedMockStore = {
        activeSpec: null,
        chunks: [],
        buildCount: 0,
      };

      return {
        async init(nextDbPath: string) {
          dbPath = nextDbPath;
          mockState.openedDbPaths.push(nextDbPath);
          state = loadStore(nextDbPath);
        },
        async close() {
          if (dbPath !== null) {
            persistStore(dbPath, state);
          }
        },
        async upsertChunks(
          chunks: Array<{
            id: string;
            entryId: string;
            entryKind: string;
            chunkIndex: number;
            text: string;
            contentHash: string;
            specId: string;
            vector: Float32Array;
          }>,
        ) {
          const byChunkId = new Map(state.chunks.map((chunk) => [chunk.id, chunk]));
          for (const chunk of chunks) {
            byChunkId.set(chunk.id, {
              id: chunk.id,
              entryId: chunk.entryId,
              entryKind: chunk.entryKind,
              chunkIndex: chunk.chunkIndex,
              text: chunk.text,
              contentHash: chunk.contentHash,
              specId: chunk.specId,
              vector: [...chunk.vector],
            });
          }
          state.chunks = [...byChunkId.values()].sort((left, right) => left.id.localeCompare(right.id));
        },
        async removeByEntryId(entryId: string) {
          state.chunks = state.chunks.filter((chunk) => chunk.entryId !== entryId);
        },
        async searchVector() {
          return [];
        },
        async buildIndex() {
          state.buildCount += 1;
        },
        async getActiveSpec() {
          return state.activeSpec;
        },
        async setActiveSpec(spec: PersistedMockStore['activeSpec']) {
          state.activeSpec = spec;
        },
      };
    }),
  };
});

const nodeStorage = {
  existsSync(path: string): boolean {
    return existsSync(path);
  },
  readFileSync(path: string, encoding: BufferEncoding): string {
    return readFileSync(path, encoding);
  },
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[] {
    return readdirSync(path, options);
  },
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({
    db,
    storage: nodeStorage,
  });
  return db;
}

function createRuntimeHarness(
  markdownRoot: string,
  runtimeDir: string,
  db: InstanceType<typeof Database>,
): {
  kb: KbRuntime;
  equip(owner: VectorRetrieval, handle: ConsumerHandle): void;
} {
  let bindingScope = {
    [Symbol.dispose]() {},
  };
  const kb = createTestKbRuntime({
    markdownRoot,
    runtimeDir,
    db,
  });

  return {
    kb,
    equip(owner: VectorRetrieval, handle: ConsumerHandle) {
      bindingScope[Symbol.dispose]();
      bindingScope = {
        [Symbol.dispose]() {},
      };
      const retrieval: BoundVectorRetrieval = {
        read(embedding, topK, scope) {
          return owner.search(embedding, topK, scope);
        },
      };
      kb.vector.bind(
        {
          read: () => retrieval,
          consumer: {
            id: handle.id,
            authority: 'corpus',
            kind: 'apply',
            registrationKind: handle.registrationKind === 'stateless' ? 'expansion' : handle.registrationKind,
            corpusInterest: 'content',
            apply: async () => {},
          },
        },
        bindingScope,
        handle.id,
      );
    },
  };
}

function writeNeedleAddon(runtimeDir: string): string {
  const addonDir = join(runtimeDir, 'installed-addon');
  const addonPath = join(addonDir, 'coral-needle.node');
  mkdirSync(addonDir, { recursive: true });
  writeFileSync(addonPath, 'mock-needle-addon', 'utf-8');
  return addonPath;
}

function writeNote(markdownRoot: string, slug: string, title: string, body: string): void {
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  writeFileSync(
    join(markdownRoot, 'notes', `${slug}.md`),
    `---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-21T00:00:00.000Z
updatedAt: 2026-04-21T00:00:00.000Z
entrySeq: 1
---
# ${title}

${body}
`,
    'utf-8',
  );
}

function writeSource(markdownRoot: string, slug: string, title: string, body: string): void {
  mkdirSync(join(markdownRoot, 'sources'), { recursive: true });
  writeFileSync(
    join(markdownRoot, 'sources', `${slug}.md`),
    `---
title: ${title}
type: article
tags: [retrieval]
importedAt: 2026-04-21T00:00:00.000Z
entrySeq: 1
---
# ${title}

${body}
`,
    'utf-8',
  );
}

function readCursor(
  db: InstanceType<typeof Database>,
  consumerId: string,
): {
  snapshotId: string;
  contentSeq: number;
  metadataSeq: number;
  contentManifestHash: string;
  metadataManifestHash: string;
} {
  const row = db
    .prepare(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    )
    .get(consumerId) as
    | {
        snapshot_id: string | null;
        content_seq: number | null;
        metadata_seq: number | null;
        content_manifest_hash: string | null;
        metadata_manifest_hash: string | null;
      }
    | undefined;

  return {
    snapshotId: row?.snapshot_id ?? '',
    contentSeq: row?.content_seq ?? 0,
    metadataSeq: row?.metadata_seq ?? 0,
    contentManifestHash: row?.content_manifest_hash ?? '',
    metadataManifestHash: row?.metadata_manifest_hash ?? '',
  };
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

afterEach(() => {
  __setNeedleBackendStagingHookForTests(null);
  mockState.openedDbPaths.length = 0;

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createMockEmbeddingService() {
  return {
    name: 'mock-embeddings',
    model: 'mock-small',
    dims: 3,
    normalization: 'l2' as const,
    specId: 'mock-small:3:l2',
    async embedDocuments(texts: string[]) {
      return texts.map((text, index) => Float32Array.from([text.length, index + 1, 1]));
    },
    async embedQuery() {
      return Float32Array.from([1, 0, 0]);
    },
  };
}

describe('needle staging crash replay', () => {
  it('recomputes a full manifest on startup replay after a crash leaves a staged snapshot behind', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'needle-staging-crash-'));
    const markdownRoot = join(rootDir, 'vault');
    const runtimeDir = join(rootDir, 'runtime');
    tempRoots.push(rootDir);

    mkdirSync(markdownRoot, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    const addonPath = writeNeedleAddon(runtimeDir);
    writeNote(markdownRoot, 'coral-alpha', 'Coral Alpha', 'Needle crash replay coverage.');
    writeSource(markdownRoot, 'sqlite-overview', 'SQLite Overview', 'Source text for vector staging.');

    const db = createDb();
    const firstRuntimeHarness = createRuntimeHarness(markdownRoot, runtimeDir, db);
    const firstRuntime = firstRuntimeHarness.kb;
    let secondRuntime: KbRuntime | null = null;
    const firstDriver = new ConsumerDriver({
      db,
      now: () => FIXED_NOW,
      corpusProjectionReader: firstRuntime.corpusProjectionReader,
    });
    const firstNeedleRuntime = createNeedleRuntime(firstRuntime, firstDriver);
    let secondDriver: ConsumerDriver | null = null;
    let secondNeedleRuntime: KbEngineRuntime | null = null;

    try {
      await bindEmbedding(firstRuntime, createMockEmbeddingService());
      await reindex(firstRuntime);
      const publishedSnapshot = firstRuntime.captureCorpusSnapshot();
      const persistedPublication = persistCorpusState(db, publishedSnapshot, {
        now: () => FIXED_NOW,
      });
      const notifyCorpusMutation = createNotifyCorpusMutation(firstDriver);
      const firstBackend = createNeedleBackend(firstNeedleRuntime, { addonPath });
      firstRuntimeHarness.equip(firstBackend, firstDriver.register(firstBackend));

      let crashedStagingDir = '';
      __setNeedleBackendStagingHookForTests(({ stagingDir }) => {
        crashedStagingDir = stagingDir;
        throw new NeedleBackendSimulatedCrashError('crash after staging, before rename');
      });

      await notifyCorpusMutation(persistedPublication);
      await firstDriver.drainAll();

      expect(readCursor(db, NEEDLE_CONSUMER_ID)).toEqual({
        snapshotId: '',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      });
      expect(crashedStagingDir).not.toBe('');
      expect(existsSync(crashedStagingDir)).toBe(true);
      expect(existsSync(join(runtimeDir, 'needle', 'snapshots', publishedSnapshot.snapshotId))).toBe(false);

      const stagedManifest = readJsonFile<{
        snapshot: {
          snapshotId: string;
          contentSeq: number;
          contentManifestHash: string;
        };
        specId: string;
        entryCount: number;
        chunkCount: number;
      }>(join(crashedStagingDir, 'manifest.json'));
      expect(stagedManifest).toMatchObject({
        snapshot: {
          snapshotId: publishedSnapshot.snapshotId,
          contentSeq: publishedSnapshot.contentSeq,
          contentManifestHash: publishedSnapshot.contentManifestHash,
        },
        specId: 'mock-small:3:l2',
        entryCount: 2,
        chunkCount: 2,
      });

      writeFileSync(join(crashedStagingDir, 'poison.txt'), 'stale staging residue', 'utf-8');

      __setNeedleBackendStagingHookForTests(null);
      await closeNeedleBackend(firstNeedleRuntime);
      await firstDriver.shutdown();

      const secondRuntimeHarness = createRuntimeHarness(markdownRoot, runtimeDir, db);
      secondRuntime = secondRuntimeHarness.kb;
      await bindEmbedding(secondRuntime, createMockEmbeddingService());
      secondDriver = new ConsumerDriver({
        db,
        now: () => FIXED_NOW,
        corpusProjectionReader: secondRuntime.corpusProjectionReader,
      });
      secondNeedleRuntime = createNeedleRuntime(secondRuntime, secondDriver);
      const secondBackend = createNeedleBackend(secondNeedleRuntime, { addonPath });
      secondRuntimeHarness.equip(secondBackend, secondDriver.register(secondBackend));

      secondDriver.notifyCorpus(readCorpusState(db));
      await secondDriver.drainAll();

      expect(readCursor(db, NEEDLE_CONSUMER_ID)).toEqual({
        snapshotId: publishedSnapshot.snapshotId,
        contentSeq: publishedSnapshot.contentSeq,
        metadataSeq: publishedSnapshot.metadataSeq,
        contentManifestHash: publishedSnapshot.contentManifestHash,
        metadataManifestHash: publishedSnapshot.metadataManifestHash,
      });

      const finalSnapshotDir = join(runtimeDir, 'needle', 'snapshots', publishedSnapshot.snapshotId);
      const finalManifest = readJsonFile<typeof stagedManifest>(join(finalSnapshotDir, 'manifest.json'));
      const finalStore = readJsonFile<PersistedMockStore>(join(finalSnapshotDir, 'store.db'));
      const stagingDbPath = join(runtimeDir, 'needle-staging', publishedSnapshot.snapshotId, 'store.db');

      expect(finalManifest).toEqual(stagedManifest);
      expect(finalStore.activeSpec?.specId).toBe('mock-small:3:l2');
      expect(finalStore.buildCount).toBe(1);
      expect(finalStore.chunks.map((chunk) => chunk.entryId)).toEqual(['note:coral-alpha', 'source:sqlite-overview']);
      expect(finalStore.chunks.map((chunk) => chunk.text)).toEqual([
        '# Coral Alpha\n\nNeedle crash replay coverage.',
        '# SQLite Overview\n\nSource text for vector staging.',
      ]);
      expect(mockState.openedDbPaths.filter((dbPath) => dbPath === stagingDbPath)).toHaveLength(2);
      expect(existsSync(join(crashedStagingDir, 'poison.txt'))).toBe(false);
      expect(existsSync(crashedStagingDir)).toBe(false);
    } finally {
      await secondDriver?.shutdown();
      if (secondRuntime !== null && secondNeedleRuntime !== null) {
        await closeNeedleBackend(secondNeedleRuntime);
      }
      await closeNeedleBackend(firstNeedleRuntime);
      db.close();
    }
  });
});
