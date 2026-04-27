import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { createKbRuntime } from '#src/kb/runtime.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { update } from '#src/kb/ops/update.js';
import { NEEDLE_CONSUMER_ID } from '#src/kb/search/needle/contract.js';
import { backendLog } from '#src/infra/backend-log.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { persistCorpusState, readCorpusState, type CorpusStateSnapshot } from '#src/kb/state/corpus-state.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import type { CorpusConsumerRegistration } from '#src/store/consumer-contract.js';

function createNotifyCorpusMutation(driver: ConsumerDriver) {
  return async (publication: { snapshot: CorpusStateSnapshot; changedLanes: readonly ('content' | 'metadata')[] }) => {
    if (publication.changedLanes.length === 1) {
      driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
      return;
    }
    driver.notifyCorpus(publication.snapshot);
  };
}
import { createDeferred } from '#tools/testing/deferred.js';

const BASE_CREATED_AT = '2026-04-19T00:00:00.000Z';
const BASE_UPDATED_AT = '2026-04-19T00:00:00.000Z';

const nodeStorage = {
  readFileSync(path: string, encoding: BufferEncoding): string {
    return readFileSync(path, encoding);
  },
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[] {
    return readdirSync(path, options);
  },
};

type ProjectionRow = {
  snapshot_id: string;
  content_seq: number;
  metadata_seq: number;
  content_manifest_hash: string;
  metadata_manifest_hash: string;
  applied_by: string;
};

