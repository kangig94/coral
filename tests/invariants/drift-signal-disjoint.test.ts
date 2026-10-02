import { describe, expect, it } from 'vitest';

import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snapshot-a',
  contentSeq: 1,
  metadataSeq: 1,
  contentManifestHash: 'content-hash',
  metadataManifestHash: 'metadata-hash',
};

const STALE_CORPUS_FRESHNESS = {
  projectionIdentityHash: () => 'drift-signal-test-v1',
  readAuthoritativeFreshness: async () => ({ kind: 'stale', reason: 'artifact-missing' }) as const,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('drift signal split', () => {
  it('forces unchanged-snapshot corpus apply through waitFreshUntil generation without seq bumps', async () => {
    const db = openKbTestStoreDb(':memory:');
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const secondStarted = deferred();
    const releaseSecond = deferred();
    let applyCount = 0;
    driver.register({
      id: 'corpus-a',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'base',
      corpusInterest: 'content',
      ...STALE_CORPUS_FRESHNESS,
      async apply() {
        applyCount += 1;
        if (applyCount === 2) {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      },
    });

    driver.notifyCorpus(SNAPSHOT);
    await driver.waitFreshUntil('corpus', SNAPSHOT, 'corpus-a', 500);
    expect(applyCount).toBe(1);

    const forced = driver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['corpus-a'],
    });
    await driver.waitFreshUntil('corpus', SNAPSHOT, 'corpus-a', 50);
    await secondStarted.promise;
    const generationWait = driver.waitFreshUntil(
      'corpus',
      { snapshot: SNAPSHOT, atLeastGeneration: forced.generation },
      'corpus-a',
      500,
    );

    let generationResolved = false;
    void generationWait.then(() => {
      generationResolved = true;
    });
    await Promise.resolve();
    expect(generationResolved).toBe(false);

    releaseSecond.resolve();
    await generationWait;
    expect(applyCount).toBe(2);
  });

  it('surfaces force-apply lifecycle edges through existing waitFreshUntil errors', async () => {
    const stoppedDb = openKbTestStoreDb(':memory:');
    const stoppedDriver = new ConsumerDriver({
      db: stoppedDb,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: realConsumerDriverNow,
    });
    const stopped = stoppedDriver.register({
      id: 'stopped-corpus',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'base',
      corpusInterest: 'content',
      ...STALE_CORPUS_FRESHNESS,
      async apply() {},
    });
    await stopped.stop();
    const stoppedForced = stoppedDriver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['stopped-corpus'],
    });
    try {
      stoppedDriver.waitFreshUntil(
        'corpus',
        { snapshot: SNAPSHOT, atLeastGeneration: stoppedForced.generation },
        'stopped-corpus',
      );
      throw new Error('Expected stopped consumer wait to throw.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'consumer_wait_unsupported' });
    }

    const unregisteredDb = openKbTestStoreDb(':memory:');
    const unregisteredDriver = new ConsumerDriver({
      db: unregisteredDb,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: realConsumerDriverNow,
    });
    const unregistered = unregisteredDriver.register({
      id: 'unregistered-corpus',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'expansion',
      corpusInterest: 'content',
      ...STALE_CORPUS_FRESHNESS,
      async apply() {},
    });
    const unregisteredForced = unregisteredDriver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['unregistered-corpus'],
    });
    await unregistered.stop();
    await unregistered.unregister();

    try {
      unregisteredDriver.waitFreshUntil(
        'corpus',
        { snapshot: SNAPSHOT, atLeastGeneration: unregisteredForced.generation },
        'unregistered-corpus',
      );
      throw new Error('Expected unregistered consumer wait to throw.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'consumer_not_registered' });
    }
  });
});
