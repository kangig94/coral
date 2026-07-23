import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
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
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  applyTestCounterSchema(db);
  return db;
}

describe('commitInputs + in-transaction projection reduction', () => {
  it('writes projection row and event atomically', () => {
    const db = setupDb();

    try {
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
          reducers: composeReducers(testCounterRegistry),
          bodyCodec: createEventBodyCodec(),
          providers: permissiveProviderLookupPort,
        },
      );

      const rows = db.prepare('SELECT * FROM projection_test_counter WHERE id = ?').all('a') as {
        id: string;
        count: number;
        last_seq: number;
      }[];

      expect(rows).toHaveLength(1);
      expect(rows[0]?.count).toBe(5);
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

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

  it('append validator throw rolls back before event insert or reducer execution', () => {
    const db = setupDb();

    try {
      let reducerCalls = 0;
      const registry: DomainEventRegistry = {
        streamKind: 'job',
        entries: [
          defineDomainEvent({
            type: 'test.counter.ticked',
            schema: TEST_COUNTER_SCHEMA,
            reducer: (reducerDb, event) => {
              reducerCalls += 1;
              reducerDb
                .prepare(
                  `INSERT INTO projection_test_counter (id, count, last_seq) VALUES (?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET count = count + excluded.count, last_seq = excluded.last_seq`,
                )
                .run(event.body.id, event.body.delta, event.seq);
            },
            materializerContract: 'test:increment-projection-counter',
          }),
        ],
        appendValidators: [
          {
            contract: 'test:always-reject',
            validate: () => {
              throw new Error('append validator failure');
            },
          },
        ],
      };

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
            reducers: composeReducers(registry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow(/append validator failure/);

      expect(reducerCalls).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projection_test_counter').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects a registered event on the wrong stream kind atomically', () => {
    const db = setupDb();

    try {
      expect(() =>
        commitInputs(
          db,
          [
            {
              type: 'test.counter.ticked',
              stream: { kind: 'job', id: 'valid-first' },
              body: { id: 'valid-first', delta: 1 },
            },
            {
              type: 'test.counter.ticked',
              stream: { kind: 'session', id: 'wrong-kind' },
              body: { id: 'wrong-kind', delta: 1 },
            },
          ],
          {
            now: () => new Date(0),
            reducers: composeReducers(testCounterRegistry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'event_stream_kind_mismatch',
          context: expect.objectContaining({ expectedStreamKind: 'job', actualStreamKind: 'session' }),
        }),
      );

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projection_test_counter').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects event bodies when no registry codec is composed', () => {
    const db = setupDb();

    try {
      expect(() =>
        commitInputs(
          db,
          [
            {
              type: 'job.terminal.recorded',
              stream: { kind: 'job', id: 'closed-registry' },
              body: { intentionally: 'not a job terminal body' },
            },
          ],
          {
            now: () => new Date(0),
            reducers: composeReducers(),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow("No registered event body codec for type 'job.terminal.recorded'");
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects invalid current-codec bodies before inserting an event or projection', () => {
    const db = setupDb();

    try {
      expect(() =>
        commitInputs(
          db,
          [
            {
              type: 'test.counter.ticked',
              stream: { kind: 'job', id: 'invalid-current-body' },
              body: { id: 'invalid-current-body', delta: 'bad' },
            },
          ],
          {
            now: () => new Date(0),
            reducers: composeReducers(testCounterRegistry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrow('Expected number, received string');
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM projection_test_counter').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });
});
