import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneStoreEpochHolders, registerStoreEpochHolder } from '#src/store/epoch/holder.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { sweepStoreEpochsPostReady } from '#src/store/epoch/post-ready-sweep.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { acquireSharedFileLockSync, attemptExclusiveFileLockSync } from '#src/infra/fs-lock.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  mkdirSync(f.runtime.paths.coral.store.dbDir, { recursive: true });
  return f;
}

describe('epoch holder retention', () => {
  it('removes an absent owner even when another process still holds the same epoch, keeping alive and unknown owners', async () => {
    const f = fixture();
    const root = f.runtime.paths.coral.store.dbDir;
    mkdirSync(join(root, 'epoch-1'));
    writeFileSync(join(root, 'epoch-1', '.lock'), '');
    const release = acquireSharedFileLockSync(join(root, 'epoch-1', '.lock'));
    for (const [name, pid] of [
      ['absent', 101],
      ['alive', 102],
      ['unknown', 103],
    ] as const)
      writeFileSync(join(root, `.epoch-holder-${name}.json`), JSON.stringify({ epoch: '1', pid }));
    writeFileSync(join(root, '.epoch-holder-corrupt.json'), '{');
    const runtime = {
      ...f.runtime,
      process: {
        ...f.runtime.process,
        observeLiveness: (pid: number) =>
          pid === 101 ? ('absent' as const) : pid === 102 ? ('alive' as const) : ('unknown' as const),
      },
    };
    try {
      await pruneStoreEpochHolders(runtime, f.budget, (operation) => operation());
      expect(existsSync(join(root, '.epoch-holder-absent.json'))).toBe(false);
      for (const name of ['alive', 'unknown', 'corrupt'])
        expect(existsSync(join(root, `.epoch-holder-${name}.json`))).toBe(true);
      expect(f.outcomes).toContainEqual({
        kind: 'deleted',
        subject: join(root, '.epoch-holder-absent.json'),
        count: 1,
      });
    } finally {
      release();
    }
  });

  it('unregisters its marker on ordinary close and keeps unknown malformed markers during retries', async () => {
    const f = fixture();
    const root = f.runtime.paths.coral.store.dbDir;
    let released = 0;
    registerStoreEpochHolder(
      f.runtime,
      { storeRoot: root, epoch: '1', path: join(root, 'epoch-1', 'store.db') },
      f.db,
      () => {
        released += 1;
      },
    );
    const markers = f.runtime.storage.readdirSync(root).filter((name) => name.startsWith('.epoch-holder-'));
    expect(markers).toHaveLength(1);
    f.db.close();
    expect(existsSync(join(root, markers[0]))).toBe(false);
    expect(released).toBe(1);
    writeFileSync(join(root, '.epoch-holder-unknown.json'), JSON.stringify({ epoch: '1', pid: 103 }));
    f.budget.canContinue = () => false;
    await pruneStoreEpochHolders(f.runtime, f.budget, (operation) => operation());
    expect(existsSync(join(root, '.epoch-holder-unknown.json'))).toBe(true);
  });
});

it.each(['retention', 'post-ready'] as const)(
  'cleans only absent-owner holder publication stages (%s)',
  async (cleanup) => {
    const f = fixture();
    const root = f.runtime.paths.coral.store.dbDir;
    const runtime = {
      ...f.runtime,
      process: {
        ...f.runtime.process,
        observeLiveness: (pid: number) =>
          pid === 101 ? ('absent' as const) : pid === 102 ? ('alive' as const) : ('unknown' as const),
      },
    };
    const selected = { storeRoot: root, epoch: '1', path: join(root, 'epoch-1', 'store.db') };
    const dead = join(root, '.epoch-holder-dead.json.tmp');
    let released = 0;
    const publisher = {
      ...runtime,
      env: { ...runtime.env, pid: () => 101 },
      storage: {
        ...runtime.storage,
        writeAtomicDurableSync: (_path: string, data: string | Uint8Array) => {
          writeFileSync(dead, data);
          throw new Error('publisher exited before rename');
        },
      },
    };
    expect(() =>
      registerStoreEpochHolder(publisher, selected, newRawDatabase(':memory:'), () => {
        released++;
      }),
    ).toThrow('publisher exited');
    expect(released).toBe(1);
    if (cleanup === 'retention') await pruneStoreEpochHolders(runtime, f.budget, (operation) => operation());
    else expect(await sweepStoreEpochsPostReady(runtime, selected)).toBe('complete');
    expect(existsSync(dead)).toBe(false);
    for (const [name, value] of [
      ['live', JSON.stringify({ epoch: '1', pid: 102 })],
      ['unknown', JSON.stringify({ epoch: '1', pid: 103 })],
      ['malformed', '{'],
    ])
      writeFileSync(join(root, `.epoch-holder-${name}.json.tmp`), value);
    if (cleanup === 'retention') await pruneStoreEpochHolders(runtime, f.budget, (operation) => operation());
    else expect(await sweepStoreEpochsPostReady(runtime, selected)).toBe('unobservable-holder');
    for (const name of ['live', 'unknown', 'malformed'])
      expect(existsSync(join(root, `.epoch-holder-${name}.json.tmp`))).toBe(true);
  },
);

