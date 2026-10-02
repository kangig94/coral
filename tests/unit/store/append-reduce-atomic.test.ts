import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers, defineDomainEvent } from '#src/store/reducers.js';
import { applyTestCounterSchema, TEST_COUNTER_SCHEMA } from '#tests/unit/store/fixtures/test-counter-registry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

function setupDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  applyTestCounterSchema(db);
  return db;
}

describe('commitInputs + in-transaction projection reduction', () => {
  it('reducer throw rolls back both event and projection row', () => {
    const db = setupDb();

    try {
      const throwingReducers = composeReducers({
        streamKind: 'job',
        entries: [
          defineDomainEvent({
            type: 'test.counter.ticked',
            schema: TEST_COUNTER_SCHEMA,
            reducer: () => {
              throw new Error('reducer failure');
            },
            materializerContract: 'projection_test_counter:throw-for-atomic-rollback-test',
          }),
        ],
      });

      expect(() =>
        commitInputs(
          db,
          [
            {
              type: 'test.counter.ticked',
              stream: { kind: 'job', id: 'a' },
              body: { id: 'a', delta: 5 },
            },
          ],
          {
            now: () => new Date(0),
            reducers: throwingReducers,
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow(/reducer failure/);

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projection_test_counter').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});
