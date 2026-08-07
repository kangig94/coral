import { describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { commit, commitWithinOpenTransaction, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { applyTestCounterSchema, testCounterRegistry } from '#tests/unit/store/fixtures/test-counter-registry.js';

/**
 * `commitWithinOpenTransaction` is `commit`'s body without its own `BEGIN IMMEDIATE`/`COMMIT` — the seam
 * `applyProviderEventAtSeq`'s real store port (jobs/coordinator) needs to advance a runtime-meta watermark
 * atomically with whichever domain effect it applies. These tests prove the property that split exists for:
 * multiple calls compose into one caller-opened transaction rather than each opening (or silently skipping)
 * its own.
 */

function setupDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  applyTestCounterSchema(db);
  return db;
}

function testAppendContext(): AppendContext {
  return {
    now: () => new Date(0),
    reducers: composeReducers(testCounterRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  };
}

describe('commitWithinOpenTransaction', () => {
  it('appends and reduces exactly like commit when the caller already holds a transaction', () => {
    const db = setupDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      commitWithinOpenTransaction(
        db,
        (c) => {
          c.append({ type: 'test.counter.ticked', stream: { kind: 'job', id: 'a' }, body: { id: 'a', delta: 5 } });
          return undefined;
        },
        testAppendContext(),
      );
      db.exec('COMMIT');

      const row = db.prepare('SELECT count FROM projection_test_counter WHERE id = ?').get('a') as
        | { count: number }
        | undefined;
      expect(row?.count).toBe(5);
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('composes two calls into one caller-opened transaction: a rollback discards both', () => {
    const db = setupDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      // If either call opened (or silently required) its own transaction, this would throw on the second
      // `BEGIN` that `commit` itself would have issued — reaching the manual `ROLLBACK` below proves neither
      // did.
      commitWithinOpenTransaction(
        db,
        (c) => {
          c.append({ type: 'test.counter.ticked', stream: { kind: 'job', id: 'a' }, body: { id: 'a', delta: 3 } });
          return undefined;
        },
        testAppendContext(),
      );
      commitWithinOpenTransaction(
        db,
        (c) => {
          c.append({ type: 'test.counter.ticked', stream: { kind: 'job', id: 'b' }, body: { id: 'b', delta: 9 } });
          return undefined;
        },
        testAppendContext(),
      );
      db.exec('ROLLBACK');

      expect(db.prepare('SELECT count FROM projection_test_counter WHERE id = ?').get('a')).toBeUndefined();
      expect(db.prepare('SELECT count FROM projection_test_counter WHERE id = ?').get('b')).toBeUndefined();
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rolls both calls back together when a later reducer throws, matching commit’s own atomicity', () => {
    const db = setupDb();
    try {
      db.exec('BEGIN IMMEDIATE');
      commitWithinOpenTransaction(
        db,
        (c) => {
          c.append({ type: 'test.counter.ticked', stream: { kind: 'job', id: 'a' }, body: { id: 'a', delta: 3 } });
          return undefined;
        },
        testAppendContext(),
      );
      expect(() =>
        commitWithinOpenTransaction(
          db,
          (c) => {
            // Fails the body schema (`delta` must be an int), so `prepareInput` throws before any INSERT.
            c.append({
              type: 'test.counter.ticked',
              stream: { kind: 'job', id: 'b' },
              body: { id: 'b', delta: 'not-a-number' },
            } as never);
            return undefined;
          },
          testAppendContext(),
        ),
      ).toThrow();
      db.exec('ROLLBACK');

      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('leaves commit itself unchanged: still one self-contained transaction per call', () => {
    const db = setupDb();
    try {
      commit(
        db,
        (c) => {
          c.append({ type: 'test.counter.ticked', stream: { kind: 'job', id: 'a' }, body: { id: 'a', delta: 5 } });
          return undefined;
        },
        testAppendContext(),
      );

      const row = db.prepare('SELECT count FROM projection_test_counter WHERE id = ?').get('a') as
        | { count: number }
        | undefined;
      expect(row?.count).toBe(5);
    } finally {
      db.close();
    }
  });
});