it.each([false, true])(
  'advances bounded holder cleanup beyond a retained prefix (missing cursor: %s)',
  async (missing) => {
    const f = fixture();
    f.runtime.storage = new InMemoryStorage(f.runtime.time);
    const storage = f.runtime.storage;
    const root = f.runtime.paths.coral.store.dbDir;
    storage.mkdirSync(root, { recursive: true });
    for (let i = 19; i >= 0; i--)
      storage.writeFileSync(join(root, `.epoch-holder-${String(i).padStart(2, '0')}.json`), '{');
    const target = join(root, '.epoch-holder-z.json');
    storage.writeFileSync(target, JSON.stringify({ epoch: '1', pid: 101 }));
    const runtime = { ...f.runtime, process: { ...f.runtime.process, observeLiveness: () => 'absent' as const } };
    let cursor = '';
    for (let cycle = 0; cycle < 8 && storage.existsSync(target); cycle++) {
      let checks = 0;
      cursor = await pruneStoreEpochHolders(
        runtime,
        { ...f.budget, canContinue: () => ++checks <= 6 },
        (operation) => operation(),
        cursor,
      );
      if (missing && cycle === 0) storage.unlinkSync(join(root, cursor));
    }
    expect(storage.existsSync(target)).toBe(false);
    expect(storage.existsSync(join(root, '.epoch-holder-19.json'))).toBe(true);
  },
);

it.each(['normal', 'competing-removal', 'permission-error', 'sync-error'])(
  'settles holder cleanup after %s',
  async (scenario) => {
    const f = fixture();
    const root = f.runtime.paths.coral.store.dbDir;
    mkdirSync(join(root, 'epoch-1'));
    writeFileSync(join(root, 'epoch-1', '.lock'), '');
    const subject = join(root, '.epoch-holder-race.json');
    writeFileSync(subject, JSON.stringify({ epoch: '1', pid: 101 }));
    const sync = vi.fn(() => scenario !== 'sync-error');
    const runtime = {
      ...f.runtime,
      process: { ...f.runtime.process, observeLiveness: () => 'absent' as const },
      storage: {
        ...f.runtime.storage,
        unlinkSync: (path: string) => {
          if (path === subject && scenario === 'permission-error')
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
          if (path === subject && scenario === 'competing-removal') unlinkSync(path);
          f.runtime.storage.unlinkSync(path);
        },
        syncDirectoryDurableSync: sync,
      },
    };
    await pruneStoreEpochHolders(runtime, f.budget, (operation) => operation());
    const failed = scenario === 'permission-error' || scenario === 'sync-error';
    expect(f.outcomes).toContainEqual(expect.objectContaining({ subject, kind: failed ? 'failed' : 'deleted' }));
    expect(existsSync(subject)).toBe(scenario === 'permission-error');
    expect(sync).toHaveBeenCalledTimes(scenario === 'permission-error' ? 0 : 1);
    const proof = attemptExclusiveFileLockSync(join(root, 'epoch-1', '.lock'));
    expect(proof.kind).toBe('acquired');
    if (proof.kind === 'acquired') proof.lease();
  },
);

it('keeps a holder marker replaced by a symlink after its owner is observed absent', async () => {
  const f = fixture();
  const root = f.runtime.paths.coral.store.dbDir;
  mkdirSync(join(root, 'epoch-1'));
  writeFileSync(join(root, 'epoch-1', '.lock'), '');
  const marker = join(root, '.epoch-holder-stale.json');
  const outside = join(f.baseDir, 'outside');
  writeFileSync(marker, JSON.stringify({ epoch: '1', pid: 101 }));
  writeFileSync(outside, 'outside evidence');
  f.runtime.process.observeLiveness = () => {
    renameSync(marker, join(f.baseDir, 'saved-marker'));
    symlinkSync(outside, marker);
    return 'absent';
  };
  await pruneStoreEpochHolders(f.runtime, f.budget, (operation) => operation());
  expect(lstatSync(marker).isSymbolicLink()).toBe(true);
  expect(existsSync(outside)).toBe(true);
  expect(f.outcomes).toContainEqual({ kind: 'failed', subject: marker, reason: 'holder-entry-identity-changed' });
});
