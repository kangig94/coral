import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeLegacyStore } from '#src/store/epoch/legacy-retention.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

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
const cutoff = Date.now() - 14 * 86_400_000;
const siblings = ['', '-wal', '-shm', '.format', '.bak', '.timestamp.bak'];
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  openSettledTestStoreDb(f.runtime).close();
  const legacy = join(f.runtime.paths.coral.store.dbDir, 'store.db');
  const db = newRawDatabase(legacy);
  db.exec('CREATE TABLE legacy_fixture (value TEXT)');
  db.close();
  for (const suffix of siblings.slice(1)) writeFileSync(legacy + suffix, 'residue');
  for (const suffix of siblings) utimesSync(legacy + suffix, 1, 1);
  return { ...f, legacy };
}
function retire(f: ReturnType<typeof fixture>, canContinue = () => true) {
  return removeLegacyStore(f.runtime, canContinue, cutoff, (operation) => operation());
}

describe('legacy store retention', () => {
  it.each(siblings)('keeps the entire family when %s is recent', async (suffix) => {
    const f = fixture();
    utimesSync(f.legacy + suffix, new Date(cutoff + 1000), new Date(cutoff + 1000));
    expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
    for (const sibling of siblings) expect(existsSync(f.legacy + sibling)).toBe(true);
  });

  it('keeps a recent live legacy writer regardless of its socket or TMPDIR', async () => {
    const f = fixture();
    for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
    const writer = newRawDatabase(f.legacy);
    try {
      writer.exec("PRAGMA journal_mode=WAL; INSERT INTO legacy_fixture VALUES ('live')");
      expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
      expect(existsSync(f.legacy)).toBe(true);
      writer.exec("INSERT INTO legacy_fixture VALUES ('still live')");
      expect(writer.prepare('SELECT count(*) AS n FROM legacy_fixture').get()).toEqual({ n: 2 });
    } finally {
      writer.close();
    }
  });

  it('quarantines an expired family before unlink, preserving readers and unrelated files', async () => {
    const f = fixture();
    const unrelated = join(f.runtime.paths.coral.store.dbDir, 'unrelated.bak');
    writeFileSync(unrelated, 'keep');
    const reader = newRawDatabase(f.legacy, { readonly: true });
    const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync');
    try {
      expect(await retire(f)).toEqual({ kind: 'deleted', subject: f.legacy, count: 6 });
      for (const [path] of unlink.mock.calls) expect(String(path)).toContain('.legacy-retention-');
      for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(false);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'))).toBe(true);
      expect(reader.prepare('SELECT * FROM legacy_fixture').all()).toEqual([]);
      const rollback = newRawDatabase(f.legacy);
      expect(rollback.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      rollback.close();
    } finally {
      reader.close();
    }
  });

  it('keeps an unknown selection, unproven epoch and interrupted work', async () => {
    const f = fixture();
    selection.kind = 'rejected';
    expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'active-selection-unknown-or-legacy' });
    selection.kind = 'valid';
    expect(await retire(f, () => false)).toMatchObject({ kind: 'kept', reason: 'run-interrupted' });
    f.runtime.storage.unlinkSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'epoch.json'));
    expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'current-epoch-unproven' });
    expect(existsSync(f.legacy)).toBe(true);
  });

  it.each(['existing', 'new'])(
    'rechecks %s siblings after the eligibility scan before deleting anything',
    async (state) => {
      const f = fixture();
      if (state === 'new') f.runtime.storage.unlinkSync(f.legacy + '-wal');
      const iterate = f.runtime.storage.iterateDirectory;
      f.runtime.storage.iterateDirectory = async function* (path) {
        yield* iterate(path);
        if (path === f.runtime.paths.coral.store.dbDir) {
          if (state === 'new') writeFileSync(f.legacy + '-wal', 'new writer WAL');
          utimesSync(f.legacy + '-wal', new Date(), new Date());
        }
      };
      expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
      expect(existsSync(f.legacy)).toBe(true);
    },
  );
});
