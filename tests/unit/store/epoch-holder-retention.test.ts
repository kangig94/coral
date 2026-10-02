import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneStoreEpochHolders, registerStoreEpochHolder } from '#src/store/epoch/holder.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { acquireSharedFileLockSync } from '#src/infra/fs-lock.js';

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
