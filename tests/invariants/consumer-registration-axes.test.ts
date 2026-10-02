import { currentCoralStoreFormat } from '#src/store-format.js';
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
