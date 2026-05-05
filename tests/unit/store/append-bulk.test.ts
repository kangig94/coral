import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers, defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';
import {
  applyTestCounterSchema,
  TEST_COUNTER_SCHEMA,
  testCounterRegistry,
} from '#tests/unit/store/fixtures/test-counter-registry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

function setupDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  applyTestCounterSchema(db);
  return db;
}

describe('commitInputs bulk', () => {
  it('appends 10000 events in one transaction with monotonic seq', () => {
    const db = setupDb();

    try {
      const assigned = commitInputs(
        db,
        Array.from({ length: 10000 }, () => ({
          type: 'test.counter.ticked' as const,
          stream: { kind: 'job' as const, id: 'bulk' },
          bodyVersion: 1,
          body: { id: 'bulk', delta: 1 },
        })),
        {
          now: () => new Date(0),
          reducers: composeReducers(testCounterRegistry),
          upcasters: createDefaultUpcasterRegistry(),
          providers: permissiveProviderLookupPort,
        },
      );

      expect(assigned).toHaveLength(10000);
      expect(assigned[0]?.seq).toBe(1);
      expect(assigned[9999]?.seq).toBe(10000);

      for (let index = 1; index < assigned.length; index++) {
        expect(assigned[index]?.seq).toBe((assigned[index - 1]?.seq ?? 0) + 1);
      }

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(10000);
    } finally {
      db.close();
    }
  });

  it('mid-batch reducer throw rolls back all events and projection rows', () => {
    const db = setupDb();

    try {
      let callCount = 0;
      const throwingRegistry: DomainEventRegistry = {
        streamKind: 'job',
        entries: [
          defineDomainEvent({
            type: 'test.counter.ticked',
            schema: TEST_COUNTER_SCHEMA,
            reducer: (reducerDb, event) => {
              reducerDb
                .prepare(
                  `INSERT INTO projection_test_counter (id, count, last_seq) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, last_seq = excluded.last_seq`,
                )
                .run(event.body.id, event.body.delta, event.seq);

              callCount += 1;
              if (callCount === 5000) {
                throw new Error('induced failure at event 5000');
              }
            },
          }),
        ],
      };

      expect(() =>
        commitInputs(
          db,
          Array.from({ length: 10000 }, () => ({
            type: 'test.counter.ticked' as const,
            stream: { kind: 'job' as const, id: 'rollback' },
            bodyVersion: 1,
            body: { id: 'rollback', delta: 1 },
          })),
          {
            now: () => new Date(0),
            reducers: composeReducers(throwingRegistry),
            upcasters: createDefaultUpcasterRegistry(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow(/induced failure/);

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projection_test_counter').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});
