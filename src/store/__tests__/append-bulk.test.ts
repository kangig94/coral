import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { appendEvents } from '../append.js';
import { createEmptyRegistry } from '../envelope.js';
import { applyMigrations } from '../migrations.js';
import type { DomainEventRegistry, Reducer } from '../reducers.js';
import { composeReducers } from '../reducers.js';
import { applyTestCounterMigration, TEST_COUNTER_SCHEMA, testCounterRegistry } from './fixtures/test-counter-registry.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

const storageAdapter: Pick<StoragePort, 'readdirSync' | 'readFileSync'> = {
  readdirSync: (path, options) => fs.readdirSync(path, options),
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
};

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: storageAdapter, migrationsDir: MIGRATIONS_DIR });
  applyTestCounterMigration(db);
  return db;
}

describe('appendEvents bulk', () => {
  it('appends 10000 events in one transaction with monotonic seq', () => {
    const db = setupDb();

    try {
      const assigned = appendEvents(
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
          upcasters: createEmptyRegistry(),
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
      const throwingReducer: Reducer<{ id: string; delta: number }> = (reducerDb, event) => {
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
      };

      const throwingRegistry: DomainEventRegistry = {
        types: ['test.counter.ticked'],
        reducers: {
          'test.counter.ticked': throwingReducer as Reducer<unknown>,
        },
        schemas: { 'test.counter.ticked': TEST_COUNTER_SCHEMA },
      };

      expect(() =>
        appendEvents(
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
            upcasters: createEmptyRegistry(),
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
