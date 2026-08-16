import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness } from '#src/infra/node-process.js';
import {
  buildArtifactsAvailable,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  updatePluginFixtureBundleHash,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
// A contender that defers does so on one ping round-trip, so this only has to outlast process startup.
const DEFERRAL_BUDGET_MS = 30_000;

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
  // The only real-process cover of the daemon bind election. `cross-version-election.test.ts` proves the
  // same rule against a scripted incumbent in-process; this proves the built backend actually behaves that
  // way end to end, discovery record and process lifetime included.
  it('defers to the healthy incumbent when a rebuilt same-version bundle starts, leaving discovery untouched', async () => {
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
    expect(initial.bundleHash).toBe(firstFixture.bundleHash);
    expect(observeProcessLiveness(initial.pid) !== 'absent').toBe(true);

    // An ordinary rebuild without a version bump: same product version, different bundle hash.
    const secondFixture = updatePluginFixtureBundleHash(firstFixture, 'bbbbbbbbbbbbbbbb');
    expect(secondFixture.bundleHash).not.toBe(firstFixture.bundleHash);
    const second = spawnCoordinator({
      fixture: secondFixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(second);

    let secondExit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      secondExit = await waitForProcessExit(second, DEFERRAL_BUDGET_MS);
    } catch (error: unknown) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nincumbent output:\n${first.output()}\nreplacement output:\n${second.output()}`,
        { cause: error },
      );
    }

    // A bundle hash identifies a build; it does not order one. With nothing to order the two by, the
    // contender is redundant rather than an upgrade, so it reports "already running" and exits cleanly —
    // the same outcome from either side of the pair, which is what stops repeated rebuilds from
    // alternating evictions that reset the store on every lap.
    expect(secondExit).toEqual({ code: 0, signal: null });

    const afterContender = readDiscoveryRecordForHome(home, 'prod');
    expect(afterContender).not.toBeNull();
    expect(afterContender?.pid).toBe(initial.pid);
    expect(afterContender?.bundleHash).toBe(firstFixture.bundleHash);
    expect(afterContender?.instanceId).toBe(initial.instanceId);
    expect(observeProcessLiveness(initial.pid) !== 'absent').toBe(true);
  });
});
