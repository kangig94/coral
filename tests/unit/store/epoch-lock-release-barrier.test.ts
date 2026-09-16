import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as FsLockMod from '#src/infra/fs-lock.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const lockReleaseFault = vi.hoisted(() => ({ paths: new Set<string>() }));

vi.mock('#src/infra/fs-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FsLockMod>();
  return {
    ...actual,
    attemptExclusiveFileLockSync: (path: string) => {
      const attempt = actual.attemptExclusiveFileLockSync(path);
      if (attempt.kind !== 'acquired' || !lockReleaseFault.paths.has(path)) return attempt;
      return {
        kind: 'acquired' as const,
        lease: () => {
          attempt.lease();
          throw new Error(`injected lock release failure: ${path}`);
        },
      };
    },
  };
});

import {
  STORE_EPOCH_METADATA_FILE_NAME,
  epochDirectory,
  epochPath,
  resolvedStoreEpoch,
  storeEpochLockPath,
  sweepStoreEpochs,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  flavor: 'prod' as const,
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-epoch-lock-release-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publishEpoch(runtime: Runtime, epoch: string): void {
  const directory = epochDirectory(runtime.paths.coral.store.dbDir, epoch);
  mkdirSync(directory, { recursive: true });
  writeFileSync(storeEpochLockPath(runtime.paths.coral.store.dbDir, epoch), '');
  openTestStoreDatabase({
    path: epochPath(runtime.paths.coral.store.dbDir, epoch),
    storage: runtime.storage,
    storeFormat,
  }).close();
  writeFileSync(
    join(directory, STORE_EPOCH_METADATA_FILE_NAME),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

function trackingRootSync(runtime: Runtime): { runtime: Runtime; syncs: () => number } {
  const dbDir = runtime.paths.coral.store.dbDir;
  let rootSyncs = 0;
  const storage = new Proxy(runtime.storage, {
    get(subject, property, receiver) {
      if (property === 'syncDirectoryDurableSync') {
        return (path: string): boolean => {
          if (path === dbDir) rootSyncs += 1;
          return subject.syncDirectoryDurableSync(path);
        };
      }
      if (property === 'syncDirectoryDurable') {
        return async (path: string): Promise<boolean> => {
          if (path === dbDir) rootSyncs += 1;
          return subject.syncDirectoryDurable(path);
        };
      }
      return Reflect.get(subject, property, receiver) as unknown;
    },
  });
  return { runtime: { ...runtime, storage }, syncs: () => rootSyncs };
}

afterEach(() => {
  lockReleaseFault.paths.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store epoch lock-release durability barriers', () => {
  it('syncs a removed positive release target when its lock release throws', () => {
    const base = harness();
    publishEpoch(base, '1');
    publishEpoch(base, '3');
    publishEpoch(base, '5');
    const dbDir = base.paths.coral.store.dbDir;
    const tracked = trackingRootSync(base);
    lockReleaseFault.paths.add(storeEpochLockPath(dbDir, '1'));

    expect(sweepStoreEpochs(tracked.runtime, dbDir, null, { releaseEpoch: '1' })).toBe('lock-release-failed');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    expect(tracked.syncs()).toBeGreaterThan(0);
  });

  it('syncs a post-ready removal when its lock release throws', async () => {
    const base = harness();
    publishEpoch(base, '1');
    publishEpoch(base, '3');
    publishEpoch(base, '5');
    const dbDir = base.paths.coral.store.dbDir;
    const tracked = trackingRootSync(base);
    lockReleaseFault.paths.add(storeEpochLockPath(dbDir, '1'));

    await expect(sweepStoreEpochsPostReady(tracked.runtime, resolvedStoreEpoch(dbDir, '5'))).resolves.toBe(
      'lock-release-failed',
    );
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    expect(tracked.syncs()).toBeGreaterThan(0);
  });
});
