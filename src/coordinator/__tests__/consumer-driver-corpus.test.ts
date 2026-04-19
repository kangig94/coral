import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '../../runtime/ports.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { applyMigrations } from '../../store/migrations.js';
import { ConsumerDriver, type CorpusConsumerRegistration, type JournalConsumerRegistration } from '../consumer-driver.js';

const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  applyMigrations({ db, storage: nodeStorage });
  return db;
}

function readCursorRow(db: InstanceType<typeof Database>, consumerId: string) {
  return db
    .prepare('SELECT consumer_id, authority, lane, cursor, equipped_at FROM equipment_cursors WHERE consumer_id = ?')
    .get(consumerId) as {
    consumer_id: string;
    authority: string;
    lane: string | null;
    cursor: number;
    equipped_at: string;
  };
}

describe('ConsumerDriver corpus registrations', () => {
  it('rejects missing lane on corpus consumers', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const reg = {
      id: 'corpus-missing-lane',
      authority: 'corpus',
      async apply() {},
    } as unknown as CorpusConsumerRegistration;

    try {
      expect(() => driver.register(reg)).toThrow(CoralSetupError);
      expect(() => driver.register(reg)).toThrow(/must declare a valid lane/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('stores the declared corpus lane and advances only the matching consumer cursor', async () => {
    const db = createDb();
    const driver = new ConsumerDriver({
      db,
      now: () => new Date('2026-04-19T01:02:03.000Z'),
    });
    const calls: Array<{ id: string; contentSeq: number; metadataSeq: number }> = [];
    const contentConsumer: CorpusConsumerRegistration = {
      id: 'corpus-content',
      authority: 'corpus',
      lane: 'content',
      async apply({ contentSeq, metadataSeq }) {
        calls.push({ id: 'content', contentSeq, metadataSeq });
      },
    };
    const metadataConsumer: CorpusConsumerRegistration = {
      id: 'corpus-metadata',
      authority: 'corpus',
      lane: 'metadata',
      async apply({ contentSeq, metadataSeq }) {
        calls.push({ id: 'metadata', contentSeq, metadataSeq });
      },
    };

    try {
      driver.register(contentConsumer);
      driver.register(metadataConsumer);

      expect(readCursorRow(db, contentConsumer.id)).toMatchObject({
        consumer_id: contentConsumer.id,
        authority: 'corpus',
        lane: 'content',
        cursor: 0,
      });
      expect(readCursorRow(db, metadataConsumer.id)).toMatchObject({
        consumer_id: metadataConsumer.id,
        authority: 'corpus',
        lane: 'metadata',
        cursor: 0,
      });

      driver.notify('corpus', { contentSeq: 4, metadataSeq: 0 }, 'content');
      await driver.drainAll();

      expect(calls).toEqual([{ id: 'content', contentSeq: 4, metadataSeq: 0 }]);
      expect(readCursorRow(db, contentConsumer.id).cursor).toBe(4);
      expect(readCursorRow(db, metadataConsumer.id).cursor).toBe(0);

      driver.notify('corpus', { contentSeq: 4, metadataSeq: 7 }, 'metadata');
      await driver.drainAll();

      expect(calls).toEqual([
        { id: 'content', contentSeq: 4, metadataSeq: 0 },
        { id: 'metadata', contentSeq: 4, metadataSeq: 7 },
      ]);
      expect(readCursorRow(db, contentConsumer.id).cursor).toBe(4);
      expect(readCursorRow(db, metadataConsumer.id).cursor).toBe(7);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('rejects lane on journal consumers', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    const reg = {
      id: 'journal-with-lane',
      authority: 'journal',
      lane: 'content',
      async apply() {},
    } as unknown as JournalConsumerRegistration;

    try {
      expect(() => driver.register(reg)).toThrow(CoralSetupError);
      expect(() => driver.register(reg)).toThrow(/must not declare a corpus lane/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('rejects stored lane mismatches for corpus consumers', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db });
    db.prepare('INSERT INTO equipment_cursors (consumer_id, authority, lane, cursor, equipped_at) VALUES (?, ?, ?, 0, ?)')
      .run('corpus-proj', 'corpus', 'metadata', '2026-04-19T00:00:00.000Z');

    try {
      expect(() =>
        driver.register({
          id: 'corpus-proj',
          authority: 'corpus',
          lane: 'content',
          async apply() {},
        }),
      ).toThrow(CoralSetupError);
      expect(() =>
        driver.register({
          id: 'corpus-proj',
          authority: 'corpus',
          lane: 'content',
          async apply() {},
        }),
      ).toThrow(/conflicting corpus lane/i);
    } finally {
      void driver.shutdown();
      db.close();
    }
  });
});
