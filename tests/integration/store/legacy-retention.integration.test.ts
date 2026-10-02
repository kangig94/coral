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

describe('legacy store retention', async () => {
  it('proves the selected writer epoch without enumerating the entire store root', async () => {
    const f = fixture();
    const scan = vi.spyOn(f.runtime.storage, 'readdirSync');
    expect(
      (
        await removeLegacyStore(
          f.runtime,
          () => true,
          () => true,
          (operation) => operation(),
        )
      ).kind,
    ).toBe('deleted');
    expect(scan).not.toHaveBeenCalled();
  });
  it.each(['linux', 'darwin'] as const)(
    'retires by namespace authority on %s without observing other users descriptors',
    async (platform) => {
      const f = fixture();
      const runtime = {
        ...f.runtime,
        env: { ...f.runtime.env, platform: () => platform },
        storage: {
          ...f.runtime.storage,
          readDirectoryBoundedSync: ((...args: Parameters<Runtime['storage']['readDirectoryBoundedSync']>) => {
            if (args[0] === '/proc')
              throw Object.assign(new Error('other users fd directories are inaccessible'), { code: 'EACCES' });
            return f.runtime.storage.readDirectoryBoundedSync(...args);
          }) as Runtime['storage']['readDirectoryBoundedSync'],
        },
      };
      expect(
        (
          await removeLegacyStore(
            runtime,
            () => true,
            () => true,
            (operation) => operation(),
          )
        ).kind,
      ).toBe('deleted');
      expect(existsSync(f.legacy)).toBe(false);
    },
  );

  it('quarantines the pathname before deletion and leaves an already-open reader usable', async () => {
    const f = fixture();
    const reader = newRawDatabase(f.legacy, { readonly: true });
    let quarantined = false;
    const runtime = {
      ...f.runtime,
      storage: {
        ...f.runtime.storage,
        unlinkSync: (path: string | Buffer) => {
          if (String(path).includes('store.db')) {
            expect(String(path)).toContain('.legacy-retention-');
            expect(existsSync(f.legacy)).toBe(false);
            quarantined = true;
          }
          f.runtime.storage.unlinkSync(path);
        },
      },
    };
    try {
      expect(
        (
          await removeLegacyStore(
            runtime,
            () => true,
            () => true,
            (operation) => operation(),
          )
        ).kind,
      ).toBe('deleted');
      expect(quarantined).toBe(true);
      expect(reader.prepare('SELECT * FROM legacy_fixture').all()).toEqual([]);
      const rollback = newRawDatabase(f.legacy);
      expect(rollback.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      rollback.close();
    } finally {
      reader.close();
    }
  });
  it('removes precisely the legacy store family under proven current selection and exclusive lock', async () => {
    const f = fixture();
    const unrelated = join(f.runtime.paths.coral.store.dbDir, 'unrelated.bak');
    writeFileSync(unrelated, 'keep');
    expect(
      await removeLegacyStore(
        f.runtime,
        () => true,
        () => true,
        (operation) => operation(),
      ),
    ).toEqual({ kind: 'deleted', subject: f.legacy, count: 6 });
    for (const suffix of ['', '-wal', '-shm', '.format', '.bak', '.timestamp.bak'])
      expect(existsSync(f.legacy + suffix)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'))).toBe(true);
  });

  it('keeps unknown selection, unproven epoch, interrupted work and missing namespace authority', async () => {
    const f = fixture();
    selection.kind = 'rejected';
    expect(
      (
        await removeLegacyStore(
          f.runtime,
          () => true,
          () => true,
          (operation) => operation(),
        )
      ).kind,
    ).toBe('kept');
    selection.kind = 'valid';
    expect(
      (
        await removeLegacyStore(
          f.runtime,
          () => false,
          () => true,
          (operation) => operation(),
        )
      ).kind,
    ).toBe('kept');
    expect(
      (
        await removeLegacyStore(
          f.runtime,
          () => true,
          () => false,
          (operation) => operation(),
        )
      ).kind,
    ).toBe('kept');
    expect(existsSync(f.legacy)).toBe(true);
    f.runtime.storage.unlinkSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'epoch.json'));
    expect(
      (
        await removeLegacyStore(
          f.runtime,
          () => true,
          () => true,
          (operation) => operation(),
        )
      ).kind,
    ).toBe('kept');
    expect(existsSync(f.legacy)).toBe(true);
  });

  it('lets existing rollback and WAL readers finish on the retired inode', async () => {
    const f = fixture();
    for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
    const reader = newRawDatabase(f.legacy);
    reader.exec('PRAGMA journal_mode=WAL; SELECT * FROM legacy_fixture');
    try {
      expect(
        (
          await removeLegacyStore(
            f.runtime,
            () => true,
            () => true,
            (operation) => operation(),
          )
        ).kind,
      ).toBe('deleted');
      expect(reader.prepare('SELECT * FROM legacy_fixture').all()).toEqual([]);
    } finally {
      reader.close();
    }
  });
});
