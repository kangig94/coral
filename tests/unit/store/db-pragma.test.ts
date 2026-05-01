import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyJournalPragmas } from '#src/store/db.js';

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
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writable mode sets WAL + synchronous=FULL + foreign_keys', () => {
    const db = new Database(join(workDir, 'writable.db'));
    try {
      applyJournalPragmas(db, { kind: 'writable' });

      // better-sqlite3 with simple:true returns 2 for FULL, 1 for NORMAL
      expect(db.pragma('synchronous', { simple: true })).toBe(2);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rebuild mode sets WAL + synchronous=NORMAL (test/regression utility only)', () => {
    const db = new Database(join(workDir, 'rebuild.db'));
    try {
      applyJournalPragmas(db, { kind: 'rebuild' });

      expect(db.pragma('synchronous', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('readonly mode only sets foreign_keys + busy_timeout (no journal/synchronous writes)', () => {
    // Apply readonly to a writable handle so we can directly observe that the
    // helper never writes journal_mode or synchronous in that branch — a real
    // readonly handle would refuse those pragmas with an error.
    const db = new Database(join(workDir, 'readonly.db'));
    try {
      const before = {
        synchronous: db.pragma('synchronous', { simple: true }),
        journalMode: db.pragma('journal_mode', { simple: true }),
      };

      applyJournalPragmas(db, { kind: 'readonly' });

      expect(db.pragma('synchronous', { simple: true })).toBe(before.synchronous);
      expect(db.pragma('journal_mode', { simple: true })).toBe(before.journalMode);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('busyTimeoutMs override is honored', () => {
    const db = new Database(':memory:');
    try {
      applyJournalPragmas(db, { kind: 'writable', busyTimeoutMs: 12345 });
      expect(db.pragma('busy_timeout', { simple: true })).toBe(12345);
    } finally {
      db.close();
    }
  });

  it('busyTimeoutMs defaults to 5000 when omitted', () => {
    const db = new Database(':memory:');
    try {
      applyJournalPragmas(db, { kind: 'writable' });
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });
});
