import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isProcessAlive } from '#src/infra/node-process.js';
import {
  buildArtifactsAvailable,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  updatePluginFixtureBundleHash,
  waitForCondition,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
// Safety ceiling for the discovery handoff wait. Matches the historical
// CONTENDER_BUDGET so the overall poll budget is unchanged after AC8.
const HANDOFF_OBSERVATION_BUDGET_MS = 90_000;
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
      throw new Error('Expected clients/build/coral-backend.cjs to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-warm-home-'));
    tempRoots.push(home);

    const firstFixture = createPluginFixture(tempRoots, { flavor: 'prod', bundleHash: 'aaaaaaaaaaaaaaaa' });

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
    expect(initial.bundleHash).toBe('aaaaaaaaaaaaaaaa');
    expect(isProcessAlive(initial.pid)).toBe(true);

    const secondFixture = updatePluginFixtureBundleHash(firstFixture, 'bbbbbbbbbbbbbbbb');
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

    try {
      await waitForCondition(() => {
        if (second.child.exitCode !== null) {
          throw new Error(`replacement exited with code ${second.child.exitCode}:\n${second.output()}`);
        }
        const record = readDiscoveryRecordForHome(home, 'prod');
        return record !== null && record.bundleHash === secondFixture.bundleHash && record.pid !== initial.pid;
      }, HANDOFF_OBSERVATION_BUDGET_MS);
    } catch (error: unknown) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nincumbent output:\n${first.output()}\nreplacement output:\n${second.output()}`,
        { cause: error },
      );
    }

    const replacement = await waitForDiscoveryRecord(home, 'prod', 5_000);
    const elapsedMs = Date.now() - handoffStartedAt;
    const firstExit = await waitForProcessExit(first, 10_000);

    // EXPECTED_HANDOFF_MAX_MS is the steady-state handoff bound; the polling
    // budget above is just a safety ceiling.
    expect(elapsedMs).toBeLessThan(EXPECTED_HANDOFF_MAX_MS);
    expect(replacement.bundleHash).toBe('bbbbbbbbbbbbbbbb');
    expect(replacement.pid).not.toBe(initial.pid);
    expect(firstExit.code).toBe(0);
    expect(isProcessAlive(initial.pid)).toBe(false);
    expect(isProcessAlive(replacement.pid)).toBe(true);
  });
});
