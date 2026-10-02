import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  assertBuildArtifactsAvailable,
  createPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0).reverse()) await stopCoordinator(coordinator);
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('retained build root', () => {
  it('should start and replace its own retained copy when that copy no longer validates', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-retained-root-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
    const manifest = JSON.parse(
      readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as StrictBundleManifest;
    const retained = retainedBuildRoot(
      createRealRuntime('prod', { baseDir: join(home, '.coral') }),
      manifest.buildSetId,
    );
    const validate = createForeignTargetValidator();

    const first = spawnCoordinator({ fixture, home, tempRoots });
    coordinators.push(first);
    await waitForDiscoveryRecord(home, 'prod', 20_000);
    await waitForCondition(() => existsSync(retained), 20_000);
    await stopCoordinator(first);
    appendFileSync(join(retained, 'bridge', 'coral-backend.cjs'), '\n// corrupted retained copy\n');
    expect(validate(join(retained, 'bridge'), manifest).kind).not.toBe('validated');

    const second = spawnCoordinator({ fixture, home, tempRoots });
    coordinators.push(second);
    const serving = await waitForDiscoveryRecord(home, 'prod', 20_000).catch((error: unknown) => {
      throw new Error(`Coordinator did not start over an invalid retained copy: ${second.output()}`, {
        cause: error,
      });
    });

    expect(serving.pid).toBe(second.child.pid);
    await waitForCondition(() => validate(join(retained, 'bridge'), manifest).kind === 'validated', 20_000);
  }, 90_000);
});
