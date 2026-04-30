import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isProcessAlive } from '#src/infra/node-process.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  readLockRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForCondition,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

afterEach(async () => {
  while (coordinators.length > 0) {
    const handle = coordinators.pop();
    if (handle) {
      await stopCoordinator(handle);
    }
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator lock integration', () => {
  it('keeps the incumbent for same-bundle contenders instead of replacing it', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected build/coral-backend.cjs to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-lock-home-'));
    tempRoots.push(home);

    const incumbentFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'same-bundle' });
    const contenderFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'same-bundle' });

    const incumbent = spawnCoordinator({
      fixture: incumbentFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(incumbent);

    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const lock = readLockRecordForHome(home, 'prod');
    expect(lock?.pid).toBe(initial.pid);

    const contender = spawnCoordinator({
      fixture: contenderFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });

    const contenderExit = await waitForProcessExit(contender, 15_000);
    expect(contenderExit.code).toBe(0);

    const after = await waitForDiscoveryRecord(home, 'prod', 5_000);
    expect(after.pid).toBe(initial.pid);
    expect(after.bundleHash).toBe(initial.bundleHash);
    expect(isProcessAlive(after.pid)).toBe(true);
  });

  it('keeps prod and dev lock/discovery state isolated in the same home', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected build/coral-backend.cjs to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-lock-flavors-home-'));
    tempRoots.push(home);

    const prodFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'prod-bundle' });
    const devFixture = createPluginFixture(tempRoots, { flavor: 'dev', bundleHash: 'dev-bundle' });

    const prod = spawnCoordinator({
      fixture: prodFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    const dev = spawnCoordinator({
      fixture: devFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(prod, dev);

    const prodDiscovery = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const devDiscovery = await waitForDiscoveryRecord(home, 'dev', 15_000);

    const prodLock = readLockRecordForHome(home, 'prod');
    const devLock = readLockRecordForHome(home, 'dev');
    expect(prodLock?.pid).toBe(prodDiscovery.pid);
    expect(devLock?.pid).toBe(devDiscovery.pid);
    expect(prodDiscovery.pid).not.toBe(devDiscovery.pid);
    expect(prodDiscovery.bundleHash).toBe('prod-bundle');
    expect(devDiscovery.bundleHash).toBe('dev-bundle');

    const prodFiles = coordinatorFilesForHome(home, 'prod');
    const devFiles = coordinatorFilesForHome(home, 'dev');
    expect(prodFiles.lockFile).not.toBe(devFiles.lockFile);
    expect(prodFiles.infoFile).not.toBe(devFiles.infoFile);

    await waitForCondition(() => {
      const prodRecord = readDiscoveryRecordForHome(home, 'prod');
      const devRecord = readDiscoveryRecordForHome(home, 'dev');
      return (
        prodRecord !== null && devRecord !== null && isProcessAlive(prodRecord.pid) && isProcessAlive(devRecord.pid)
      );
    }, 2_000);
  });
});
