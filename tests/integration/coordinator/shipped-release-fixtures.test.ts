import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createShippedPluginFixture,
  SHIPPED_RELEASE_TAGS,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
  type ShippedReleaseTag,
} from '#tests/integration/coordinator/helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

const FINGERPRINT_0_4 = 'sha256:f14ec2988abbf0fe125a6b0c9b50cbece7104d8a82a96da149392e2f44e53f52';
const FINGERPRINT_5_9 = 'sha256:9fd970cdcb803f517d77b133bba86ae83ef1ff662f77da8656604f32c8e67980';
const FINGERPRINT_10_13 = 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521';

function expectedFingerprint(tag: ShippedReleaseTag): string {
  const patch = Number(tag.slice('v0.10.'.length));
  if (patch <= 4) {
    return FINGERPRINT_0_4;
  }
  if (patch <= 9) {
    return FINGERPRINT_5_9;
  }
  return FINGERPRINT_10_13;
}

afterEach(async () => {
  while (coordinators.length > 0) {
    const coordinator = coordinators.pop();
    if (coordinator) {
      await stopCoordinator(coordinator);
    }
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shipped release plugin fixtures', () => {
  it.each(SHIPPED_RELEASE_TAGS)('materializes every tagged plugin file from %s', (tag) => {
    const fixture = createShippedPluginFixture(tempRoots, tag);
    expect(createShippedPluginFixture(tempRoots, tag)).toBe(fixture);
    expect(fixture.version).toBe(tag.slice(1));
    expect(fixture.storeFormatFingerprint).toBe(expectedFingerprint(tag));

    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', tag, 'clients'], {
      encoding: 'utf-8',
    }).trim().split('\n');
    for (const path of paths) {
      expect(existsSync(join(fixture.root, path.slice('clients/'.length))), path).toBe(true);
    }

    const taggedManifest = execFileSync('git', ['show', `${tag}:clients/bridge/manifest.json`]);
    expect(readFileSync(join(fixture.root, 'bridge', 'manifest.json'))).toEqual(taggedManifest);
    expect(existsSync(fixture.cliPath)).toBe(true);
  });

  it('keeps different release tags under different plugin roots', () => {
    const roots = SHIPPED_RELEASE_TAGS.map((tag) => createShippedPluginFixture(tempRoots, tag).root);
    expect(new Set(roots).size).toBe(SHIPPED_RELEASE_TAGS.length);
  });

  it.each(['v0.10.0', 'v0.10.5', 'v0.10.13'] as const)(
    'starts a coordinator from the complete %s plugin root',
    async (tag) => {
      const fixture = createShippedPluginFixture(tempRoots, tag);
      const home = mkdtempSync(join(tmpdir(), 'coral-shipped-home-'));
      tempRoots.push(home);
      const coordinator = spawnCoordinator({ fixture, home, tempRoots });
      coordinators.push(coordinator);

      const discovery = await waitForDiscoveryRecord(home, 'prod', 15_000);
      expect(discovery.version).toBe(fixture.version);
      expect(discovery.bundleHash).toBe(fixture.bundleHash);
      expect(coordinator.child.exitCode).toBeNull();
    },
  );
});
