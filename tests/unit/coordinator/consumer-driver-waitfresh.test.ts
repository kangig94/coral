import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle, StoragePort, TimePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { ConsumerDriver, FreshnessTimeout } from '#src/coordinator/consumer-driver.js';
import type { JournalConsumerRegistration } from '#src/store/consumer-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function createDriver(
  apply: Extract<JournalConsumerRegistration, { kind: 'apply' }>['apply'] = async () => {},
): { db: InstanceType<typeof Database>; driver: ConsumerDriver; consumerId: string } {
  const db = createDb();
  const driver = new ConsumerDriver({ db });
  const consumerId = 'journal-consumer';

  driver.register({
    id: consumerId,
    authority: 'journal',
    kind: 'apply',
    registrationKind: 'expansion',
    apply,
  });

  return { db, driver, consumerId };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConsumerDriver waitFreshUntil', () => {
  it('resolves immediately on the next microtask when cursor is already fresh enough', async () => {
    const { db, driver, consumerId } = createDriver();

    try {
      let resolved = false;
      const waitPromise = driver.waitFreshUntil('journal', 0, consumerId, 5000).then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      await flushMicrotasks();

      expect(resolved).toBe(true);
      await waitPromise;
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('blocks until a successful apply advances the cursor past the requested target', async () => {
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const { db, driver, consumerId } = createDriver(async () => {
      applyStarted.resolve();
      await releaseApply.promise;
    });

    try {
      let resolved = false;
      const waitPromise = driver.waitFreshUntil('journal', 10, consumerId, 5000).then(() => {
        resolved = true;
      });

      await flushMicrotasks();
      expect(resolved).toBe(false);

      driver.notify('journal', 10);
      await applyStarted.promise;
      await flushMicrotasks();

      expect(resolved).toBe(false);

      releaseApply.resolve();
      await flushMicrotasks();

      expect(resolved).toBe(true);

      await waitPromise;
      await driver.drainAll();
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('uses the injected timer port for waitFreshUntil timeouts', async () => {
    const db = createDb();
    const timerHandle: TimerHandle = {};
    const timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
    };
    const driver = new ConsumerDriver({ db, time: timers });
    const consumerId = 'journal-consumer';
    driver.register({
      id: consumerId,
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      apply: async () => {},
    });

    try {
      const waitPromise = driver.waitFreshUntil('journal', 5, consumerId, 1234);

      expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1234);

      driver.notify('journal', 5);
      await waitPromise;

      expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('rejects with FreshnessTimeout and does not re-invoke a settled waiter after a late apply', async () => {
    vi.useFakeTimers();
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const { db, driver, consumerId } = createDriver(async () => {
      applyStarted.resolve();
      await releaseApply.promise;
    });

    try {
      let resolveCalls = 0;
      let rejectCalls = 0;

      const observed = driver.waitFreshUntil('journal', 100, consumerId, 50).then(
        () => {
          resolveCalls += 1;
          return 'resolved' as const;
        },
        (error) => {
          rejectCalls += 1;
          return error;
        },
      );

      await vi.advanceTimersByTimeAsync(50);

      const timeoutResult = await observed;
      expect(timeoutResult).toBeInstanceOf(FreshnessTimeout);
      expect(resolveCalls).toBe(0);
      expect(rejectCalls).toBe(1);

      driver.notify('journal', 200);
      await applyStarted.promise;

      releaseApply.resolve();
      await driver.drainAll();
      await flushMicrotasks();

      expect(resolveCalls).toBe(0);
      expect(rejectCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      await driver.shutdown();
      db.close();
    }
  });

  it('removes timed-out waiters so the internal waiter set returns to zero under load', async () => {
    vi.useFakeTimers();
    const { db, driver, consumerId } = createDriver();

    try {
      const waits = Array.from({ length: 1000 }, () => driver.waitFreshUntil('journal', 100, consumerId, 50).catch((error) => error));

      await vi.advanceTimersByTimeAsync(50);

      const results = await Promise.all(waits);
      for (const result of results) {
        expect(result).toBeInstanceOf(FreshnessTimeout);
      }
    } finally {
      vi.useRealTimers();
      await driver.shutdown();
      db.close();
    }
  });

  it('resolves multiple concurrent waiters from one apply and removes each waiter from the set', async () => {
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const { db, driver, consumerId } = createDriver(async () => {
      applyStarted.resolve();
      await releaseApply.promise;
    });

    try {
      let resolveCount = 0;
      const waits = [
        driver.waitFreshUntil('journal', 5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
        driver.waitFreshUntil('journal', 5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
        driver.waitFreshUntil('journal', 5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
      ];

      driver.notify('journal', 5);
      await applyStarted.promise;

      expect(resolveCount).toBe(0);

      releaseApply.resolve();
      await Promise.all(waits);

      expect(resolveCount).toBe(3);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
