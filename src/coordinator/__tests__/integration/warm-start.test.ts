import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTENDER_BUDGET } from '../../lock.js';
import { isProcessAlive } from '../../../shared/node-process.js';
import {
  buildArtifactsAvailable,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForCondition,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from './helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const EXPECTED_HANDOFF_MAX_MS = 30_000;

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

describe('coordinator warm-start integration', () => {
  it('hands off from bundle A to bundle B within the contender budget and updates discovery to the replacement bundle', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected build/coral-backend.cjs to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-warm-home-'));
    tempRoots.push(home);

    const firstFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'bundle-a' });
    const secondFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'bundle-b' });

    const first = spawnCoordinator({
      fixture: firstFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(first);

    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    expect(initial.bundleHash).toBe('bundle-a');
    expect(isProcessAlive(initial.pid)).toBe(true);

    const handoffStartedAt = Date.now();
    const second = spawnCoordinator({
      fixture: secondFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(second);

    await waitForCondition(() => {
      const record = readDiscoveryRecordForHome(home, 'prod');
      return record !== null && record.bundleHash === secondFixture.bundleHash && record.pid !== initial.pid;
    }, CONTENDER_BUDGET);

    const replacement = await waitForDiscoveryRecord(home, 'prod', 5_000);
    const elapsedMs = Date.now() - handoffStartedAt;
    const firstExit = await waitForProcessExit(first, 10_000);

    // CONTENDER_BUDGET is the lock-loop safety ceiling, not the expected steady-state handoff time.
    expect(elapsedMs).toBeLessThan(EXPECTED_HANDOFF_MAX_MS);
    expect(replacement.bundleHash).toBe('bundle-b');
    expect(replacement.pid).not.toBe(initial.pid);
    expect(firstExit.code).toBe(0);
    expect(isProcessAlive(initial.pid)).toBe(false);
    expect(isProcessAlive(replacement.pid)).toBe(true);
  });
});
