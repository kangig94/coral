import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { openStoreDatabase } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { ensureRetentionIndexes, retentionIndexStatements } from '#src/store/retention-indexes.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { vacuumRetainedJournal } from '#src/store/retention-vacuum.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { joinSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';

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
  it('keeps NONE mode, exposes reusable pages and reuses them without conversion', async () => {
    const f = fixture();
    f.db.exec('PRAGMA auto_vacuum=NONE; VACUUM');
    freePages(f);
    const path = join(f.baseDir, 'store.db');
    const before = statSync(path).size;
    const free = f.db.prepare('PRAGMA freelist_count').get();
    expect(await vacuumRetainedJournal(f.db, f.budget)).toEqual({
      kind: 'kept',
      subject: 'journal-vacuum',
      reason: 'free-pages-reusable-until-next-epoch',
      pending: false,
    });
    expect(f.db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
    expect(f.db.prepare('PRAGMA freelist_count').get()).toEqual(free);
    f.db.exec('INSERT INTO vacuum_fixture VALUES (zeroblob(65536))');
    expect(statSync(path).size).toBe(before);
    expect(f.db.prepare('PRAGMA freelist_count').get()).not.toEqual(free);
  });

  it('shrinks incremental journals in yielding small chunks', async () => {
    const f = fixture();
    freePages(f);
    const exec = vi.spyOn(f.db, 'exec');
    const before = f.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    expect(await vacuumRetainedJournal(f.db, f.budget)).toEqual({
      kind: 'deleted',
      subject: 'journal-vacuum',
      count: before.freelist_count,
    });
    expect(f.db.prepare('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 });
    expect(exec.mock.calls.filter(([sql]) => sql.includes('vacuum'))).toEqual(
      expect.arrayContaining([['PRAGMA incremental_vacuum(32)']]),
    );
    expect(exec.mock.calls.some(([sql]) => /wal_checkpoint|^VACUUM/u.test(sql))).toBe(false);
  });

  it('installs missing maintenance indexes on a compatible NONE-mode store without conversion', () => {
    const f = fixture();
    f.db.exec('PRAGMA auto_vacuum=NONE; VACUUM');
    for (const sql of retentionIndexStatements) {
      const name = sql.split(' ')[5];
      f.db.exec(`DROP INDEX ${name}`);
    }
    const db = openStoreDatabase({
      path: join(f.baseDir, 'store.db'),
      storage: f.runtime.storage,
      storeFormat: currentCoralStoreFormat(),
    });
    try {
      expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'events_retention_%'").all(),
      ).toHaveLength(retentionIndexStatements.length);
      ensureRetentionIndexes(db);
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally {
      db.close();
    }
  });

  it('caps retention writer contention, preserves its cursor and retries after the writer releases', async () => {
    const f = fixture();
    f.setNow(1);
    initTestJob(f.store, {
      jobId: 'contended',
      sessionId: 'session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test-ns',
    });
    const seq = f.store.appendProgress('contended', 'session', 'message');
    commitJobTerminal(f.store, 'contended', 'session', {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    const other = newRawDatabase(join(f.baseDir, 'store.db'));
    const run = () =>
      pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: f.runtime.time.now() + 1, afterSeq: 0, budget: f.budget });
    try {
      other.exec('BEGIN IMMEDIATE');
      f.db.exec('PRAGMA busy_timeout = 120');
      const control = performance.now();
      expect(() => f.db.exec('BEGIN IMMEDIATE')).toThrow(/locked/u);
      expect(performance.now() - control).toBeGreaterThan(80);
      f.db.exec('PRAGMA busy_timeout = 5000');
      const started = performance.now();
      expect(await run()).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
      expect(f.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(f.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 1000 });
      expect(f.outcomes).toContainEqual({ kind: 'kept', subject: 'progress:contended', reason: 'scan-pending' });
      other.exec('ROLLBACK');
      expect(await run()).toBe(0);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeUndefined();
    } finally {
      other.close();
    }
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