function renderNote({
  title = 'Alpha',
  updatedAt = BASE_UPDATED_AT,
  body = 'Body.',
}: {
  title?: string;
  updatedAt?: string;
  body?: string;
} = {}): string {
  return [
    '---',
    'tags: [coral]',
    'principles: []',
    'source:',
    '  - kangig94/coral',
    `createdAt: ${BASE_CREATED_AT}`,
    `updatedAt: ${updatedAt}`,
    'entrySeq: 1',
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function notePath(vaultDir: string): string {
  return join(vaultDir, 'notes', 'coral-alpha.md');
}

async function seedIndexedNote(kb: ReturnType<typeof createKbRuntime>, vaultDir: string): Promise<void> {
  mkdirSync(join(vaultDir, 'notes'), { recursive: true });
  writeFileSync(notePath(vaultDir), renderNote(), 'utf-8');
  await reindex(kb);
}

function readCursor(db: InstanceType<typeof Database>, consumerId: string): CorpusStateSnapshot {
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

function createProjectionTable(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_needle_projection (
      snapshot_id TEXT PRIMARY KEY,
      content_seq INTEGER NOT NULL,
      metadata_seq INTEGER NOT NULL,
      content_manifest_hash TEXT NOT NULL,
      metadata_manifest_hash TEXT NOT NULL,
      applied_by TEXT NOT NULL
    )
  `);
}

function listProjectionRows(db: InstanceType<typeof Database>): ProjectionRow[] {
  return db
    .prepare(
      `
        SELECT
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          applied_by
          FROM test_needle_projection
         ORDER BY snapshot_id
      `,
    )
    .all() as ProjectionRow[];
}

function createNeedleConsumer(options: {
  appliedBy: string;
  applyCalls: Array<{ appliedBy: string; snapshotId: string }>;
  started?: Deferred<void>;
  gate?: Deferred<void>;
}): CorpusConsumerRegistration {
  return {
    id: NEEDLE_CONSUMER_ID,
    authority: 'corpus',
    corpusInterest: 'content',
    async apply({ snapshot, db }) {
      db.prepare(
        `
          INSERT INTO test_needle_projection (
            snapshot_id,
            content_seq,
            metadata_seq,
            content_manifest_hash,
            metadata_manifest_hash,
            applied_by
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(snapshot_id) DO UPDATE SET
            content_seq = excluded.content_seq,
            metadata_seq = excluded.metadata_seq,
            content_manifest_hash = excluded.content_manifest_hash,
            metadata_manifest_hash = excluded.metadata_manifest_hash,
            applied_by = excluded.applied_by
        `,
      ).run(
        snapshot.snapshotId,
        snapshot.contentSeq,
        snapshot.metadataSeq,
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
        options.appliedBy,
      );

      options.applyCalls.push({
        appliedBy: options.appliedBy,
        snapshotId: snapshot.snapshotId,
      });
      options.started?.resolve();

      if (options.gate !== undefined) {
        await options.gate.promise;
      }
    },
  };
}

describe('Corpus notify crash replay', () => {
  it('replays the persisted corpus snapshot after a notify/apply crash window', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'corpus-notify-crash-'));
    const vaultDir = join(rootDir, 'vault');
    const runtimeDir = join(rootDir, 'runtime');
    const dbPath = join(rootDir, 'store.sqlite');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });

    const primaryDb = new Database(dbPath);
    createProjectionTable(primaryDb);
    applyStoreSchemas({
      db: primaryDb,
      storage: nodeStorage,
    });

    const primaryDriver = new ConsumerDriver({
      db: primaryDb,
      now: () => new Date(BASE_UPDATED_AT),
    });
    const applyCalls: Array<{ appliedBy: string; snapshotId: string }> = [];
    const firstApplyStarted = createDeferred<void>();
    const firstApplyGate = createDeferred<void>();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    let replayDb: InstanceType<typeof Database> | null = null;
    let replayDriver: ConsumerDriver | null = null;

    try {
      primaryDriver.register(
        createNeedleConsumer({
          appliedBy: 'pre-crash',
          applyCalls,
          started: firstApplyStarted,
          gate: firstApplyGate,
        }),
      );

      const kb = createTestKbRuntime({
        markdownRoot: vaultDir,
        runtimeDir,
        db: primaryDb,
        corpusPublishCallbacks: {
          async persistCorpusState(snapshot) {
            return persistCorpusState(primaryDb, snapshot, {
              now: () => new Date(BASE_UPDATED_AT),
            });
          },
          notifyCorpusMutation: createNotifyCorpusMutation(primaryDriver),
        },
      });

      await kb.retryPendingCorpusPublication();
      await kb.withMutationLock(() => {
      });
      await seedIndexedNote(kb, vaultDir);

      await update(kb, {
        note: 'coral-alpha',
        content: 'Crash replay content.',
      });
      await firstApplyStarted.promise;

      const latest = readCorpusState(primaryDb);
      expect(latest.snapshotId).not.toBe('');
      expect(latest.contentSeq).toBe(1);

      expect(readCursor(primaryDb, NEEDLE_CONSUMER_ID)).toEqual({
        snapshotId: '',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      });
      expect(listProjectionRows(primaryDb)).toEqual([
        {
          snapshot_id: latest.snapshotId,
          content_seq: latest.contentSeq,
          metadata_seq: latest.metadataSeq,
          content_manifest_hash: latest.contentManifestHash,
          metadata_manifest_hash: latest.metadataManifestHash,
          applied_by: 'pre-crash',
        },
      ]);

      replayDb = new Database(dbPath);
      replayDriver = new ConsumerDriver({
        db: replayDb,
        now: () => new Date(BASE_UPDATED_AT),
      });
      replayDriver.register(
        createNeedleConsumer({
          appliedBy: 'startup-replay',
          applyCalls,
        }),
      );

      expect(readCursor(replayDb, NEEDLE_CONSUMER_ID)).toEqual({
        snapshotId: '',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      });
      expect(readCursor(replayDb, NEEDLE_CONSUMER_ID).snapshotId).not.toBe(latest.snapshotId);

      firstApplyGate.reject(new Error('simulated coordinator kill before apply completion'));
      await primaryDriver.drainAll();

      replayDriver.notifyCorpus(readCorpusState(replayDb));
      await replayDriver.drainAll();

      expect(readCursor(replayDb, NEEDLE_CONSUMER_ID)).toEqual(latest);
      expect(listProjectionRows(replayDb)).toEqual([
        {
          snapshot_id: latest.snapshotId,
          content_seq: latest.contentSeq,
          metadata_seq: latest.metadataSeq,
          content_manifest_hash: latest.contentManifestHash,
          metadata_manifest_hash: latest.metadataManifestHash,
          applied_by: 'startup-replay',
        },
      ]);
      expect(applyCalls).toEqual([
        { appliedBy: 'pre-crash', snapshotId: latest.snapshotId },
        { appliedBy: 'startup-replay', snapshotId: latest.snapshotId },
      ]);

      replayDriver.notifyCorpus(readCorpusState(replayDb));
      await replayDriver.drainAll();
      expect(applyCalls).toEqual([
        { appliedBy: 'pre-crash', snapshotId: latest.snapshotId },
        { appliedBy: 'startup-replay', snapshotId: latest.snapshotId },
      ]);

      expect(errorSpy).toHaveBeenCalledWith(
        `ConsumerDriver apply failed (${NEEDLE_CONSUMER_ID})`,
        expect.any(Error),
      );
    } finally {
      firstApplyGate.reject(new Error('test cleanup'));
      await replayDriver?.shutdown();
      await primaryDriver.shutdown();
      replayDb?.close();
      primaryDb.close();
      errorSpy.mockRestore();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
