
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoralSetupError } from '#src/runtime/errors.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type {
  ConsumerApplyError,
  CorpusConsumerRegistration,
  JournalConsumerRegistration,
} from '#src/store/consumer-contract.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function readJournalCursor(db: Database, consumerId: string): number {
  const row = db.prepare('SELECT cursor FROM consumer_cursors WHERE consumer_id = ?').get(consumerId) as
    | { cursor: number }
    | undefined;

  return row?.cursor ?? 0;
}

function readCursorCount(db: Database, consumerId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM consumer_cursors WHERE consumer_id = ?').get(consumerId) as {
      count: number;
    }
  ).count;
}

describe('ConsumerDriver handle lifecycle + fault isolation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs apply failures, invokes onApplyFailure, and isolates healthy consumers on the same journal notify', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const healthyCalls: Array<{ fromSeq: number; upToSeq: number }> = [];
    const onApplyFailure = vi.fn((_err: ConsumerApplyError) => {
      throw new Error('callback exploded');
    });

    const failing: JournalConsumerRegistration = {
      id: 'failing-consumer',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      onApplyFailure,
      async apply() {
        throw new Error('boom');
      },
    };
    const healthy: JournalConsumerRegistration = {
      id: 'healthy-consumer',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      async apply({ fromSeq, upToSeq }) {
        healthyCalls.push({ fromSeq, upToSeq });
      },
    };

    try {
      const failingHandle = driver.register(failing);
      driver.register(healthy);

      driver.notify('journal', 7);
      await driver.drainAll();

      expect(onApplyFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'boom',
          at: expect.any(String),
          cause: expect.any(Error),
        }),
      );
      expect(failingHandle.status()).toMatchObject({
        authority: 'journal',
        cursor: 0,
        pending: false,
        lastApplyError: {
          message: 'boom',
          at: expect.any(String),
          cause: expect.any(Error),
        },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        'ConsumerDriver onApplyFailure failed (failing-consumer)',
        expect.any(Error),
      );
      expect(errorSpy).toHaveBeenCalledWith('ConsumerDriver apply failed (failing-consumer)', expect.any(Error));
      expect(healthyCalls).toEqual([{ fromSeq: 0, upToSeq: 7 }]);
      expect(readJournalCursor(db, failing.id)).toBe(0);
      expect(readJournalCursor(db, healthy.id)).toBe(7);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('skips duplicate in-flight journal targets once the consumer is already caught up', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    let startApply!: () => void;
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      startApply = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const apply = vi.fn(async () => {
      startApply();
      await applyReleased;
    });

    try {
      driver.register({
        id: 'coalesced-consumer',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        apply,
      });

      driver.notify('journal', 7);
      await applyStarted;
      driver.notify('journal', 7);
      driver.notify('journal', 7);
      releaseApply();
      await driver.drainAll();

      expect(apply).toHaveBeenCalledTimes(1);
      expect(readJournalCursor(db, 'coalesced-consumer')).toBe(7);
    } finally {
      releaseApply?.();
      await driver.shutdown();
      db.close();
    }
  });

  it('supports register -> stop -> unregister for expansion consumers and drops future notifications after stop', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const applyCalls: Array<{ fromSeq: number; upToSeq: number }> = [];
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    let releaseGate!: () => void;
    const applyReleased = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    try {
      const handle = driver.register({
        id: 'expansion-consumer',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply({ fromSeq, upToSeq }) {
          applyCalls.push({ fromSeq, upToSeq });
          releaseApply();
          await applyReleased;
        },
      });

      driver.notify('journal', 5);
      await applyStarted;
      const stopPromise = handle.stop();
      driver.notify('journal', 9);
      releaseGate();
      await stopPromise;
      await driver.drainAll();

      expect(handle.status()).toEqual({
        authority: 'journal',
        cursor: 5,
        pending: false,
        lastApplyError: null,
      });
      expect(applyCalls).toEqual([{ fromSeq: 0, upToSeq: 5 }]);
      expect(readCursorCount(db, 'expansion-consumer')).toBe(1);

      await handle.unregister();

      expect(readCursorCount(db, 'expansion-consumer')).toBe(0);
    } finally {
      releaseGate?.();
      await driver.shutdown();
      db.close();
    }
  });

  it('makes stop() idempotent', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const apply = vi.fn(async () => {});

    try {
      const handle = driver.register({
        id: 'stoppable-consumer',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        apply,
      });

      await handle.stop();
      await handle.stop();
      driver.notify('journal', 3);
      await driver.drainAll();

      expect(apply).not.toHaveBeenCalled();
      expect(handle.status()).toEqual({
        authority: 'journal',
        cursor: 0,
        pending: false,
        lastApplyError: null,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('throws CoralSetupError when unregister() is called before stop()', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });

    try {
      const handle = driver.register({
        id: 'base-consumer',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        apply: async () => {},
      });

      await expect(handle.unregister()).rejects.toBeInstanceOf(CoralSetupError);
      await expect(handle.unregister()).rejects.toMatchObject({
        code: 'consumer_unregister_requires_stop',
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('status() reports journal and corpus authority shapes with direct lastApplyError access', async () => {
    const db = createDb();
    const failureAt = new Date('2026-04-22T01:02:03.000Z');
    const successAt = new Date('2026-04-22T01:02:04.000Z');
    let now = failureAt;
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: () => now });
    let journalShouldFail = true;
    let corpusShouldFail = true;

    try {
      const journalHandle = driver.register({
        id: 'journal-status',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply() {
          if (journalShouldFail) {
            throw new Error('journal boom');
          }
        },
      });
      const contentHandle = driver.register({
        id: 'corpus-status-content',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        async apply() {
          if (corpusShouldFail) {
            throw new Error('corpus boom');
          }
        },
      } satisfies CorpusConsumerRegistration);
      const metadataHandle = driver.register({
        id: 'corpus-status-metadata',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'metadata',
        async apply() {
          if (corpusShouldFail) {
            throw new Error('corpus boom');
          }
        },
      } satisfies CorpusConsumerRegistration);
      const bothHandle = driver.register({
        id: 'corpus-status-both',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'both',
        async apply() {
          if (corpusShouldFail) {
            throw new Error('corpus boom');
          }
        },
      } satisfies CorpusConsumerRegistration);

      driver.notify('journal', 4);
      driver.notify('corpus', {
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        metadataSeq: 2,
        contentManifestHash: 'content-hash-4',
        metadataManifestHash: 'metadata-hash-2',
      });
      await driver.drainAll();

      expect(journalHandle.status()).toMatchObject({
        authority: 'journal',
        cursor: 0,
        pending: false,
        lastApplyError: {
          message: 'journal boom',
          at: failureAt.toISOString(),
          cause: expect.any(Error),
        },
      });
      expect(journalHandle.lastApplyError).toMatchObject({
        message: 'journal boom',
        at: failureAt.toISOString(),
        cause: expect.any(Error),
      });
      expect(contentHandle.status()).toMatchObject({
        authority: 'corpus',
        corpusInterest: 'content',
        snapshotId: null,
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: null,
        metadataManifestHash: null,
        pending: false,
        lastApplyError: {
          message: 'corpus boom',
          at: failureAt.toISOString(),
          cause: expect.any(Error),
        },
      });
      expect(metadataHandle.status()).toMatchObject({
        authority: 'corpus',
        corpusInterest: 'metadata',
        snapshotId: null,
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: null,
        metadataManifestHash: null,
        pending: false,
        lastApplyError: {
          message: 'corpus boom',
          at: failureAt.toISOString(),
          cause: expect.any(Error),
        },
      });
      expect(bothHandle.status()).toMatchObject({
        authority: 'corpus',
        corpusInterest: 'both',
        snapshotId: null,
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: null,
        metadataManifestHash: null,
        pending: false,
        lastApplyError: {
          message: 'corpus boom',
          at: failureAt.toISOString(),
          cause: expect.any(Error),
        },
      });
      expect(contentHandle.lastApplyError).toMatchObject({
        message: 'corpus boom',
        at: failureAt.toISOString(),
        cause: expect.any(Error),
      });

      journalShouldFail = false;
      corpusShouldFail = false;
      now = successAt;

      driver.notify('journal', 4);
      driver.notify('corpus', {
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        metadataSeq: 2,
        contentManifestHash: 'content-hash-4',
        metadataManifestHash: 'metadata-hash-2',
      });
      await driver.drainAll();

      expect(journalHandle.status()).toEqual({
        authority: 'journal',
        cursor: 4,
        pending: false,
        lastApplyError: null,
      });
      expect(journalHandle.lastApplyError).toBeNull();
      expect(contentHandle.status()).toEqual({
        authority: 'corpus',
        corpusInterest: 'content',
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        metadataSeq: 2,
        contentManifestHash: 'content-hash-4',
        metadataManifestHash: 'metadata-hash-2',
        pending: false,
        lastApplyError: null,
      });
      expect(metadataHandle.status()).toEqual({
        authority: 'corpus',
        corpusInterest: 'metadata',
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        metadataSeq: 2,
        contentManifestHash: 'content-hash-4',
        metadataManifestHash: 'metadata-hash-2',
        pending: false,
        lastApplyError: null,
      });
      expect(bothHandle.status()).toEqual({
        authority: 'corpus',
        corpusInterest: 'both',
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        metadataSeq: 2,
        contentManifestHash: 'content-hash-4',
        metadataManifestHash: 'metadata-hash-2',
        pending: false,
        lastApplyError: null,
      });
      expect(contentHandle.lastApplyError).toBeNull();
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('shutdown() stops handles without deleting persisted cursor rows', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });

    try {
      driver.register({
        id: 'expansion-cursor',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply() {},
      });

      driver.notify('journal', 8);
      await driver.drainAll();
      await driver.shutdown();

      expect(readJournalCursor(db, 'expansion-cursor')).toBe(8);
      expect(readCursorCount(db, 'expansion-cursor')).toBe(1);
    } finally {
      db.close();
    }
  });
});
