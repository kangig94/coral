import { afterEach, describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { vacuumRetainedJournal } from '#src/store/retention-vacuum.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { joinSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { convertRetentionJournalAtStartup } from '#src/store/retention-startup.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture(true);
  fixtures.push(f);
  return f;
}
function freePages(f: ReturnType<typeof fixture>) {
  f.db.exec('CREATE TABLE IF NOT EXISTS vacuum_fixture (data BLOB)');
  const stmt = f.db.prepare('INSERT INTO vacuum_fixture VALUES (?)');
  for (let i = 0; i < 32; i += 1) stmt.run(Buffer.alloc(64 * 1024));
  f.db.exec('DELETE FROM vacuum_fixture');
}

describe('retention vacuum', () => {
  it('creates new epochs in incremental mode before their schema', () => {
    const f = fixture();
    const db = openSettledTestStoreDb(f.runtime);
    try {
      expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    } finally {
      db.close();
    }
  });
  it('shrinks an existing auto_vacuum=NONE journal and converts it for incremental reclamation', async () => {
    const f = fixture();
    f.db.exec('PRAGMA auto_vacuum=NONE; VACUUM');
    freePages(f);
    const before = statSync(join(f.baseDir, 'store.db')).size;
    expect(
      await convertRetentionJournalAtStartup({
        runtime: f.runtime,
        db: f.db,
        path: join(f.baseDir, 'store.db'),
        writer: { beginWriteTurn: () => () => {}, assertCurrent: () => {} },
        signal: new AbortController().signal,
      }),
    ).toEqual(expect.objectContaining({ kind: 'deleted', count: expect.any(Number) }));
    expect(statSync(join(f.baseDir, 'store.db')).size).toBeLessThan(before);
    expect(f.db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    freePages(f);
    expect((await vacuumRetainedJournal(f.db, f.budget)).kind).toBe('deleted');
  });

  it('converts journals beyond the former 320 MiB refusal', async () => {
    const f = fixture();
    f.db.exec(
      'PRAGMA auto_vacuum=NONE; VACUUM; CREATE TABLE oversize(data BLOB); INSERT INTO oversize VALUES(zeroblob(337000000)); DROP TABLE oversize',
    );
    expect(statSync(join(f.baseDir, 'store.db')).size).toBeGreaterThan(320 * 1024 * 1024);
    expect(
      (
        await convertRetentionJournalAtStartup({
          runtime: f.runtime,
          db: f.db,
          path: join(f.baseDir, 'store.db'),
          writer: { beginWriteTurn: () => () => {}, assertCurrent: () => {} },
          signal: new AbortController().signal,
        })
      ).kind,
    ).toBe('deleted');
    expect(f.db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(statSync(join(f.baseDir, 'store.db')).size).toBeLessThan(1024 * 1024);
  });

  it('kills a timed-out startup helper, leaves a readable store and retries next boot', async () => {
    const f = fixture();
    f.db.exec('PRAGMA auto_vacuum=NONE; VACUUM');
    const runtime = {
      ...f.runtime,
      time: { ...f.runtime.time, setTimeout: (callback: () => void) => f.runtime.time.setTimeout(callback, 0) },
    };
    const run = () =>
      convertRetentionJournalAtStartup({
        runtime,
        db: f.db,
        path: join(f.baseDir, 'store.db'),
        writer: { beginWriteTurn: () => () => {}, assertCurrent: () => {} },
        signal: new AbortController().signal,
      });
    expect(await run()).toMatchObject({ kind: 'failed', reason: 'conversion-deadline; retry-next-boot' });
    expect(f.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(
      (
        await convertRetentionJournalAtStartup({
          runtime: f.runtime,
          db: f.db,
          path: join(f.baseDir, 'store.db'),
          writer: { beginWriteTurn: () => () => {}, assertCurrent: () => {} },
          signal: new AbortController().signal,
        })
      ).kind,
    ).toBe('deleted');
  });

  it('keeps active transactions and reports writer park without running vacuum', async () => {
    const f = fixture();
    freePages(f);
    f.db.exec('BEGIN IMMEDIATE');
    expect(await vacuumRetainedJournal(f.db, f.budget)).toEqual({
      kind: 'kept',
      subject: 'journal-vacuum',
      reason: 'writer-transaction-active',
    });
    f.db.exec('ROLLBACK');
    const parked = new Proxy(f.db, {
      get() {
        throw new Error('writer parked');
      },
    });
    expect(await vacuumRetainedJournal(parked, f.budget)).toEqual({
      kind: 'failed',
      subject: 'journal-vacuum',
      reason: 'writer parked',
    });
  });

  it('keeps a real fenced epoch unchanged after its succession writer parks', async () => {
    const f = fixture();
    const db = openSettledTestStoreDb(f.runtime);
    const writer = joinSuccessionWriterGeneration(f.runtime, {
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
    });
    freePages({ ...f, db });
    const path = join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db');
    writer.park();
    const before = statSync(path).size;
    expect(
      await vacuumRetainedJournal(db, {
        canContinue: () => {
          try {
            writer.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
      }),
    ).toEqual({ kind: 'kept', subject: 'journal-vacuum', reason: 'run-interrupted' });
    expect(statSync(path).size).toBe(before);
  });
});
