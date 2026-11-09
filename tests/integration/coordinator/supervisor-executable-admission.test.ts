import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { readLaunchStatus } from '#src/infra/launch-status.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type SpawnedCoordinator,
} from './helpers.js';

const roots: string[] = [];
const supervisors: SpawnedCoordinator[] = [];
const coordinators: { pid: number; incarnation: string | null }[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await stopCoordinator(supervisor);
  await stopRecordedProcesses(coordinators.splice(0), 'SIGKILL', 30_000);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

it('boots a coordinator when the supervisor is launched through a symlinked plugin root', async () => {
  assertBuildArtifactsAvailable();
  const fixture = createPluginFixture(roots, { flavor: 'prod', accepts: 'bundled' });
  const link = join(scratch('coral-plugin-link-'), 'plugin');
  symlinkSync(fixture.root, link);
  const home = scratch('coral-symlinked-root-home-');
  const supervisor = spawnCoordinator({
    fixture: { ...fixture, root: link },
    home,
    tempRoots: roots,
    supervised: true,
  });
  supervisors.push(supervisor);

  const discovery = await waitForDiscoveryRecord(home, 'prod', 30_000);
  coordinators.push({ pid: discovery.pid, incarnation: probeProcessIncarnation(discovery.pid) });
}, 60_000);

it('leaves a durable refusal and a log line when the supervisor cannot admit its executable', async () => {
  assertBuildArtifactsAvailable();
  const fixture = createPluginFixture(roots, { flavor: 'prod', accepts: 'bundled' });
  const home = scratch('coral-refused-executable-home-');
  const missing = join(fixture.root, 'bridge', 'missing-backend.cjs');
  const supervisor = spawnCoordinator({ fixture, home, tempRoots: roots, supervised: true, backendPath: missing });
  supervisors.push(supervisor);

  expect(await waitForProcessExit(supervisor, 30_000)).toEqual({ code: 1, signal: null });
  const runDir = coordinatorFilesForHome(home, 'prod').runDir;
  expect(readLaunchStatus(runDir)).toMatchObject({
    kind: 'readable',
    status: { launchRefusal: { kind: 'executable-refused', executable: missing, supervisorPid: supervisor.child.pid } },
  });
  const pointer = JSON.parse(readFileSync(join(runDir, 'coordinator-logs', 'latest-supervisor.json'), 'utf8')) as {
    path: string;
  };
  const log = readFileSync(pointer.path, 'utf8');
  expect(log).toContain(`refused its executable ${missing}`);
  expect(log).toContain('exited with code 1');
}, 60_000);
