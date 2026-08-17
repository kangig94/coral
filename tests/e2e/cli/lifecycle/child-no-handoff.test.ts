import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness } from '#src/infra/node-process.js';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
} from '../../../integration/coordinator/helpers.js';

const SOURCE_MANIFEST = join(process.cwd(), 'clients', 'build', 'manifest.json');
const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

function sourceFlavor(): BuildFlavor {
  const parsed = JSON.parse(readFileSync(SOURCE_MANIFEST, 'utf-8')) as { flavor?: unknown };
  if (parsed.flavor !== 'prod' && parsed.flavor !== 'dev') {
    throw new Error('Built manifest must declare prod or dev flavor.');
  }
  return parsed.flavor;
}

function unregisteredChildCliEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    CORAL_CHILD: '1',
    CORAL_CHILD_PRINCIPAL_HANDLE: 'fixture-child-handle',
    CORAL_JOB_ID: 'fixture-parent-job',
    CORAL_SESSION_ID: 'fixture-parent-session',
  };
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function runUnregisteredChildCli(cliPath: string, home: string) {
  return spawnSync(process.execPath, [cliPath, 'jobs', 'detail', 'fixture-job'], {
    cwd: home,
    env: unregisteredChildCliEnvironment(home),
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

afterEach(async () => {
  for (const coordinator of coordinators.splice(0).reverse()) {
    await stopCoordinator(coordinator);
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundled child coordinator confinement', () => {
  it('does not create coordinator state when a child has no parent', () => {
    if (!buildArtifactsAvailable() || !existsSync(SOURCE_MANIFEST)) {
      throw new Error('Expected a built Coral bundle before running lifecycle E2E tests.');
    }

    const flavor = sourceFlavor();
    const home = mkdtempSync(join(tmpdir(), 'coral-child-no-parent-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor, bundleHash: 'child-no-parent' });
    const paths = coordinatorFilesForHome(home, flavor);

    const result = runUnregisteredChildCli(join(fixture.root, 'bridge', 'coral-cli.cjs'), home);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Nested Coral command stopped because its parent coordinator is unreachable');
    expect(existsSync(paths.infoFile)).toBe(false);
    expect(existsSync(paths.startupErrorFile)).toBe(false);
    expect(existsSync(paths.startupDiagnosticFile)).toBe(false);
    expect(existsSync(join(paths.runDir, 'coordinator.log'))).toBe(false);
  });

  it('reuses a mismatched parent before rejecting an unregistered child without lifecycle mutation', async () => {
    if (!buildArtifactsAvailable() || !existsSync(SOURCE_MANIFEST)) {
      throw new Error('Expected a built Coral bundle before running lifecycle E2E tests.');
    }

    const flavor = sourceFlavor();
    const home = mkdtempSync(join(tmpdir(), 'coral-child-mismatch-home-'));
    tempRoots.push(home);
    const parentFixture = createPluginFixture(tempRoots, { flavor, bundleHash: 'parent-bundle-a' });
    const childFixture = createPluginFixture(tempRoots, { flavor, bundleHash: 'child-bundle-b' });
    expect(childFixture.bundleHash).not.toBe(parentFixture.bundleHash);

    const parent = spawnCoordinator({
      fixture: parentFixture,
      home,
      tempRoots,
      env: { CLAUDE_CONFIG_DIR: '', CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000' },
    });
    coordinators.push(parent);
    const before = await waitForDiscoveryRecord(home, flavor, 15_000);
    const paths = coordinatorFilesForHome(home, flavor);
    const discoveryBefore = readFileSync(paths.infoFile, 'utf-8');
    const logPath = join(paths.runDir, 'coordinator.log');
    const logBefore = existsSync(logPath) ? statSync(logPath) : null;

    // This bundled boundary deliberately uses an unknown handle so it can run
    // without launching a provider. The IPC server integration suite covers a
    // registered child succeeding within its caps and receiving the actionable
    // missing_capability response outside them.
    const result = runUnregisteredChildCli(join(childFixture.root, 'bridge', 'coral-cli.cjs'), home);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('IPC boot token or child principal required');

    const after = readDiscoveryRecordForHome(home, flavor);
    expect(after).not.toBeNull();
    expect(after?.pid).toBe(before.pid);
    expect(after?.instanceId).toBe(before.instanceId);
    expect(after?.bundleHash).toBe(before.bundleHash);
    expect(after?.bundleHash).toBe(parentFixture.bundleHash);
    expect(readFileSync(paths.infoFile, 'utf-8')).toBe(discoveryBefore);
    expect(observeProcessLiveness(before.pid)).toBe('alive');

    if (logBefore === null) {
      expect(existsSync(logPath)).toBe(false);
    } else {
      const logAfter = statSync(logPath);
      expect(logAfter.ino).toBe(logBefore.ino);
    }
  });
});
