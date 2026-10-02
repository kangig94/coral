import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import type { KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import { EMPTY_GENERATED_COMMUNITY_FRESHNESS } from '#src/kb/curate/community/generated-projection-store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type {
  CorpusAuthoritativeFreshness,
  CorpusAuthoritativeFreshnessTarget,
  CorpusConsumerRegistration,
} from '#src/store/consumer-contract.js';
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
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

const TEST_PROJECTION_IDENTITY_HASH = 'test-corpus-projection-v1';

function staleFreshnessCapability(): Pick<
  CorpusConsumerRegistration,
  'projectionIdentityHash' | 'readAuthoritativeFreshness'
> {
  return {
    projectionIdentityHash: () => TEST_PROJECTION_IDENTITY_HASH,
    readAuthoritativeFreshness: async () => ({ kind: 'stale', reason: 'artifact-missing' }),
  };
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
        ...staleFreshnessCapability(),
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
        ...staleFreshnessCapability(),
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

  it('repairs a reset cursor from an installed consumer current proof without invoking apply again', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const snapshot = buildSnapshot({
      snapshotId: 'installed-current',
      contentSeq: 8,
      metadataSeq: 13,
      contentManifestHash: 'content-hash-8',
      metadataManifestHash: 'metadata-hash-13',
    });
    let storedFreshness: CorpusAuthoritativeFreshness = { kind: 'stale', reason: 'artifact-missing' };
    const freshnessTargets: CorpusAuthoritativeFreshnessTarget[] = [];
    const apply = vi.fn(async ({ snapshot: appliedSnapshot, projectionInput }) => {
      storedFreshness = {
        kind: 'current',
        appliedSnapshot,
        generatedCommunityGeneration: projectionInput.generatedCommunityGeneration,
        generatedCommunityDocsHash: projectionInput.generatedCommunityDocsHash,
        projectionIdentityHash: TEST_PROJECTION_IDENTITY_HASH,
      };
    });

    try {
      const handle = driver.register({
        id: 'installed-fixture',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'both',
        projectionIdentityHash: () => TEST_PROJECTION_IDENTITY_HASH,
        readAuthoritativeFreshness: async (target) => {
          freshnessTargets.push(target);
          return storedFreshness;
        },
        apply,
      });

      driver.notify('corpus', snapshot);
      await driver.drainAll();
      expect(apply).toHaveBeenCalledTimes(1);

      db.prepare(
        `
          UPDATE consumer_cursors
             SET snapshot_id = '',
                 content_seq = 0,
                 metadata_seq = 0,
                 content_manifest_hash = '',
                 metadata_manifest_hash = ''
           WHERE consumer_id = ?
        `,
      ).run('installed-fixture');

      const waits = [driver.waitFreshUntil('corpus', snapshot, 'installed-fixture', 5000)];
      driver.notify('corpus', snapshot);
      await Promise.all(waits);
      await driver.drainAll();

      expect(apply).toHaveBeenCalledTimes(1);
      expect(freshnessTargets.at(-1)).toEqual({
        snapshot,
        corpusInterest: 'both',
        ...EMPTY_GENERATED_COMMUNITY_FRESHNESS,
        projectionIdentityHash: TEST_PROJECTION_IDENTITY_HASH,
      });
      expect(readCursorRow(db, 'installed-fixture')).toMatchObject({
        snapshot_id: snapshot.snapshotId,
        content_seq: 8,
        metadata_seq: 13,
      });
      expect(handle.status()).toMatchObject({
        authority: 'corpus',
        snapshotId: snapshot.snapshotId,
        contentSeq: snapshot.contentSeq,
        metadataSeq: snapshot.metadataSeq,
        pending: false,
        lastApplyError: null,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
