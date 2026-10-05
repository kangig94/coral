import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import * as historicalReaders from '#src/jobs/historical-reader.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
it('a throwing historical epoch cannot fail active location recovery', () => {
  const f = createRetentionFixture();
  fixtures.push(f);
  const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
  const storeRoot = join(f.baseDir, 'store');
  const historical = { storeRoot, epoch: '1', path: join(storeRoot, 'epoch-1', 'store.db') };
  const historicalKey = JSON.stringify(historical);
  // A historical source whose path observation fails with a non-ENOENT error (EACCES on an ancestor, EIO, ...).
  const storage = {
    ...f.runtime.storage,
    lstatSync: (p: string, o?: unknown) => {
      if (p.startsWith(storeRoot)) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
      return (f.runtime.storage.lstatSync as (p: string, o?: unknown) => unknown)(p, o);
    },
  } as typeof f.runtime.storage;
  void seedHistoricalEpoch(
    f.runtime,
    index,
    historical,
    historicalKey,
    'sha256:unsupported',
    join(f.baseDir, 'exports'),
    storage,
  );
  const activeKey = JSON.stringify({ storeRoot, epoch: '2', path: join(storeRoot, 'epoch-2', 'store.db') });
  const refresh = vi.spyOn(historicalReaders, 'refreshHistoricalEpochs');
  let thrown: unknown;
  try {
    recoverJobLocations(index, activeKey, f.store);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeUndefined();
  expect(refresh).not.toHaveBeenCalled();
});
