import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntentChange } from '#src/infra/upgrade-intent.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { protectStoreEpoch, protectedStoreEpochRoot, reconcileProtectedEpochs } from '#src/store/epoch-protection.js';
import { readOrCreateEpochKey } from '#src/store/epoch-key.js';
import { epochDirectory, epochPath, resolvedStoreEpoch, storeEpochLockPath } from '#src/store/epoch.js';
import {
  createShippedPluginFixture, spawnCoordinator, stopCoordinator, waitForDiscoveryRecord,
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
  it('publishes no protection claim after a marker-only crash before the shipped sweep', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-protected-marker-only-'));
    roots.push(home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const storeRoot = runtime.paths.coral.store.dbDir;
    openSettledTestStoreDb(runtime).close();
    readOrCreateEpochKey(resolvedStoreEpoch(storeRoot, '1'));
    expect(reconcileProtectedEpochs(storeRoot)).toEqual([]);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const coordinator = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(coordinator);
    await waitForDiscoveryRecord(home, 'prod', 15_000);
    expect(reconcileProtectedEpochs(storeRoot)).toEqual([]);
  }, 30_000);

  it.each(['v0.10.0', 'v0.10.13'] as const)(
    'replays a moved but unpublished address after %s starts without a waiter',
    async (tag) => {
      const home = mkdtempSync(join(tmpdir(), `coral-protected-unmapped-${tag}-`));
      roots.push(home);
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const storeRoot = runtime.paths.coral.store.dbDir;
      openSettledTestStoreDb(runtime).close();
      const old = resolvedStoreEpoch(storeRoot, '1');
      const oldKey = readOrCreateEpochKey(old);
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
      await waitForDiscoveryRecord(home, 'prod', 15_000);

      expect(digest(join(moved, 'store.db'))).toBe(before);
      expect(reconcileProtectedEpochs(storeRoot)).toMatchObject([{
        epochKey: oldKey, originalPath: dirname(old.path), protectedPath: moved,
      }]);
      if (existsSync(old.path)) {
        expect(readOrCreateEpochKey(old)).not.toBe(oldKey);
      }
    },
    30_000,
  );

  it.each(['v0.10.0', 'v0.10.13'] as const)(
    'keeps a protected epoch byte-for-byte across a %s rollback after its waiter is killed',
    async (tag) => {
      const home = mkdtempSync(join(tmpdir(), `coral-protected-${tag}-`));
      roots.push(home);
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const storeRoot = runtime.paths.coral.store.dbDir;
      openSettledTestStoreDb(runtime).close();
      const original = resolvedStoreEpoch(storeRoot, '1');
      const key = readOrCreateEpochKey(original);
      const address = protectStoreEpoch(original);
      const before = digest(join(address.protectedPath, 'store.db'));
      const storeFormat = currentCoralStoreFormat();
      for (const epoch of ['2', '3']) {
        const dir = epochDirectory(storeRoot, epoch);
        mkdirSync(dir, { recursive: true });
        writeFileSync(storeEpochLockPath(storeRoot, epoch), '');
        openTestStoreDatabase({ path: epochPath(storeRoot, epoch), storage: runtime.storage, storeFormat }).close();
        writeFileSync(join(dir, 'epoch.json'), readFileSync(join(address.protectedPath, 'epoch.json')));
      }

      const shipped = createShippedPluginFixture(roots, tag);
      const waiter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      await once(waiter, 'spawn');
      try {
        if (waiter.pid === undefined) throw new Error('Waiter process did not start.');
        const build = (JSON.parse(readFileSync(join(address.protectedPath, 'epoch.json'), 'utf8')) as {
          build: UpgradeIntentChange['target']['build'];
        }).build;
        const pending: UpgradeIntentChange = {
          requestId: `rollback-${tag}`,
          incumbent: {
            instanceId: 'retired-incumbent', pid: waiter.pid, incarnation: null,
            version: build.version, bundleHash: build.bundleHash, flavor: 'prod',
          },
          target: { build, pluginRootLabel: shipped.root },
          attemptId: `killed-waiter-${tag}`,
          attemptOwner: { kind: 'waiter', instanceId: 'killed-waiter', pid: waiter.pid, incarnation: null },
          disposition: 'pending', blockers: [],
          retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting for retirement' },
          attemptDeadline: new Date(Date.now() - 1_000).toISOString(), completionReceipt: null,
        };
        const recorded = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, pending);
        expect(recorded.kind).toBe('written');
      } finally {
        waiter.kill('SIGKILL');
        await once(waiter, 'exit');
      }
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        kind: 'readable', intent: { disposition: 'pending', attemptOwner: { kind: 'waiter' } },
      });
      const coordinator = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
      coordinators.push(coordinator);
      await waitForDiscoveryRecord(home, 'prod', 15_000);

      expect(existsSync(address.protectedPath)).toBe(true);
      expect(digest(join(address.protectedPath, 'store.db'))).toBe(before);
      expect(address.epochKey).toBe(key);
    },
    30_000,
  );
});
