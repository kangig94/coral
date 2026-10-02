import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeLegacyStore } from '#src/store/epoch/legacy-retention.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import type { Runtime } from '#src/runtime/ports.js';

const selection = vi.hoisted(() => ({ kind: 'valid' }));
vi.mock('#src/store/active-store-selection.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readActiveStoreSelectionForCoordination: () => ({ kind: selection.kind }),
}));
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
beforeEach(() => {
  selection.kind = 'valid';
});
function fixture(): ReturnType<typeof createRetentionFixture> & { runtime: Runtime; legacy: string } {
  const f = createRetentionFixture();
  fixtures.push(f);
  openSettledTestStoreDb(f.runtime).close();
  const legacy = join(f.runtime.paths.coral.store.dbDir, 'store.db');
  const db = newRawDatabase(legacy);
  db.exec('CREATE TABLE legacy_fixture (value TEXT)');
  db.close();
  for (const suffix of ['-wal', '-shm', '.format', '.bak', '.timestamp.bak']) writeFileSync(legacy + suffix, 'residue');
  const runtime = {
    ...f.runtime,
    storage: {
      ...f.runtime.storage,
      readDirectoryBoundedSync: ((...args: Parameters<Runtime['storage']['readDirectoryBoundedSync']>) =>
        args[0] === '/proc'
          ? { entries: [], overflow: false }
          : f.runtime.storage.readDirectoryBoundedSync(...args)) as Runtime['storage']['readDirectoryBoundedSync'],
    },
  };
  return { ...f, runtime, legacy };
}

describe('legacy store retention', () => {
  it('removes precisely the legacy store family under proven current selection and exclusive lock', () => {
    const f = fixture();
    const unrelated = join(f.runtime.paths.coral.store.dbDir, 'unrelated.bak');
    writeFileSync(unrelated, 'keep');
    expect(removeLegacyStore(f.runtime, () => true)).toEqual({ kind: 'deleted', subject: f.legacy, count: 6 });
    for (const suffix of ['', '-wal', '-shm', '.format', '.bak', '.timestamp.bak'])
      expect(existsSync(f.legacy + suffix)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'))).toBe(true);
  });

  it('keeps unknown selection, unproven epoch, interrupted work and unobservable holders', () => {
    const f = fixture();
    selection.kind = 'rejected';
    expect(removeLegacyStore(f.runtime, () => true).kind).toBe('kept');
    selection.kind = 'valid';
    expect(removeLegacyStore(f.runtime, () => false).kind).toBe('kept');
    const runtime = {
      ...f.runtime,
      storage: {
        ...f.runtime.storage,
        readDirectoryBoundedSync: ((...args: Parameters<Runtime['storage']['readDirectoryBoundedSync']>) => {
          if (args[0] === '/proc') throw new Error('unobservable proc');
          return f.runtime.storage.readDirectoryBoundedSync(...args);
        }) as Runtime['storage']['readDirectoryBoundedSync'],
      },
    };
    expect(removeLegacyStore(runtime, () => true).kind).toBe('kept');
    expect(existsSync(f.legacy)).toBe(true);
    f.runtime.storage.unlinkSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'epoch.json'));
    expect(removeLegacyStore(f.runtime, () => true).kind).toBe('kept');
    expect(existsSync(f.legacy)).toBe(true);
  });

  it('keeps a SQLite reader and retries once its exclusive lock is released', () => {
    const f = fixture();
    const db = newRawDatabase(f.legacy);
    db.exec('BEGIN; SELECT * FROM legacy_fixture');
    try {
      expect(removeLegacyStore(f.runtime, () => true)).toEqual({
        kind: 'kept',
        subject: f.legacy,
        reason: 'legacy-lock-contended',
      });
      expect(existsSync(f.legacy)).toBe(true);
    } finally {
      db.close();
    }
    expect(removeLegacyStore(f.runtime, () => true).kind).toBe('deleted');
  });

  it('keeps an idle WAL reader because transaction exclusivity alone cannot prove absence', () => {
    const f = fixture();
    for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
    const db = newRawDatabase(f.legacy);
    db.exec('PRAGMA journal_mode=WAL; SELECT * FROM legacy_fixture');
    try {
      expect(removeLegacyStore(f.runtime, () => true).kind).toBe('kept');
      expect(existsSync(f.legacy)).toBe(true);
    } finally {
      db.close();
    }
    expect(removeLegacyStore(f.runtime, () => true).kind).toBe('deleted');
  });
});
