import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { applyMigrations } from '../../store/migrations.js';
import { ConsumerDriver, FreshnessTimeout, type JournalConsumerRegistration } from '../consumer-driver.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolvePromise = res;
    reject = rej;
  });

  return {
    promise,
    resolve: (value) => resolvePromise(value as T | PromiseLike<T>),
    reject,
  };
}

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function createDriver(
  apply: JournalConsumerRegistration['apply'] = async () => {},
): { db: InstanceType<typeof Database>; driver: ConsumerDriver; consumerId: string } {
  const db = createDb();
  const driver = new ConsumerDriver({ db });
  const consumerId = 'journal-consumer';

  driver.register({
    id: consumerId,
    authority: 'journal',
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
      const waitPromise = driver.waitFreshUntil(0, consumerId, 5000).then(() => {
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
      const waitPromise = driver.waitFreshUntil(10, consumerId, 5000).then(() => {
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

      const observed = driver.waitFreshUntil(100, consumerId, 50).then(
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
      expect(driver.__debugWaiterCount(consumerId)).toBe(0);

      driver.notify('journal', 200);
      await applyStarted.promise;

      releaseApply.resolve();
      await driver.drainAll();
      await flushMicrotasks();

      expect(resolveCalls).toBe(0);
      expect(rejectCalls).toBe(1);
      expect(driver.__debugWaiterCount(consumerId)).toBe(0);
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
      const waits = Array.from({ length: 1000 }, () => driver.waitFreshUntil(100, consumerId, 50).catch((error) => error));

      expect(driver.__debugWaiterCount(consumerId)).toBe(1000);

      await vi.advanceTimersByTimeAsync(50);

      const results = await Promise.all(waits);
      for (const result of results) {
        expect(result).toBeInstanceOf(FreshnessTimeout);
      }

      expect(driver.__debugWaiterCount(consumerId)).toBe(0);
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
        driver.waitFreshUntil(5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
        driver.waitFreshUntil(5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
        driver.waitFreshUntil(5, consumerId, 5000).then(() => {
          resolveCount += 1;
        }),
      ];

      expect(driver.__debugWaiterCount(consumerId)).toBe(3);

      driver.notify('journal', 5);
      await applyStarted.promise;

      expect(resolveCount).toBe(0);

      releaseApply.resolve();
      await Promise.all(waits);

      expect(resolveCount).toBe(3);
      expect(driver.__debugWaiterCount(consumerId)).toBe(0);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
