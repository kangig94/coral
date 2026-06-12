import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle, TimePort } from '#src/infra/port-types.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ConsumerDriver, FreshnessApplyFailure, FreshnessTimeout } from '#src/coordinator/consumer-driver/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import type { CorpusConsumerRegistration, JournalConsumerRegistration } from '#src/store/consumer-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function createDriver(apply: Extract<JournalConsumerRegistration, { kind: 'apply' }>['apply'] = async () => {}): {
  db: Database;
  driver: ConsumerDriver;
  consumerId: string;
} {
  const db = createDb();
  const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
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

function createCorpusDriver(
  apply: CorpusConsumerRegistration['apply'] = async () => {},
  timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = REAL_CONSUMER_DRIVER_TIMERS,
  onApplyFailure?: CorpusConsumerRegistration['onApplyFailure'],
): {
  db: Database;
  driver: ConsumerDriver;
  consumerId: string;
  handle: ReturnType<ConsumerDriver['register']>;
} {
  const db = createDb();
  const driver = new ConsumerDriver({ db, time: timers, now: realConsumerDriverNow });
  const consumerId = 'corpus-consumer';
  const handle = driver.register({
    id: consumerId,
    authority: 'corpus',
    kind: 'apply',
    registrationKind: 'expansion',
    corpusInterest: 'both',
    ...(onApplyFailure === undefined ? {} : { onApplyFailure }),
    apply,
  });

  return { db, driver, consumerId, handle };
}

function buildSnapshot(overrides: Partial<CorpusSnapshot> = {}): CorpusSnapshot {
  const contentSeq = overrides.contentSeq ?? 1;
  const metadataSeq = overrides.metadataSeq ?? 1;
  return {
    snapshotId: overrides.snapshotId ?? `snapshot-${contentSeq}-${metadataSeq}`,
    contentSeq,
    metadataSeq,
    contentManifestHash: overrides.contentManifestHash ?? `content-hash-${contentSeq}`,
    metadataManifestHash: overrides.metadataManifestHash ?? `metadata-hash-${metadataSeq}`,
  };
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

  it('rejects pending journal waiters promptly when apply fails without waiting for timeout', async () => {
    const db = createDb();
    const timerHandle: TimerHandle = {};
    const timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
      setTimeout: vi.fn((_fn: () => void, _ms: number): TimerHandle => timerHandle),
      clearTimeout: vi.fn((_handle: TimerHandle | null): void => {}),
    };
    const driver = new ConsumerDriver({ db, time: timers, now: realConsumerDriverNow });
    const consumerId = 'failing-journal-consumer';
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation((): void => {});

    driver.register({
      id: consumerId,
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      async apply(): Promise<void> {
        applyStarted.resolve();
        await releaseApply.promise;
        throw new Error('journal apply exploded');
      },
    });

    try {
      const waitResult = driver
        .waitFreshUntil('journal', 5, consumerId, 90000)
        .catch((error: unknown): unknown => error);

      driver.notify('journal', 5);
      await applyStarted.promise;
      await flushMicrotasks();

      await expect(Promise.race([waitResult, Promise.resolve('pending' as const)])).resolves.toBe('pending');

      releaseApply.resolve();
      await driver.drainAll();
      await flushMicrotasks();

      const result = await Promise.race([waitResult, Promise.resolve('pending' as const)]);
      expect(result).toBeInstanceOf(FreshnessApplyFailure);

      const failure = result as FreshnessApplyFailure;
      expect(failure.consumerId).toBe(consumerId);
      expect(failure.applyError).toMatchObject({
        message: 'journal apply exploded',
        at: expect.any(String),
        cause: expect.any(Error),
      });
      expect(failure.message).toContain(`consumer=${consumerId}`);
      expect(failure.message).toContain('journal apply exploded');
      expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);
      expect(errorSpy).toHaveBeenCalledWith(
        'ConsumerDriver apply failed (failing-journal-consumer)',
        expect.any(Error),
      );
    } finally {
      releaseApply.resolve();
      errorSpy.mockRestore();
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
    const driver = new ConsumerDriver({ db, time: timers, now: realConsumerDriverNow });
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
      const waits = Array.from({ length: 1000 }, () =>
        driver.waitFreshUntil('journal', 100, consumerId, 50).catch((error) => error),
      );

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

  it('resolves real corpus waits after a successful corpus apply', async () => {
    const snapshot = buildSnapshot({ snapshotId: 'corpus-fresh', contentSeq: 2, metadataSeq: 2 });
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const { db, driver, consumerId } = createCorpusDriver(async () => {
      applyStarted.resolve();
      await releaseApply.promise;
    });

    try {
      let resolved = false;
      const waitPromise = driver.waitFreshUntil('corpus', snapshot, consumerId, 5000).then(() => {
        resolved = true;
      });

      await flushMicrotasks();
      expect(resolved).toBe(false);

      driver.notify('corpus', snapshot);
      await applyStarted.promise;
      await flushMicrotasks();

      expect(resolved).toBe(false);

      releaseApply.resolve();
      await waitPromise;

      expect(resolved).toBe(true);
      await driver.drainAll();
    } finally {
      releaseApply.resolve();
      await driver.shutdown();
      db.close();
    }
  });

  it('keeps corpus waiters unresolved after a clean no-advance apply until a newer snapshot advances', async () => {
    const staleSnapshot = buildSnapshot({ snapshotId: 'corpus-stale', contentSeq: 2, metadataSeq: 2 });
    const newerSnapshot = buildSnapshot({ snapshotId: 'corpus-newer', contentSeq: 3, metadataSeq: 3 });
    const staleApplyStarted = createDeferred<void>();
    const releaseStaleApply = createDeferred<void>();
    const onApplyFailure = vi.fn();
    const applyCalls: string[] = [];
    const { db, driver, consumerId, handle } = createCorpusDriver(
      async ({ snapshot }) => {
        applyCalls.push(snapshot.snapshotId);
        if (snapshot.snapshotId === staleSnapshot.snapshotId) {
          staleApplyStarted.resolve();
          await releaseStaleApply.promise;
          return { advance: false, reason: 'stale-snapshot' };
        }
      },
      REAL_CONSUMER_DRIVER_TIMERS,
      onApplyFailure,
    );

    try {
      let resolved = false;
      const waitPromise = driver.waitFreshUntil('corpus', staleSnapshot, consumerId, 5000).then(() => {
        resolved = true;
      });

      driver.notify('corpus', staleSnapshot);
      await staleApplyStarted.promise;
      await flushMicrotasks();

      expect(resolved).toBe(false);

      releaseStaleApply.resolve();
      await driver.drainAll();
      await flushMicrotasks();

      expect(resolved).toBe(false);
      expect(onApplyFailure).not.toHaveBeenCalled();
      expect(handle.lastApplyError).toBeNull();
      expect(handle.status()).toMatchObject({
        authority: 'corpus',
        snapshotId: null,
        contentSeq: 0,
        metadataSeq: 0,
        pending: false,
        lastApplyError: null,
      });

      driver.notify('corpus', newerSnapshot);
      await waitPromise;
      await driver.drainAll();

      expect(resolved).toBe(true);
      expect(applyCalls).toEqual(['corpus-stale', 'corpus-newer']);
      expect(handle.status()).toMatchObject({
        authority: 'corpus',
        snapshotId: 'corpus-newer',
        contentSeq: 3,
        metadataSeq: 3,
        lastApplyError: null,
      });
    } finally {
      releaseStaleApply.resolve();
      await driver.shutdown();
      db.close();
    }
  });

  it('resolves forced corpus waits only after the returned generation is applied', async () => {
    const snapshot = buildSnapshot({ snapshotId: 'forced-current', contentSeq: 3, metadataSeq: 3 });
    const forcedApplyStarted = createDeferred<void>();
    const releaseForcedApply = createDeferred<void>();
    let applyCount = 0;
    const { db, driver, consumerId } = createCorpusDriver(async () => {
      applyCount += 1;
      if (applyCount === 2) {
        forcedApplyStarted.resolve();
        await releaseForcedApply.promise;
      }
    });

    try {
      driver.notify('corpus', snapshot);
      await driver.waitFreshUntil('corpus', snapshot, consumerId, 5000);
      expect(applyCount).toBe(1);

      const forced = driver.forceCorpusApply(snapshot, {
        reason: 'projection-artifact-lag',
        consumers: [consumerId],
      });
      await forcedApplyStarted.promise;

      let generationResolved = false;
      const generationWait = driver
        .waitFreshUntil('corpus', { snapshot, atLeastGeneration: forced.generation }, consumerId, 5000)
        .then(() => {
          generationResolved = true;
        });

      await flushMicrotasks();
      expect(generationResolved).toBe(false);

      releaseForcedApply.resolve();
      await generationWait;

      expect(generationResolved).toBe(true);
      expect(applyCount).toBe(2);
    } finally {
      releaseForcedApply.resolve();
      await driver.shutdown();
      db.close();
    }
  });

  it('runs a forced corpus apply parked during normal corpus apply before newer normal snapshots', async () => {
    const first = buildSnapshot({ snapshotId: 'normal-first', contentSeq: 1, metadataSeq: 1 });
    const forcedSnapshot = buildSnapshot({ snapshotId: 'forced-priority', contentSeq: 1, metadataSeq: 1 });
    const parked = buildSnapshot({ snapshotId: 'normal-parked', contentSeq: 2, metadataSeq: 2 });
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const forcedStarted = createDeferred<void>();
    const releaseForced = createDeferred<void>();
    const calls: string[] = [];
    const { db, driver, consumerId } = createCorpusDriver(async ({ snapshot }) => {
      calls.push(snapshot.snapshotId);
      if (snapshot.snapshotId === first.snapshotId) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      if (snapshot.snapshotId === forcedSnapshot.snapshotId) {
        forcedStarted.resolve();
        await releaseForced.promise;
      }
    });

    try {
      driver.notify('corpus', first);
      await firstStarted.promise;
      driver.notify('corpus', parked);
      const forced = driver.forceCorpusApply(forcedSnapshot, {
        reason: 'projection-artifact-lag',
        consumers: [consumerId],
      });
      let generationResolved = false;
      const generationWait = driver
        .waitFreshUntil('corpus', { snapshot: forcedSnapshot, atLeastGeneration: forced.generation }, consumerId, 5000)
        .then(() => {
          generationResolved = true;
        });

      releaseFirst.resolve();
      await forcedStarted.promise;
      expect(calls).toEqual(['normal-first', 'forced-priority']);
      expect(generationResolved).toBe(false);

      releaseForced.resolve();
      await generationWait;
      await driver.drainAll();

      expect(generationResolved).toBe(true);
      expect(calls).toEqual(['normal-first', 'forced-priority', 'normal-parked']);
    } finally {
      releaseFirst.resolve();
      releaseForced.resolve();
      await driver.shutdown();
      db.close();
    }
  });

  it('rejects forced corpus waiters and clears timeout handles when handle.stop() runs during apply', async () => {
    const snapshot = buildSnapshot({ snapshotId: 'forced-stop', contentSeq: 4, metadataSeq: 4 });
    const timerHandle: TimerHandle = {};
    const timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
    };
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    const { db, driver, consumerId, handle } = createCorpusDriver(async () => {
      applyStarted.resolve();
      await releaseApply.promise;
    }, timers);

    try {
      driver.notify('corpus', snapshot);
      await applyStarted.promise;
      const forced = driver.forceCorpusApply(snapshot, {
        reason: 'projection-artifact-lag',
        consumers: [consumerId],
      });
      const waitResult = driver
        .waitFreshUntil('corpus', { snapshot, atLeastGeneration: forced.generation }, consumerId, 5000)
        .catch((error) => error);

      const stopPromise = handle.stop();
      releaseApply.resolve();
      await stopPromise;

      await expect(waitResult).resolves.toMatchObject({ message: `Consumer '${consumerId}' stopped` });
      expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);
    } finally {
      releaseApply.resolve();
      await driver.shutdown();
      db.close();
    }
  });

  it('rejects pending waiters and clears timeout handles when driver.shutdown() runs during apply', async () => {
    const timerHandle: TimerHandle = {};
    const timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
    };
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: timers, now: realConsumerDriverNow });
    const consumerId = 'shutdown-journal-consumer';
    const applyStarted = createDeferred<void>();
    const releaseApply = createDeferred<void>();
    driver.register({
      id: consumerId,
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      async apply() {
        applyStarted.resolve();
        await releaseApply.promise;
      },
    });

    try {
      const waitResult = driver.waitFreshUntil('journal', 9, consumerId, 5000).catch((error) => error);
      driver.notify('journal', 8);
      await applyStarted.promise;

      const shutdownPromise = driver.shutdown();
      releaseApply.resolve();
      await shutdownPromise;

      await expect(waitResult).resolves.toMatchObject({ message: 'ConsumerDriver shutting down' });
      expect(timers.clearTimeout).toHaveBeenCalledWith(timerHandle);
    } finally {
      releaseApply.resolve();
      await driver.shutdown();
      db.close();
    }
  });
});
