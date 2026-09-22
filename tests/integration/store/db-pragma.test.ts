import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newRawDatabase, pragmaSimple } from '#tests/helpers/test-db.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { applyJournalPragmas, openWritableStoreDatabase } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

/**
 * Pin the journal pragma contract from spec §3.
 *
 * Writable handles MUST run with `synchronous=FULL` so a successful commit
 * means the durable bytes have been fsync'd to disk. `applyJournalPragmas` is
 * the single configuration site; this test pins its surface.
 */
describe('applyJournalPragmas', () => {
  let workDir: string;

  beforeEach(() => {
    // SQLite refuses WAL journal_mode on `:memory:` databases (pragma silently
    // becomes `memory`), so journal_mode assertions need a real file path.
    workDir = mkdtempSync(join(tmpdir(), 'coral-pragma-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writable mode sets WAL + synchronous=FULL + foreign_keys', () => {
    const db = newRawDatabase(join(workDir, 'writable.db'));
    try {
      applyJournalPragmas(db, { kind: 'writable' });

      // better-sqlite3 with simple:true returns 2 for FULL, 1 for NORMAL
      expect(pragmaSimple(db, 'synchronous')).toBe(2);
      expect(pragmaSimple(db, 'journal_mode')).toBe('wal');
      expect(pragmaSimple(db, 'foreign_keys')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rebuild mode sets WAL + synchronous=NORMAL (test/regression utility only)', () => {
    const db = newRawDatabase(join(workDir, 'rebuild.db'));
    try {
      applyJournalPragmas(db, { kind: 'rebuild' });

      expect(pragmaSimple(db, 'synchronous')).toBe(1);
      expect(pragmaSimple(db, 'journal_mode')).toBe('wal');
      expect(pragmaSimple(db, 'foreign_keys')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('readonly mode only sets foreign_keys + busy_timeout (no journal/synchronous writes)', () => {
    // Apply readonly to a writable handle so we can directly observe that the
    // helper never writes journal_mode or synchronous in that branch — a real
    // readonly handle would refuse those pragmas with an error.
    const db = newRawDatabase(join(workDir, 'readonly.db'));
    try {
      const before = {
        synchronous: pragmaSimple(db, 'synchronous'),
        journalMode: pragmaSimple(db, 'journal_mode'),
      };

      applyJournalPragmas(db, { kind: 'readonly' });

      expect(pragmaSimple(db, 'synchronous')).toBe(before.synchronous);
      expect(pragmaSimple(db, 'journal_mode')).toBe(before.journalMode);
      expect(pragmaSimple(db, 'foreign_keys')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('busyTimeoutMs override is honored', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyJournalPragmas(db, { kind: 'writable', busyTimeoutMs: 12345 });
      expect(pragmaSimple(db, 'busy_timeout')).toBe(12345);
    } finally {
      db.close();
    }
  });

  it('busyTimeoutMs defaults to 5000 when omitted', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyJournalPragmas(db, { kind: 'writable' });
      expect(pragmaSimple(db, 'busy_timeout')).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('does not add a pre-classification busy timeout when the caller omits one', () => {
    const operations: Array<{ kind: 'exec' | 'prepare'; sql: string }> = [];
    const exec = DatabaseSync.prototype.exec;
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      operations.push({ kind: 'exec', sql });
      return exec.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      operations.push({ kind: 'prepare', sql });
      return prepare.call(this, sql);
    });
    const runtime = createRealRuntime('prod', { baseDir: workDir });

    const opened = openWritableStoreDatabase({
      path: join(workDir, 'no-preclassification-timeout.db'),
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
    });

    expect(opened.kind).toBe('opened');
    if (opened.kind === 'opened') opened.db.close();
    const firstClassificationRead = operations.findIndex(({ kind }) => kind === 'prepare');
    expect(firstClassificationRead).toBeGreaterThanOrEqual(0);
    expect(operations.slice(0, firstClassificationRead)).not.toContainEqual({
      kind: 'exec',
      sql: expect.stringContaining('busy_timeout'),
    });

    operations.length = 0;
    const openedWithTimeout = openWritableStoreDatabase({
      path: join(workDir, 'preclassification-timeout.db'),
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
      busyTimeoutMs: 1_234,
    });

    expect(openedWithTimeout.kind).toBe('opened');
    if (openedWithTimeout.kind === 'opened') openedWithTimeout.db.close();
    const firstTimedClassificationRead = operations.findIndex(({ kind }) => kind === 'prepare');
    expect(firstTimedClassificationRead).toBeGreaterThanOrEqual(0);
    expect(operations.slice(0, firstTimedClassificationRead)).toContainEqual({
      kind: 'exec',
      sql: 'PRAGMA busy_timeout = 1234',
    });
  });

  it('refreshes the remaining deadline before every writable-open database operation', () => {
    const operations: Array<{ kind: 'exec' | 'prepare'; sql: string }> = [];
    const exec = DatabaseSync.prototype.exec;
    const prepare = DatabaseSync.prototype.prepare;
    let now = 0;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      operations.push({ kind: 'exec', sql });
      const result = exec.call(this, sql);
      if (!sql.startsWith('PRAGMA busy_timeout')) now += 100;
      return result;
    });
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      operations.push({ kind: 'prepare', sql });
      const result = prepare.call(this, sql);
      now += 100;
      return result;
    });
    const runtime = createRealRuntime('prod', { baseDir: workDir });

    const opened = openWritableStoreDatabase({
      path: join(workDir, 'deadline-refresh.db'),
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
      busyTimeoutDeadline: {
        expiresAt: 2_000n,
        monotonicNow: () => BigInt(now),
      },
    });

    expect(opened.kind).toBe('opened');
    if (opened.kind === 'opened') opened.db.close();
    for (const [index, operation] of operations.entries()) {
      if (operation.kind === 'exec' && operation.sql.startsWith('PRAGMA busy_timeout')) continue;
      expect(operations[index - 1]).toMatchObject({
        kind: 'exec',
        sql: expect.stringMatching(/^PRAGMA busy_timeout = \d+$/u),
      });
    }
    const timeouts = operations
      .filter(({ kind, sql }) => kind === 'exec' && sql.startsWith('PRAGMA busy_timeout'))
      .map(({ sql }) => Number(sql.slice(sql.lastIndexOf(' ') + 1)));
    expect(timeouts[0]).toBe(2_000);
    expect(timeouts.at(-1)).toBeLessThan(timeouts[0] ?? 0);
  });
});
