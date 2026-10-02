import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it, vi } from 'vitest';

import type { TimerHandle, TimePort } from '#src/infra/port-types.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { backendLog } from '#src/infra/backend-log.js';
import { ConsumerDriver, FreshnessApplyFailure, FreshnessTimeout } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import type { KbCorpusProjectionReader } from '#src/kb/projection-input-contract.js';
import type { CorpusAuthoritativeFreshness, CorpusConsumerRegistration } from '#src/store/consumer-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function createCorpusDriver(
  apply: CorpusConsumerRegistration['apply'] = async () => {},
  timers: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = REAL_CONSUMER_DRIVER_TIMERS,
  onApplyFailure?: CorpusConsumerRegistration['onApplyFailure'],
  corpusProjectionReader?: KbCorpusProjectionReader,
  readAuthoritativeFreshness: CorpusConsumerRegistration['readAuthoritativeFreshness'] = async () => ({
    kind: 'stale',
    reason: 'artifact-missing',
  }),
): {
  db: Database;
  driver: ConsumerDriver;
  consumerId: string;
  handle: ReturnType<ConsumerDriver['register']>;
} {
  const db = createDb();
  const driver = new ConsumerDriver({
    db,
    time: timers,
    now: realConsumerDriverNow,
    ...(corpusProjectionReader === undefined ? {} : { corpusProjectionReader }),
  });
  const consumerId = 'corpus-consumer';
  const handle = driver.register({
    id: consumerId,
    authority: 'corpus',
    kind: 'apply',
    registrationKind: 'expansion',
    corpusInterest: 'both',
    projectionIdentityHash: () => 'waitfresh-test-projection-v1',
    readAuthoritativeFreshness,
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

  it('removes a timed-out waiter before a late apply', async () => {
    const db = createDb();
    const timerHandle: TimerHandle = {};
    let expire!: () => void;
    const timers = {
      setTimeout: vi.fn((callback: () => void) => {
        expire = callback;
        return timerHandle;
      }),
      clearTimeout: vi.fn(),
    };
    const driver = new ConsumerDriver({ db, time: timers, now: realConsumerDriverNow });
    driver.register({
      id: 'journal-consumer',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      apply: async () => {},
    });
    try {
      const result = driver.waitFreshUntil('journal', 5, 'journal-consumer', 1234).catch((error) => error);
      expire();
      await expect(result).resolves.toBeInstanceOf(FreshnessTimeout);
      driver.notify('journal', 5);
      await driver.drainAll();
      expect(timers.clearTimeout).not.toHaveBeenCalled();
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('fails closed when a consumer returns a false current proof', async () => {
    const apply = vi.fn(async () => {});
    const snapshot = buildSnapshot({ snapshotId: 'false-current', contentSeq: 6, metadataSeq: 6 });
    const { db, driver, consumerId, handle } = createCorpusDriver(
      apply,
      REAL_CONSUMER_DRIVER_TIMERS,
      undefined,
      undefined,
      async (target): Promise<CorpusAuthoritativeFreshness> => ({
        kind: 'current',
        appliedSnapshot: target.snapshot,
        generatedCommunityGeneration: target.generatedCommunityGeneration,
        generatedCommunityDocsHash: `${target.generatedCommunityDocsHash}-wrong`,
        projectionIdentityHash: target.projectionIdentityHash,
      }),
    );
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation((): void => {});

    try {
      const waitResult = driver.waitFreshUntil('corpus', snapshot, consumerId, 5000).catch((error: unknown) => error);
      driver.notify('corpus', snapshot);
      await driver.drainAll();

      await expect(waitResult).resolves.toBeInstanceOf(FreshnessApplyFailure);
      expect(apply).not.toHaveBeenCalled();
      expect(handle.status()).toMatchObject({ snapshotId: null, contentSeq: 0, metadataSeq: 0 });
    } finally {
      errorSpy.mockRestore();
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
