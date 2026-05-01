import * as fs from 'node:fs';
import { join } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers, defineDomainEvent, type DomainEventRegistry } from '#src/store/reducers.js';
import {
  applyTestCounterSchema,
  TEST_COUNTER_SCHEMA,
  testCounterRegistry,
} from '#tests/unit/store/fixtures/test-counter-registry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');

const storageAdapter: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'readFileSync'> = {
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync as StoragePort['readdirSync'],
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
};

function setupDb(): Database {
  const db = newRawDatabase(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter, schemasDir: SCHEMAS_DIR });
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
            bodyVersion: 1,
            body: { id: 'a', delta: 5 },
          },
        ],
        {
          now: () => new Date(0),
          reducers: composeReducers(testCounterRegistry),
          upcasters: createDefaultUpcasterRegistry(),
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
              bodyVersion: 1,
              body: { id: 'a', delta: 5 },
            },
          ],
          {
            now: () => new Date(0),
            reducers: throwingReducers,
            upcasters: createDefaultUpcasterRegistry(),
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
          }),
        ],
        appendValidators: [
          () => {
            throw new Error('append validator failure');
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
              bodyVersion: 1,
              body: { id: 'a', delta: 5 },
            },
          ],
          {
            now: () => new Date(0),
            reducers: composeReducers(registry),
            upcasters: createDefaultUpcasterRegistry(),
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

  it('keeps the store substrate domain-free when no registry validator is composed', () => {
    const db = setupDb();

    try {
      commitInputs(
        db,
        [
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'domain-free' },
            bodyVersion: 1,
            body: { intentionally: 'not a job terminal body' },
          },
          {
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: 'domain-free' },
            bodyVersion: 1,
            body: { intentionally: 'not a job progress body' },
          },
        ],
        {
          now: () => new Date(0),
          reducers: composeReducers(),
          upcasters: createDefaultUpcasterRegistry(),
          providers: permissiveProviderLookupPort,
        },
      );

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
  });
});
