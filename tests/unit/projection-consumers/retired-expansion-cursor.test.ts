import { afterEach, describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { ConsumerCursorRepository } from '#src/projection-consumers/persistence.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const openDatabases: Database[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
});

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  openDatabases.push(db);
  return db;
}

function insertJournalCursor(db: Database, id: string, registrationKind: 'base' | 'expansion' | string): void {
  db.prepare(
    `INSERT INTO consumer_cursors
       (consumer_id, authority, cursor, registered_at, registration_kind)
     VALUES (?, 'journal', 0, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, registrationKind);
}

function cursorCount(db: Database, id: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM consumer_cursors WHERE consumer_id = ?').get(id) as {
      count: number;
    }
  ).count;
}

describe('retired expansion cursor cleanup', () => {
  it('classifies missing and expansion-owned rows and conditionally deletes only the latter', () => {
    const db = createDb();
    const repository = new ConsumerCursorRepository(db, realConsumerDriverNow);

    const missing = repository.preflightRetiredExpansionCursor('missing');
    expect(missing).toEqual({ status: 'missing' });
    repository.deletePreflightedRetiredExpansionCursor('missing', missing);

    insertJournalCursor(db, 'vector-fixture', 'expansion');
    const owned = repository.preflightRetiredExpansionCursor('vector-fixture');
    expect(owned).toEqual({ status: 'expansion-owned' });
    repository.deletePreflightedRetiredExpansionCursor('vector-fixture', owned);
    expect(cursorCount(db, 'vector-fixture')).toBe(0);
  });

  it.each([
    ['base', 'base'],
    ['malformed', 'other'],
  ] as const)('fails closed for %s cursor ownership', (_label, registrationKind) => {
    const db = createDb();
    const repository = new ConsumerCursorRepository(db, realConsumerDriverNow);
    insertJournalCursor(db, 'vector-fixture', registrationKind);

    expect(() => repository.preflightRetiredExpansionCursor('vector-fixture')).toThrow();
    expect(cursorCount(db, 'vector-fixture')).toBe(1);
  });

  it('fails closed when ownership changes after preflight', () => {
    const db = createDb();
    const repository = new ConsumerCursorRepository(db, realConsumerDriverNow);
    insertJournalCursor(db, 'vector-fixture', 'expansion');
    const preflight = repository.preflightRetiredExpansionCursor('vector-fixture');
    db.prepare("UPDATE consumer_cursors SET registration_kind = 'base' WHERE consumer_id = ?").run('vector-fixture');

    expect(() => repository.deletePreflightedRetiredExpansionCursor('vector-fixture', preflight)).toThrow(
      /ownership changed/u,
    );
    expect(cursorCount(db, 'vector-fixture')).toBe(1);
  });

  it('fails closed when a cursor appears after a missing-row preflight', () => {
    const db = createDb();
    const repository = new ConsumerCursorRepository(db, realConsumerDriverNow);
    const preflight = repository.preflightRetiredExpansionCursor('vector-fixture');
    insertJournalCursor(db, 'vector-fixture', 'expansion');

    expect(() => repository.deletePreflightedRetiredExpansionCursor('vector-fixture', preflight)).toThrow(
      /appeared during retirement/u,
    );
    expect(cursorCount(db, 'vector-fixture')).toBe(1);
  });

  it('rejects an active same-id consumer and fences registration until release', () => {
    const db = createDb();
    const driver = new ConsumerDriver({
      db,
      time: REAL_CONSUMER_DRIVER_TIMERS,
      now: realConsumerDriverNow,
    });
    driver.register({
      id: 'active-vector',
      authority: 'journal',
      kind: 'apply',
      registrationKind: 'expansion',
      async apply() {},
    });

    expect(() => driver.beginRetiredExpansionCursorCleanup('active-vector')).toThrow(/active/u);

    const lease = driver.beginRetiredExpansionCursorCleanup('rowless-vector');
    expect(() =>
      driver.register({
        id: 'rowless-vector',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply() {},
      }),
    ).toThrow(/being retired/u);
    lease.release();
    expect(
      driver.register({
        id: 'rowless-vector',
        authority: 'journal',
        kind: 'apply',
        registrationKind: 'expansion',
        async apply() {},
      }).id,
    ).toBe('rowless-vector');
  });
});
