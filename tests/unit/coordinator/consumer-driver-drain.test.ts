import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '#src/runtime/ports.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import type { JournalApplyContext, JournalConsumerRegistration } from '#src/store/consumer-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

interface CursorRow {
  consumer_id: string;
  authority: string;
  lane: string | null;
  cursor: number;
  registered_at: string;
}

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function createRegistration(
  id: string,
  apply: Extract<JournalConsumerRegistration, { kind: 'apply' }>['apply'],
): JournalConsumerRegistration {
  return {
    id,
    authority: 'journal',
    kind: 'apply',
    registrationKind: 'expansion',
    apply,
  };
}

function readCursorRow(db: InstanceType<typeof Database>, consumerId: string): CursorRow {
  return db
    .prepare('SELECT consumer_id, authority, lane, cursor, registered_at FROM consumer_cursors WHERE consumer_id = ?')
    .get(consumerId) as CursorRow;
}

describe('ConsumerDriver notify + drain + cursor', () => {
  it('register() populates consumer_cursors and re-registering journal is idempotent', () => {
    const db = createDb();
    const now = new Date('2026-04-18T10:11:12.345Z');
    const driver = new ConsumerDriver({ db, now: () => now });
    const reg = createRegistration('journal-consumer', async () => {});

    try {
      driver.register(reg);
      driver.register(reg);

      expect(readCursorRow(db, reg.id)).toEqual({
        consumer_id: reg.id,
        authority: 'journal',
        lane: null,
        cursor: 0,
        registered_at: now.toISOString(),
      });
      expect(
        (
          db.prepare('SELECT COUNT(*) AS count FROM consumer_cursors WHERE consumer_id = ?').get(reg.id) as {
            count: number;
          }
        ).count,
      ).toBe(1);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('notify(journal, N) triggers apply() exactly once, advances only cursor, and re-notifying the same target is idempotent', async () => {
    const db = createDb();
    const now = new Date('2026-04-18T10:11:12.345Z');
    const driver = new ConsumerDriver({ db, now: () => now });
    const calls: Pick<JournalApplyContext, 'fromSeq' | 'upToSeq'>[] = [];
    const reg = createRegistration('journal-consumer', async ({ fromSeq, upToSeq }) => {
      calls.push({ fromSeq, upToSeq });
    });

    try {
      driver.register(reg);

      driver.notify('journal', 5);
      await driver.drainAll();

      expect(calls).toEqual([{ fromSeq: 0, upToSeq: 5 }]);
      expect(readCursorRow(db, reg.id)).toEqual({
        consumer_id: reg.id,
        authority: 'journal',
        lane: null,
        cursor: 5,
        registered_at: now.toISOString(),
      });

      driver.notify('journal', 5);
      await driver.drainAll();

      expect(calls).toEqual([{ fromSeq: 0, upToSeq: 5 }]);
      expect(readCursorRow(db, reg.id)).toEqual({
        consumer_id: reg.id,
        authority: 'journal',
        lane: null,
        cursor: 5,
        registered_at: now.toISOString(),
      });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('coalesces concurrent notify() calls into one subsequent apply() at the latest target', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const firstApplyStarted = createDeferred<void>();
    const releaseFirstApply = createDeferred<void>();
    const calls: Pick<JournalApplyContext, 'fromSeq' | 'upToSeq'>[] = [];
    const reg = createRegistration('journal-consumer', async ({ fromSeq, upToSeq }) => {
      calls.push({ fromSeq, upToSeq });
      if (calls.length === 1) {
        firstApplyStarted.resolve();
        await releaseFirstApply.promise;
      }
    });

    try {
      driver.register(reg);

      driver.notify('journal', 5);
      await firstApplyStarted.promise;

      driver.notify('journal', 10);
      expect(calls).toEqual([{ fromSeq: 0, upToSeq: 5 }]);

      releaseFirstApply.resolve();
      await driver.drainAll();

      expect(calls).toEqual([
        { fromSeq: 0, upToSeq: 5 },
        { fromSeq: 5, upToSeq: 10 },
      ]);
      expect(readCursorRow(db, reg.id).cursor).toBe(10);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('throws CoralSetupError(consumer_authority_mismatch) when the stored authority conflicts on re-register', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const reg = createRegistration('same', async () => {});

    try {
      driver.register(reg);

      db.prepare('DELETE FROM consumer_cursors WHERE consumer_id = ?').run(reg.id);
      db.prepare(
        'INSERT INTO consumer_cursors (consumer_id, authority, lane, cursor, registered_at) VALUES (?, ?, ?, 0, ?)',
      ).run(reg.id, 'corpus', 'content', '2026-04-18T00:00:00.000Z');

      let thrown: unknown;
      try {
        driver.register(reg);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CoralSetupError);
      expect((thrown as CoralSetupError).code).toBe('consumer_authority_mismatch');
      expect((thrown as CoralSetupError).context).toMatchObject({
        id: reg.id,
        expected: 'journal',
        actual: 'corpus',
      });
    } finally {
      void driver.shutdown();
      db.close();
    }
  });
});
