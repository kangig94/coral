import { readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { applyMigrations } from '../../store/migrations.js';
import { backendLog } from '../../shared/backend-log.js';
import {
  ConsumerDriver,
  type ConsumerApplyError,
  type CorpusConsumerRegistration,
  type JournalConsumerRegistration,
} from '../consumer-driver.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function readJournalCursor(db: InstanceType<typeof Database>, consumerId: string): number {
  const row = db
    .prepare('SELECT cursor FROM equipment_cursors WHERE consumer_id = ?')
    .get(consumerId) as { cursor: number } | undefined;

  return row?.cursor ?? 0;
}

function readCursorCount(db: InstanceType<typeof Database>, consumerId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM equipment_cursors WHERE consumer_id = ?').get(consumerId) as {
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
    const driver = new ConsumerDriver({ db });
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const healthyCalls: Array<{ fromSeq: number; upToSeq: number }> = [];
    const onApplyFailure = vi.fn((_err: ConsumerApplyError) => {
      throw new Error('callback exploded');
    });

    const failing: JournalConsumerRegistration = {
      id: 'failing-consumer',
      authority: 'journal',
      onApplyFailure,
      async apply() {
        throw new Error('boom');
      },
    };
    const healthy: JournalConsumerRegistration = {
      id: 'healthy-consumer',
      authority: 'journal',
      async apply({ fromSeq, upToSeq }) {
        healthyCalls.push({ fromSeq, upToSeq });
      },
    };

    try {
      const failingHandle = driver.register(failing);
      driver.register(healthy);

      driver.notify('journal', 7);
      await driver.drainAll();

      expect(onApplyFailure).toHaveBeenCalledWith(expect.objectContaining({
        message: 'boom',
        at: expect.any(String),
        cause: expect.any(Error),
      }));
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
      expect(errorSpy).toHaveBeenCalledWith('ConsumerDriver onApplyFailure failed (failing-consumer)', expect.any(Error));
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
    const driver = new ConsumerDriver({ db });
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

  it('supports register -> stop -> unregister for equipment consumers and drops future notifications after stop', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
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
        id: 'equipment-consumer',
        authority: 'journal',
        registrationKind: 'equipment',
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
      expect(readCursorCount(db, 'equipment-consumer')).toBe(1);

      await handle.unregister();

      expect(readCursorCount(db, 'equipment-consumer')).toBe(0);
    } finally {
      releaseGate?.();
      await driver.shutdown();
      db.close();
    }
  });

  it('makes stop() idempotent', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const apply = vi.fn(async () => {});

    try {
      const handle = driver.register({
        id: 'stoppable-consumer',
        authority: 'journal',
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
    const driver = new ConsumerDriver({ db });

    try {
      const handle = driver.register({
        id: 'base-consumer',
        authority: 'journal',
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

  it('status() reports journal and corpus authority shapes with and without lastApplyError', async () => {
    const db = createDb();
    const failureAt = new Date('2026-04-22T01:02:03.000Z');
    const successAt = new Date('2026-04-22T01:02:04.000Z');
    let now = failureAt;
    const driver = new ConsumerDriver({ db, now: () => now });
    let journalShouldFail = true;
    let corpusShouldFail = true;

    try {
      const journalHandle = driver.register({
        id: 'journal-status',
        authority: 'journal',
        async apply() {
          if (journalShouldFail) {
            throw new Error('journal boom');
          }
        },
      });
      const corpusHandle = driver.register({
        id: 'corpus-status',
        authority: 'corpus',
        corpusInterest: 'content',
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
      expect(corpusHandle.status()).toMatchObject({
        authority: 'corpus',
        snapshotId: null,
        contentSeq: 0,
        contentManifestHash: null,
        pending: false,
        lastApplyError: {
          message: 'corpus boom',
          at: failureAt.toISOString(),
          cause: expect.any(Error),
        },
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
      expect(corpusHandle.status()).toEqual({
        authority: 'corpus',
        snapshotId: 'snapshot-4',
        contentSeq: 4,
        contentManifestHash: 'content-hash-4',
        pending: false,
        lastApplyError: null,
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('shutdown() stops handles without deleting persisted cursor rows', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });

    try {
      driver.register({
        id: 'equipment-cursor',
        authority: 'journal',
        registrationKind: 'equipment',
        async apply() {},
      });

      driver.notify('journal', 8);
      await driver.drainAll();
      await driver.shutdown();

      expect(readJournalCursor(db, 'equipment-cursor')).toBe(8);
      expect(readCursorCount(db, 'equipment-cursor')).toBe(1);
    } finally {
      db.close();
    }
  });
});
