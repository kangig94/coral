import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

  it.each(['mutation', 'rename'])(
    'restores the whole family after a WAL commit at the %s boundary',
    async (boundary) => {
      const f = fixture();
      for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
      const writer = newRawDatabase(f.legacy);
      writer.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO legacy_fixture VALUES ('initial')",
      );
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      for (const suffix of siblings) utimesSync(f.legacy + suffix, 1, 1);
      let wrote = false;
      const commit = () => {
        if (!wrote) {
          wrote = true;
          writer.exec("INSERT INTO legacy_fixture VALUES ('fresh')");
        }
      };
      const rename = f.runtime.storage.renameSync;
      vi.spyOn(f.runtime.storage, 'renameSync').mockImplementation((from, to) => {
        if (boundary === 'rename' && from === f.legacy) commit();
        rename(from, to);
      });
      const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync');
      try {
        const outcome = await removeLegacyStore(
          f.runtime,
          () => true,
          cutoff,
          (operation) => {
            if (boundary === 'mutation') commit();
            return operation();
          },
        );
        expect(wrote).toBe(true);
        expect(outcome).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
        expect(unlink).not.toHaveBeenCalled();
        for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(true);
        expect(writer.prepare('SELECT value FROM legacy_fixture').all()).toEqual([
          { value: 'initial' },
          { value: 'fresh' },
        ]);
      } finally {
        writer.close();
      }
    },
  );

  it('preserves mtimes on rename and validates every quarantined file before the first unlink', async () => {
    const f = fixture();
    const mtimes = new Map(
      siblings.map((suffix) => ['store.db' + suffix, statSync(f.legacy + suffix, { bigint: true }).mtimeNs]),
    );
    const rename = f.runtime.storage.renameSync;
    const quarantined: string[] = [];
    vi.spyOn(f.runtime.storage, 'renameSync').mockImplementation((from, to) => {
      const before = statSync(from, { bigint: true }).mtimeNs;
      rename(from, to);
      expect(statSync(to, { bigint: true }).mtimeNs).toBe(before);
      quarantined.push(String(to));
    });
    const stat = f.runtime.storage.lstatSync;
    const validated = new Set<string>();
    vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation((...args) => {
      const result = stat(...args);
      if (args[1]?.bigint && quarantined.includes(String(args[0]))) validated.add(String(args[0]));
      return result;
    });
    const unlink = f.runtime.storage.unlinkSync;
    vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation((path) => {
      expect(quarantined).toHaveLength(siblings.length);
      expect(validated.size).toBe(siblings.length);
      for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(false);
      expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtimes.get(String(path).split('/').at(-1)!));
      unlink(path);
    });
    expect(await retire(f)).toMatchObject({ kind: 'deleted', count: siblings.length });
  });

  it.each(['recent', 'unknown', 'rename-failure'])(
    'restores the family when quarantine evidence is %s',
    async (evidence) => {
      const f = fixture();
      const rename = f.runtime.storage.renameSync;
      vi.spyOn(f.runtime.storage, 'renameSync').mockImplementation((from, to) => {
        if (from === f.legacy + '-wal' && evidence === 'rename-failure') throw new Error('injected rename refusal');
        rename(from, to);
        if (from === f.legacy + '-wal' && evidence === 'recent') utimesSync(to, new Date(), new Date());
      });
      const stat = f.runtime.storage.lstatSync;
      vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation((...args) => {
        if (
          evidence === 'unknown' &&
          String(args[0]).includes('.legacy-retention-') &&
          String(args[0]).endsWith('-wal')
        )
          throw Object.assign(new Error('quarantine evidence unavailable'), { code: 'EACCES' });
        return stat(...args);
      });
      const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync');
      expect(await retire(f)).toMatchObject({ kind: 'kept' });
      expect(unlink).not.toHaveBeenCalled();
      for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(true);
    },
  );

  it('includes a WAL created at the main rename boundary in family validation', async () => {
    const f = fixture();
    for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
    const writer = newRawDatabase(f.legacy);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    for (const suffix of siblings) if (existsSync(f.legacy + suffix)) utimesSync(f.legacy + suffix, 1, 1);
    const rename = f.runtime.storage.renameSync;
    let wrote = false;
    vi.spyOn(f.runtime.storage, 'renameSync').mockImplementation((from, to) => {
      if (from === f.legacy && !wrote) {
        wrote = true;
        writer.exec("INSERT INTO legacy_fixture VALUES ('late WAL')");
      }
      rename(from, to);
    });
    const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync');
    try {
      expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
      expect(wrote).toBe(true);
      expect(unlink).not.toHaveBeenCalled();
      expect(existsSync(f.legacy)).toBe(true);
      expect(existsSync(f.legacy + '-wal')).toBe(true);
      expect(writer.prepare('SELECT value FROM legacy_fixture').all()).toEqual([{ value: 'late WAL' }]);
    } finally {
      writer.close();
    }
  });

  it('resumes an interrupted quarantine and restores it when new evidence is recent', async () => {
    const f = fixture();
    let allowed = true;
    const rename = f.runtime.storage.renameSync;
    const spy = vi.spyOn(f.runtime.storage, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (from === f.legacy + '.timestamp.bak') allowed = false;
    });
    expect(await retire(f, () => allowed)).toMatchObject({ kind: 'kept', reason: 'scan-pending' });
    for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(true);
    spy.mockRestore();
    const unlink = f.runtime.storage.unlinkSync;
    const refusal = vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation(() => {
      throw new Error('unlink refused');
    });
    expect(await retire(f)).toMatchObject({ kind: 'failed' });
    const quarantine = join(f.runtime.paths.coral.store.dbDir, '.legacy-retention-family');
    utimesSync(join(quarantine, 'store.db-wal'), new Date(), new Date());
    refusal.mockImplementation(unlink);
    expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
    for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(true);
    for (const suffix of siblings) utimesSync(f.legacy + suffix, 1, 1);
    expect(await retire(f)).toMatchObject({ kind: 'deleted', count: siblings.length });
  });

  it('keeps a fresh WAL when a pinned reader prevents checkpointing the old main file', async () => {
    const f = fixture();
    for (const suffix of ['-wal', '-shm']) f.runtime.storage.unlinkSync(f.legacy + suffix);
    const writer = newRawDatabase(f.legacy);
    writer.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO legacy_fixture VALUES ('initial'); PRAGMA wal_checkpoint(TRUNCATE)",
    );
    const reader = newRawDatabase(f.legacy);
    try {
      reader.exec('BEGIN; SELECT * FROM legacy_fixture');
      for (const suffix of siblings) utimesSync(f.legacy + suffix, 1, 1);
      writer.exec("INSERT INTO legacy_fixture VALUES ('recent')");
      expect(writer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()).toMatchObject({ checkpointed: 0 });
      expect(statSync(f.legacy).mtimeMs).toBe(1000);
      expect(await retire(f)).toMatchObject({ kind: 'kept', reason: 'legacy-not-expired-or-unknown' });
      for (const suffix of siblings) expect(existsSync(f.legacy + suffix)).toBe(true);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      writer.close();
    }
  });
});
