// Phase 7 of apply-contract-reform plan.
//
// Hardens the cross-arm narrowing introduced by AC3:
//   journal-cursor + corpus-apply + stateless lifecycle on a single
//   ConsumerDriver, with explicit checks on `statusFor()`, `waitFreshUntil()`
//   error codes, `stuckConsumers()` exclusion, and stateless stop/unregister
//   idempotency. The two-axis discriminator union (`'authority' in status`
//   for journal/corpus; `status.kind === 'stateless'` for stateless) is the
//   most fragile new invariant in the contract reform — `authority?: never`
//   on stateless does not always produce a useful TS error in caller
//   switch/narrow contexts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import { createDeferred } from '#tools/testing/deferred.js';

const nodeStorage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync'> = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snap-1',
  contentSeq: 3,
  metadataSeq: 2,
  contentManifestHash: 'content-hash-1',
  metadataManifestHash: 'metadata-hash-1',
};

describe('ConsumerDriver three-arm discriminator contract (Phase 7)', () => {
  it('statusFor() narrows correctly across journal-cursor, corpus-apply, and stateless arms', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      const cursorHandle = driver.register({
        id: 'three-arm-cursor',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      const corpusHandle = driver.register({
        id: 'three-arm-corpus',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        apply: async () => {},
      });
      const statelessHandle = driver.register({
        id: 'three-arm-stateless',
        kind: 'stateless',
        registrationKind: 'stateless',
      });

      const cursorStatus = cursorHandle.status();
      expect('authority' in cursorStatus).toBe(true);
      if (!('authority' in cursorStatus)) throw new Error('unreachable');
      expect(cursorStatus.authority).toBe('journal');
      expect(cursorStatus.cursor).toBe(0);

      const corpusStatus = corpusHandle.status();
      expect('authority' in corpusStatus).toBe(true);
      if (!('authority' in corpusStatus)) throw new Error('unreachable');
      expect(corpusStatus.authority).toBe('corpus');
      expect(corpusStatus.corpusInterest).toBe('content');

      const statelessStatus = statelessHandle.status();
      expect('authority' in statelessStatus).toBe(false);
      expect('kind' in statelessStatus && statelessStatus.kind === 'stateless').toBe(true);
      if (!('kind' in statelessStatus) || statelessStatus.kind !== 'stateless') throw new Error('unreachable');
      expect(statelessStatus.pending).toBe(false);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it("waitFreshUntil throws 'consumer_wait_fresh_invalid_target' for stateless ids and 'consumer_authority_mismatch' for cross-authority lookups", () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      driver.register({
        id: 'three-arm-cursor',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'base',
      });
      driver.register({
        id: 'three-arm-corpus',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        apply: async () => {},
      });
      driver.register({
        id: 'three-arm-stateless',
        kind: 'stateless',
        registrationKind: 'stateless',
      });

      // Stateless ids are structurally rejected before authority comparison.
      expect(() => driver.waitFreshUntil('journal', 1, 'three-arm-stateless')).toThrow(CoralSetupError);
      try {
        driver.waitFreshUntil('journal', 1, 'three-arm-stateless');
      } catch (err) {
        expect(err).toBeInstanceOf(CoralSetupError);
        expect((err as CoralSetupError).code).toBe('consumer_wait_fresh_invalid_target');
      }

      // Same code for the corpus authority probe — the stateless rejection
      // is structural and ignores the authority axis.
      try {
        driver.waitFreshUntil('corpus', SNAPSHOT, 'three-arm-stateless');
      } catch (err) {
        expect(err).toBeInstanceOf(CoralSetupError);
        expect((err as CoralSetupError).code).toBe('consumer_wait_fresh_invalid_target');
      }

      // Asking for journal freshness against a corpus consumer reports the
      // authority mismatch (the existing AC3 routing — stateless check
      // precedes authority comparison so the codes do not collide).
      try {
        driver.waitFreshUntil('journal', 1, 'three-arm-corpus');
      } catch (err) {
        expect(err).toBeInstanceOf(CoralSetupError);
        expect((err as CoralSetupError).code).toBe('consumer_authority_mismatch');
      }
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('stuckConsumers() excludes stateless ids even after stopConsumer is invoked', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      // Pin a stuck apply consumer so the test proves `stuckConsumers()`
      // does report something: stateless exclusion must be explicit, not a
      // side-effect of an empty result.
      const applyStarted = createDeferred<void>();
      const releaseApply = createDeferred<void>();
      const stuckApply = driver.register({
        id: 'three-arm-stuck-apply',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply() {
          applyStarted.resolve();
          await releaseApply.promise;
        },
      });

      const statelessHandle = driver.register({
        id: 'three-arm-stateless',
        kind: 'stateless',
        registrationKind: 'stateless',
        onStop: async () => {},
      });

      driver.notify('journal', 5);
      await applyStarted.promise;

      // Initiate stop on both: the stuck apply blocks; stateless settles
      // immediately. `stuckConsumers()` must show the apply id but never
      // the stateless id.
      const stuckStop = stuckApply.stop();
      await statelessHandle.stop();

      const stuck = driver.stuckConsumers();
      const stuckIds = stuck.map((entry) => entry.id);
      expect(stuckIds).toContain('three-arm-stuck-apply');
      expect(stuckIds).not.toContain('three-arm-stateless');
      const stuckEntry = stuck.find((entry) => entry.id === 'three-arm-stuck-apply');
      expect(stuckEntry?.elapsedSinceStopMs).toBeGreaterThanOrEqual(0);

      // Drain to clean shutdown — release the stuck apply so the test exits
      // cleanly.
      releaseApply.resolve();
      await stuckStop;
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});

describe('Stateless lifecycle stop/unregister idempotency (Phase 7)', () => {
  it('onStop fires exactly once across stop -> stop -> unregister', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    const onStop = vi.fn(async () => {});
    try {
      const handle = driver.register({
        id: 'stateless-idempotent',
        kind: 'stateless',
        registrationKind: 'stateless',
        onStop,
      });

      await handle.stop();
      await handle.stop();
      await handle.unregister();
      // Re-stop / re-unregister must remain no-ops.
      await handle.stop();
      await handle.unregister();

      expect(onStop).toHaveBeenCalledTimes(1);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('unregister() before stop() rejects with consumer_unregister_requires_stop', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      const handle = driver.register({
        id: 'stateless-bad-order',
        kind: 'stateless',
        registrationKind: 'stateless',
      });
      await expect(handle.unregister()).rejects.toBeInstanceOf(CoralSetupError);
      await expect(handle.unregister()).rejects.toMatchObject({ code: 'consumer_unregister_requires_stop' });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
