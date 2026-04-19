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

// CG4: full handoff race is wired when coordinator-rpc-control extracts service.ts + lifecycle.ts
// composition. CG1 ships the bootable slice (cold-start + lock + discovery + flavor isolation);
// warm-start handoff against a running incumbent requires the full composition chain to drain
// cleanly under CONTENDER_BUDGET and is validated in CG4 acceptance.

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

describe('coordinator warm-start integration', () => {
  // CG4 defer — the bootable slice (CG1) does not yet wire the full composition chain required
  // for a running incumbent to drain cleanly when a contender arrives. Cold-start + lock isolation
  // already pass; the handoff race requires coordinator-rpc-control (service.ts + lifecycle.ts
  // extraction) to be complete before the incumbent can respond to CONTENDER_BUDGET signals.
  it.skip('hands off from bundle A to bundle B within the contender budget and updates discovery to the replacement bundle', async () => {
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

    expect(elapsedMs).toBeLessThan(CONTENDER_BUDGET);
    expect(replacement.bundleHash).toBe('bundle-b');
    expect(replacement.pid).not.toBe(initial.pid);
    expect(firstExit.code).toBe(0);
    expect(isProcessAlive(initial.pid)).toBe(false);
    expect(isProcessAlive(replacement.pid)).toBe(true);
  });
});
