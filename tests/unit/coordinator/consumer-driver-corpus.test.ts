import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import type { KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { CorpusConsumerRegistration, JournalConsumerRegistration } from '#src/store/consumer-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';
interface CursorRow {
  consumer_id: string;
  authority: string;
  lane: string | null;
  corpus_interest: string | null;
  cursor: number | null;
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
  registered_at: string;
}

function buildSnapshot(overrides: Partial<CorpusSnapshot> = {}): CorpusSnapshot {
  return {
    snapshotId: overrides.snapshotId ?? 'snapshot-1',
    contentSeq: overrides.contentSeq ?? 0,
    metadataSeq: overrides.metadataSeq ?? 0,
    contentManifestHash: overrides.contentManifestHash ?? 'content-hash-0',
    metadataManifestHash: overrides.metadataManifestHash ?? 'metadata-hash-0',
  };
}

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function readCursorRow(db: Database, consumerId: string): CursorRow {
  return db
    .prepare(
      `
        SELECT
          consumer_id,
          authority,
          lane,
          corpus_interest,
          cursor,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          registered_at
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    )
    .get(consumerId) as CursorRow;
}

describe('ConsumerDriver corpus registrations', () => {
  it('rejects missing corpusInterest on corpus consumers', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const reg = {
      id: 'corpus-missing-interest',
      authority: 'corpus',
      async apply() {},
    } as unknown as CorpusConsumerRegistration;

    try {
      expect(() => driver.register(reg)).toThrow(CoralSetupError);
      expect(() => driver.register(reg)).toThrow(/interest is invalid/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('stores the declared corpus interest and advances only the matching consumer cursor fields', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({
      db,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: () => new Date('2026-04-19T01:02:03.000Z'),
    });
    const calls: Array<{ id: string; snapshot: CorpusSnapshot }> = [];
    const contentConsumer: CorpusConsumerRegistration = {
      id: 'corpus-content',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'expansion',
      corpusInterest: 'content',
      async apply({ snapshot }) {
        calls.push({ id: 'content', snapshot });
      },
    };
    const metadataConsumer: CorpusConsumerRegistration = {
      id: 'corpus-metadata',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'expansion',
      corpusInterest: 'metadata',
      async apply({ snapshot }) {
        calls.push({ id: 'metadata', snapshot });
      },
    };
    const contentSnapshot = buildSnapshot({
      snapshotId: 'content-snapshot',
      contentSeq: 4,
      metadataSeq: 0,
      contentManifestHash: 'content-hash-4',
      metadataManifestHash: 'metadata-hash-0',
    });
    const metadataSnapshot = buildSnapshot({
      snapshotId: 'metadata-snapshot',
      contentSeq: 4,
      metadataSeq: 7,
      contentManifestHash: 'content-hash-4',
      metadataManifestHash: 'metadata-hash-7',
    });

    try {
      driver.register(contentConsumer);
      driver.register(metadataConsumer);

      expect(readCursorRow(db, contentConsumer.id)).toMatchObject({
        consumer_id: contentConsumer.id,
        authority: 'corpus',
        lane: 'content',
        corpus_interest: 'content',
        cursor: null,
        snapshot_id: '',
        content_seq: 0,
        metadata_seq: 0,
        content_manifest_hash: '',
        metadata_manifest_hash: '',
      });
      expect(readCursorRow(db, metadataConsumer.id)).toMatchObject({
        consumer_id: metadataConsumer.id,
        authority: 'corpus',
        lane: 'metadata',
        corpus_interest: 'metadata',
        cursor: null,
      });

      driver.notify('corpus', contentSnapshot, 'content');
      await driver.drainAll();

      expect(calls).toEqual([{ id: 'content', snapshot: contentSnapshot }]);
      expect(readCursorRow(db, contentConsumer.id)).toMatchObject({
        snapshot_id: 'content-snapshot',
        content_seq: 4,
        metadata_seq: 0,
        content_manifest_hash: 'content-hash-4',
        metadata_manifest_hash: 'metadata-hash-0',
      });
      expect(readCursorRow(db, metadataConsumer.id)).toMatchObject({
        snapshot_id: '',
        content_seq: 0,
        metadata_seq: 0,
        content_manifest_hash: '',
        metadata_manifest_hash: '',
      });

      driver.notify('corpus', metadataSnapshot, 'metadata');
      await driver.drainAll();

      expect(calls).toEqual([
        { id: 'content', snapshot: contentSnapshot },
        { id: 'metadata', snapshot: metadataSnapshot },
      ]);
      expect(readCursorRow(db, contentConsumer.id)).toMatchObject({
        snapshot_id: 'content-snapshot',
        content_seq: 4,
        metadata_seq: 0,
      });
      expect(readCursorRow(db, metadataConsumer.id)).toMatchObject({
        snapshot_id: 'metadata-snapshot',
        content_seq: 4,
        metadata_seq: 7,
        content_manifest_hash: 'content-hash-4',
        metadata_manifest_hash: 'metadata-hash-7',
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('rejects lane on journal consumers', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const reg = {
      id: 'journal-with-lane',
      authority: 'journal',
      lane: 'content',
      async apply() {},
    } as unknown as JournalConsumerRegistration;

    try {
      expect(() => driver.register(reg)).toThrow(CoralSetupError);
      expect(() => driver.register(reg)).toThrow(/lane is invalid/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('auto-updates stored corpus interest on fresh registration when a previous version persisted a different value', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    db.prepare(
      `
        INSERT INTO consumer_cursors (
          consumer_id,
          authority,
          lane,
          corpus_interest,
          cursor,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          registered_at
        ) VALUES (?, ?, ?, ?, NULL, '', 0, 0, '', '', ?)
      `,
    ).run('corpus-proj', 'corpus', 'content', 'content', '2026-04-19T00:00:00.000Z');

    try {
      expect(() =>
        driver.register({
          id: 'corpus-proj',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'both',
          async apply() {},
        }),
      ).not.toThrow();

      const row = db
        .prepare<
          [string],
          { corpus_interest: string; lane: string | null }
        >('SELECT corpus_interest, lane FROM consumer_cursors WHERE consumer_id = ?')
        .get('corpus-proj');
      // `lane` for 'both' interest is null (laneHintFromInterest returns null
      // when no single lane uniquely fits).
      expect(row).toEqual({ corpus_interest: 'both', lane: null });
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('rejects mid-process re-registration with mismatched corpus interest', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });

    try {
      driver.register({
        id: 'corpus-proj',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        async apply() {},
      });
      expect(() =>
        driver.register({
          id: 'corpus-proj',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'metadata',
          async apply() {},
        }),
      ).toThrow(/interest mismatch/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('preserves a later content snapshot after an interleaved metadata-only apply on a both-interest consumer', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const firstApplyStarted = createDeferred<void>();
    const releaseFirstApply = createDeferred<void>();
    const calls: CorpusSnapshot[] = [];
    const metadataSnapshot = buildSnapshot({
      snapshotId: 'snapshot-meta',
      contentSeq: 0,
      metadataSeq: 1,
      contentManifestHash: 'content-hash-0',
      metadataManifestHash: 'metadata-hash-1',
    });
    const contentSnapshot = buildSnapshot({
      snapshotId: 'snapshot-content',
      contentSeq: 2,
      metadataSeq: 1,
      contentManifestHash: 'content-hash-2',
      metadataManifestHash: 'metadata-hash-1',
    });

    try {
      driver.register({
        id: 'corpus-both',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'both',
        async apply({ snapshot }) {
          calls.push(snapshot);
          if (calls.length === 1) {
            firstApplyStarted.resolve();
            await releaseFirstApply.promise;
          }
        },
      });

      driver.notify('corpus', metadataSnapshot, 'metadata');
      await firstApplyStarted.promise;

      driver.notify('corpus', contentSnapshot, 'content');
      releaseFirstApply.resolve();
      await driver.drainAll();

      expect(calls).toEqual([metadataSnapshot, contentSnapshot]);
      expect(readCursorRow(db, 'corpus-both')).toMatchObject({
        lane: null,
        corpus_interest: 'both',
        snapshot_id: 'snapshot-content',
        content_seq: 2,
        metadata_seq: 1,
        content_manifest_hash: 'content-hash-2',
        metadata_manifest_hash: 'metadata-hash-1',
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('retries against a snapshot parked during a failed apply rather than discarding it', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const firstApplyStarted = createDeferred<void>();
    const releaseFirstApply = createDeferred<void>();
    const calls: Array<{ snapshot: CorpusSnapshot; outcome: 'fail' | 'ok' }> = [];
    const failingSnapshot = buildSnapshot({
      snapshotId: 'snapshot-fail',
      contentSeq: 1,
      metadataSeq: 1,
      contentManifestHash: 'content-hash-1',
      metadataManifestHash: 'metadata-hash-1',
    });
    const newerSnapshot = buildSnapshot({
      snapshotId: 'snapshot-newer',
      contentSeq: 2,
      metadataSeq: 2,
      contentManifestHash: 'content-hash-2',
      metadataManifestHash: 'metadata-hash-2',
    });

    try {
      driver.register({
        id: 'corpus-retry',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'both',
        async apply({ snapshot }) {
          if (snapshot.snapshotId === 'snapshot-fail') {
            calls.push({ snapshot, outcome: 'fail' });
            firstApplyStarted.resolve();
            await releaseFirstApply.promise;
            throw new Error('apply failed for snapshot-fail');
          }
          calls.push({ snapshot, outcome: 'ok' });
        },
      });

      // First apply is in-flight; while it is still running, a newer notify
      // arrives and parks into pendingCorpusSnapshot.
      driver.notify('corpus', failingSnapshot);
      await firstApplyStarted.promise;
      driver.notify('corpus', newerSnapshot);

      // Release the failing apply. The driver must retry against the parked
      // newer snapshot rather than discarding it.
      releaseFirstApply.resolve();
      await driver.drainAll();

      expect(calls.map((entry) => entry.snapshot.snapshotId)).toEqual(['snapshot-fail', 'snapshot-newer']);
      expect(readCursorRow(db, 'corpus-retry')).toMatchObject({
        snapshot_id: 'snapshot-newer',
        content_seq: 2,
        metadata_seq: 2,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('treats a replayed older snapshot as a no-op for both-interest consumers', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const calls: CorpusSnapshot[] = [];
    const olderSnapshot = buildSnapshot({
      snapshotId: 'snapshot-older',
      contentSeq: 1,
      metadataSeq: 0,
      contentManifestHash: 'content-hash-1',
      metadataManifestHash: 'metadata-hash-0',
    });
    const newerSnapshot = buildSnapshot({
      snapshotId: 'snapshot-newer',
      contentSeq: 1,
      metadataSeq: 2,
      contentManifestHash: 'content-hash-1',
      metadataManifestHash: 'metadata-hash-2',
    });

    try {
      driver.register({
        id: 'corpus-both',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'both',
        async apply({ snapshot }) {
          calls.push(snapshot);
        },
      });

      driver.notify('corpus', newerSnapshot, 'metadata');
      await driver.drainAll();

      driver.notify('corpus', olderSnapshot, 'content');
      await driver.drainAll();

      expect(calls).toEqual([newerSnapshot]);
      expect(readCursorRow(db, 'corpus-both')).toMatchObject({
        snapshot_id: 'snapshot-newer',
        content_seq: 1,
        metadata_seq: 2,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
