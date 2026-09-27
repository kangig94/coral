import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { protectStoreEpoch, protectedStoreEpochRoot, reconcileProtectedEpochs } from '#src/store/epoch-protection.js';
import { readOrCreateEpochKey } from '#src/store/epoch-key.js';
import {
  encodeResolvedStoreEpoch,
  epochDirectory,
  epochPath,
  observeResolvedStoreEpoch,
  resolvedStoreEpoch,
  storeEpochLockPath,
} from '#src/store/epoch.js';
import {
  SHIPPED_RELEASE_TAGS,
  createShippedPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { openSettledTestStoreDb, openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0).reverse()) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('D5 protected epochs against shipped selectors', () => {
  it('does not publish a moved epoch address while observing a startup key', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-read-only-protected-observation-'));
    roots.push(home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    openSettledTestStoreDb(runtime).close();
    const original = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
    const key = encodeResolvedStoreEpoch(runtime, original);
    const lineageKey = readOrCreateEpochKey(runtime, original);
    const lineage = lineageKey.slice(0, lineageKey.lastIndexOf(':'));
    const protectedRoot = protectedStoreEpochRoot(original.storeRoot);
    const moved = join(protectedRoot, lineage, 'epoch-1');
    const address = join(protectedRoot, 'addresses', `${Buffer.from(lineageKey).toString('base64url')}.json`);
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(dirname(original.path), moved);

    expect(existsSync(address)).toBe(false);
    expect(observeResolvedStoreEpoch(runtime, key)?.path).toBe(join(moved, 'store.db'));
    expect(existsSync(address)).toBe(false);
  });

  it.each(SHIPPED_RELEASE_TAGS)(
    'requires real-process protected reopen proof before %s can be a crash controller',
    (tag) => {
      const home = mkdtempSync(join(tmpdir(), `coral-shipped-reopen-proof-${tag}-`));
      roots.push(home);
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      openSettledTestStoreDb(runtime).close();
      const epoch = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, '1');
      const address = protectStoreEpoch(runtime, epoch);
      const before = digest(join(address.protectedPath, 'store.db'));
      const shipped = createShippedPluginFixture(roots, tag);
      const result = spawnSync(
        process.execPath,
        [
          join(shipped.root, 'bridge', 'coral-backend.cjs'),
          '--probe-retained-epoch',
          JSON.stringify({
            storeRoot: runtime.paths.coral.store.dbDir,
            epoch: '1',
            path: epoch.path,
            lineageKey: address.epochKey,
          }),
          'unproved-controller',
        ],
        {
          env: { ...process.env, HOME: home, TMPDIR: home },
          timeout: 2_000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      expect(result.status === 0 && result.stdout.includes('"kind":"retained-epoch-open"')).toBe(false);
      expect(digest(join(address.protectedPath, 'store.db'))).toBe(before);
    },
    30_000,
  );

  it('publishes no protection claim after a marker-only crash before the shipped sweep', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-protected-marker-only-'));
    roots.push(home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const storeRoot = runtime.paths.coral.store.dbDir;
    openSettledTestStoreDb(runtime).close();
    readOrCreateEpochKey(runtime, resolvedStoreEpoch(storeRoot, '1'));
    expect(reconcileProtectedEpochs(runtime, storeRoot)).toEqual([]);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const coordinator = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(coordinator);
    await waitForDiscoveryRecord(home, 'prod', 15_000);
    expect(reconcileProtectedEpochs(runtime, storeRoot)).toEqual([]);
  }, 30_000);

  it.each(['v0.10.0', 'v0.10.10', 'v0.10.11', 'v0.10.12', 'v0.10.13'] as const)(
    'replays a moved but unpublished address after %s starts without a waiter',
    async (tag) => {
      const home = mkdtempSync(join(tmpdir(), `coral-protected-unmapped-${tag}-`));
      roots.push(home);
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const storeRoot = runtime.paths.coral.store.dbDir;
      openSettledTestStoreDb(runtime).close();
      const old = resolvedStoreEpoch(storeRoot, '1');
      const oldKey = readOrCreateEpochKey(runtime, old);
      const lineage = oldKey.slice(0, oldKey.lastIndexOf(':'));
      const moved = join(protectedStoreEpochRoot(storeRoot), lineage, 'epoch-1');
      mkdirSync(dirname(moved), { recursive: true });
      renameSync(dirname(old.path), moved);
      const before = digest(join(moved, 'store.db'));
      const storeFormat = currentCoralStoreFormat();
      for (const epoch of ['2', '3']) {
        const dir = epochDirectory(storeRoot, epoch);
        mkdirSync(dir, { recursive: true });
        writeFileSync(storeEpochLockPath(storeRoot, epoch), '');
        openTestStoreDatabase({ path: epochPath(storeRoot, epoch), storage: runtime.storage, storeFormat }).close();
        writeFileSync(join(dir, 'epoch.json'), readFileSync(join(moved, 'epoch.json')));
      }

      const shipped = createShippedPluginFixture(roots, tag);
      const coordinator = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
      coordinators.push(coordinator);
      try {
        await waitForDiscoveryRecord(home, 'prod', 15_000);
      } catch (error) {
        throw new Error(`Shipped coordinator did not publish discovery: ${coordinator.output()}`, { cause: error });
      }

      expect(digest(join(moved, 'store.db'))).toBe(before);
      expect(reconcileProtectedEpochs(runtime, storeRoot)).toMatchObject([
        {
          epochKey: oldKey,
          originalPath: dirname(old.path),
          protectedPath: moved,
        },
      ]);
      if (existsSync(old.path)) {
        expect(readOrCreateEpochKey(runtime, old)).not.toBe(oldKey);
      }
    },
    30_000,
  );
});
