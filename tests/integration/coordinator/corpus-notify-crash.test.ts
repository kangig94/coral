import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import { type createKbRuntime } from '#src/kb/runtime.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { update } from '#src/kb/ops/update.js';
import { backendLog } from '#src/infra/backend-log.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { persistCorpusState, readCorpusState } from '#src/kb/state/corpus-state.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS } from '#tests/helpers/consumer-driver-defaults.js';
import type { CorpusConsumerRegistration } from '#src/store/consumer-contract.js';

const VECTOR_FIXTURE_CONSUMER_ID = 'vector-fixture';

function createNotifyCorpusMutation(driver: ConsumerDriver) {
  return async (publication: { snapshot: KbCorpusSnapshot; changedLanes: readonly ('content' | 'metadata')[] }) => {
    if (publication.changedLanes.length === 1) {
      driver.notifyCorpus(publication.snapshot, publication.changedLanes[0]);
      return;
    }
    driver.notifyCorpus(publication.snapshot);
  };
}
import { createDeferred, type Deferred } from '#tools/testing/deferred.js';

const BASE_CREATED_AT = '2026-04-19T00:00:00.000Z';
const BASE_UPDATED_AT = '2026-04-19T00:00:00.000Z';
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

function readCursor(db: Database, consumerId: string): KbCorpusSnapshot {
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

function createProjectionTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_vector_fixture_projection (
      snapshot_id TEXT PRIMARY KEY,
      content_seq INTEGER NOT NULL,
      metadata_seq INTEGER NOT NULL,
      content_manifest_hash TEXT NOT NULL,
      metadata_manifest_hash TEXT NOT NULL,
      applied_by TEXT NOT NULL
    )
  `);
}

function listProjectionRows(db: Database): ProjectionRow[] {
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
          FROM test_vector_fixture_projection
         ORDER BY snapshot_id
      `,
    )
    .all() as ProjectionRow[];
}

function createVectorFixtureConsumer(options: {
  db: Database;
  appliedBy: string;
  applyCalls: Array<{ appliedBy: string; snapshotId: string }>;
  started?: Deferred<void>;
  gate?: Deferred<void>;
}): CorpusConsumerRegistration {
  return {
    id: VECTOR_FIXTURE_CONSUMER_ID,
    authority: 'corpus',
    kind: 'apply',
    registrationKind: 'expansion',
    corpusInterest: 'content',
    projectionIdentityHash: () => 'vector-fixture-v1',
    readAuthoritativeFreshness: async () => ({ kind: 'stale', reason: 'artifact-missing' }),
    async apply({ snapshot }) {
      options.db
        .prepare(
          `
          INSERT INTO test_vector_fixture_projection (
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
        )
        .run(
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

    const primaryDb = newRawDatabase(dbPath);
    createProjectionTable(primaryDb);
    applyBundledStoreSchema(primaryDb, currentCoralStoreFormat());

    const primaryDriver = new ConsumerDriver({
      db: primaryDb,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: () => new Date(BASE_UPDATED_AT),
    });
    const applyCalls: Array<{ appliedBy: string; snapshotId: string }> = [];
    const firstApplyStarted = createDeferred<void>();
    const firstApplyGate = createDeferred<void>();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    let replayDb: Database | null = null;
    let replayDriver: ConsumerDriver | null = null;

    try {
      primaryDriver.register(
        createVectorFixtureConsumer({
          db: primaryDb,
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
      await kb.withMutationLock(() => {});
      await seedIndexedNote(kb, vaultDir);

      await update(kb, {
        note: 'coral-alpha',
        content: 'Crash replay content.',
      });
      await firstApplyStarted.promise;

      const latest = readCorpusState(primaryDb);
      expect(latest.snapshotId).not.toBe('');
      expect(latest.contentSeq).toBe(1);

      expect(readCursor(primaryDb, VECTOR_FIXTURE_CONSUMER_ID)).toEqual({
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

      replayDb = newRawDatabase(dbPath);
      replayDriver = new ConsumerDriver({
        db: replayDb,
        time: REAL_CONSUMER_DRIVER_TIMERS,
        now: () => new Date(BASE_UPDATED_AT),
      });
      replayDriver.register(
        createVectorFixtureConsumer({
          db: replayDb,
          appliedBy: 'startup-replay',
          applyCalls,
        }),
      );

      expect(readCursor(replayDb, VECTOR_FIXTURE_CONSUMER_ID)).toEqual({
        snapshotId: '',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      });
      expect(readCursor(replayDb, VECTOR_FIXTURE_CONSUMER_ID).snapshotId).not.toBe(latest.snapshotId);

      firstApplyGate.reject(new Error('simulated coordinator kill before apply completion'));
      await primaryDriver.drainAll();

      replayDriver.notifyCorpus(readCorpusState(replayDb));
      await replayDriver.drainAll();

      expect(readCursor(replayDb, VECTOR_FIXTURE_CONSUMER_ID)).toEqual(latest);
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
        `ConsumerDriver apply failed (${VECTOR_FIXTURE_CONSUMER_ID})`,
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
