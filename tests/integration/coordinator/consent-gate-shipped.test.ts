import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  coordinatorFilesForHome,
  createPluginFixture,
  createShippedPluginFixture,
  probeCoordinatorSocket,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0).reverse()) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('AC1 consent gate against shipped v0.10.13', () => {
  it('exits zero while the shipped incumbent keeps serving and leaves no signal or upgrade intent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-consent-home-'));
    roots.push(home);
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const incumbent = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(incumbent);
    const discovery = await waitForDiscoveryRecord(home, 'prod', 15_000);
    expect(discovery.version).toBe('0.10.13');

    const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 15_000)).toEqual({ code: 0, signal: null });

    expect(incumbent.child.exitCode).toBeNull();
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(discovery.pid);
    expect(await probeCoordinatorSocket(discovery.socketPath)).toBe('accepting');
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    expect(existsSync(join(runDir, 'handoff-signal.json'))).toBe(false);
    expect(existsSync(join(runDir, 'handoff-signal.v2.json'))).toBe(false);
    expect(existsSync(join(runDir, 'upgrade.v1.json'))).toBe(false);
  }, 30_000);
});
