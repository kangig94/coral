import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { appendEvents } from '../append.js';
import { createEmptyRegistry } from '../envelope.js';
import { applyMigrations } from '../migrations.js';
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

describe('appendEvents + in-transaction projection reduction', () => {
  it('writes projection row and event atomically', () => {
    const db = setupDb();

    try {
      appendEvents(
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
          upcasters: createEmptyRegistry(),
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
        types: ['test.counter.ticked'],
        reducers: {
          'test.counter.ticked': () => {
            throw new Error('reducer failure');
          },
        },
        schemas: { 'test.counter.ticked': TEST_COUNTER_SCHEMA },
      });

      expect(() =>
        appendEvents(
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
            upcasters: createEmptyRegistry(),
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
