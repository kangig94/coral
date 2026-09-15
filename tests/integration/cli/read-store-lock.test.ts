import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { Runtime } from '#src/runtime/ports.js';
import type * as RealRuntimeMod from '#src/runtime/real.js';

const injected = vi.hoisted(() => ({ runtime: null as Runtime | null }));

vi.mock('#src/runtime/real.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RealRuntimeMod>();
  return {
    ...actual,
    createRealRuntime: () => {
      if (injected.runtime === null) throw new Error('read-store test runtime was not installed');
      return injected.runtime;
    },
  };
});

import { closeSharedReadCoralStore, getSharedReadCoralStore } from '#src/cli/read-store.js';
import { sweepStoreEpochs, sweepStoreEpochsPostReady } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

let root: string | null = null;

afterEach(() => {
  closeSharedReadCoralStore();
  injected.runtime = null;
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

function publishEpoch(runtime: Runtime, epoch: string): void {
  const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
  mkdirSync(directory, { recursive: true });
  openTestStoreDatabase({
    path: join(directory, 'store.db'),
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
  }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable', cause: 'test' },
      build: {
        version: '0.10.9',
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        storeFormatFingerprint: currentCoralStoreFormat().fingerprint,
      },
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

it('keeps the cached CLI reader shared lock until its cached SQLite handle closes', async () => {
  const realRuntime = await vi.importActual<typeof RealRuntimeMod>('#src/runtime/real.js');
  root = mkdtempSync(join(tmpdir(), 'coral-cached-read-lock-'));
  const runtime = realRuntime.createRealRuntime('prod', { baseDir: root });
  injected.runtime = runtime;
  const dbDir = runtime.paths.coral.store.dbDir;
  publishEpoch(runtime, '1');

  getSharedReadCoralStore(process.cwd());
  publishEpoch(runtime, '3');
  publishEpoch(runtime, '5');

  expect(await sweepStoreEpochsPostReady(runtime, dbDir, '5')).toBe('live-holder');
  expect(existsSync(join(dbDir, 'epoch-1'))).toBe(true);
  console.log('read-only-opener-cell opener=cached-cli operation=post-ready-sweep result=live-holder');

  expect(sweepStoreEpochs(runtime, dbDir, null, { releaseEpoch: '1' })).toBe('live-holder');
  expect(existsSync(join(dbDir, 'epoch-1'))).toBe(true);
  console.log('read-only-opener-cell opener=cached-cli operation=release result=live-holder');
});
