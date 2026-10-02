import type { TimerHandle } from '#src/infra/port-types.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ConsumerDrainTimeout, ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { ConsumerApplyError, JournalConsumerRegistration } from '#src/store/consumer-contract.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
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
  it('times out a shutdown drain through its injected timer when apply ignores abort', async () => {
    const db = createDb();
    let expire!: () => void;
    const driver = new ConsumerDriver({
      db,
      now: realConsumerDriverNow,
      time: {
        setTimeout: (callback: () => void): TimerHandle => {
          expire = callback;
          return {};
        },
        clearTimeout: () => {},
      },
    });
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    driver.register({
      id: 'stuck',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      apply: async () => {
        started.resolve();
        await release.promise;
      },
    });
    try {
      driver.notify('journal', 5);
      await started.promise;
      const shutdown = driver.shutdown({ drainTimeoutMs: 1 });
      const rejected = expect(shutdown).rejects.toBeInstanceOf(ConsumerDrainTimeout);
      expire();
      await rejected;
      expect(readJournalCursor(db, 'stuck')).toBe(0);
    } finally {
      release.resolve();
      await driver.shutdown();
      db.close();
    }
  });
});
