import { currentCoralStoreFormat } from '#src/store-format.js';
// Phase 7 of apply-contract-reform plan.
//
// AC3 declared per-arm `kind` and `registrationKind` literals on all four arms
// of `ConsumerRegistration` so the two-axis rule
//   `kind: 'stateless' ⟺ registrationKind: 'stateless'`
//   `kind: 'cursor' | 'apply' ⟹ registrationKind: 'base' | 'expansion'`
// is enforced compile-time on every arm.
//
// The compile-time half lives in
// `tests/types/consumer-registration-axes.test-d.ts`, typechecked by
// `tsc -p tests/types/tsconfig.json` (and now also by
// `tsc -p tsconfig.test.json` as the broader gate).
//
// This file holds the *runtime* half: `ConsumerDriver.register()` must accept
// every type-valid two-axis combination.

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { ConsumerRegistration } from '#src/store/consumer-contract.js';
function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

describe('Two-axis kind/registrationKind invariant', () => {
  it('runtime: ConsumerDriver.register() accepts every type-valid two-axis combination', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      const valid: ConsumerRegistration[] = [
        {
          id: 'cursor-base',
          authority: 'journal',
          kind: 'cursor',
          registrationKind: 'base',
        },
        {
          id: 'apply-base',
          authority: 'journal',
          kind: 'apply',
          registrationKind: 'base',
          apply: async () => {},
        },
        {
          id: 'apply-expansion',
          authority: 'journal',
          kind: 'apply',
          registrationKind: 'expansion',
          apply: async () => {},
        },
        {
          id: 'corpus-base',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'base',
          corpusInterest: 'content',
          projectionIdentityHash: () => 'corpus-base-v1',
          readAuthoritativeFreshness: async () => ({ kind: 'stale', reason: 'artifact-missing' }),
          apply: async () => {},
        },
        {
          id: 'corpus-expansion',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'metadata',
          projectionIdentityHash: () => 'corpus-expansion-v1',
          readAuthoritativeFreshness: async () => ({ kind: 'stale', reason: 'artifact-missing' }),
          apply: async () => {},
        },
        {
          id: 'stateless',
          kind: 'stateless',
          registrationKind: 'stateless',
        },
      ];

      for (const reg of valid) {
        const handle = driver.register(reg);
        expect(handle.id).toBe(reg.id);
        expect(handle.registrationKind).toBe(reg.registrationKind);
      }
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('runtime: rejects an untyped corpus registration without authoritative freshness', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      expect(() =>
        driver.register({
          id: 'corpus-without-authoritative-freshness',
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'both',
          projectionIdentityHash: () => 'corpus-projection-v1',
          apply: async () => {},
        } as unknown as ConsumerRegistration),
      ).toThrow(/must supply readAuthoritativeFreshness/);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });
});
