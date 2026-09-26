import { newRawDatabase } from '#tests/helpers/test-db.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  storeDbPathForHome,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];

// This cold-start safety ceiling must not be used to bound a current-attempt handoff reader.
const STARTUP_HARD_BOUND_MS = 30_000;

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

describe('coordinator cold-start integration', () => {
  it('binds the IPC socket, writes coordinator.json, applies store schemas, and remains alive within the startup bound', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected clients/build/coral-backend.cjs to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-cold-home-'));
    tempRoots.push(home);

    const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
    const startedAt = Date.now();

    const coordinator = spawnCoordinator({
      fixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(coordinator);

    const discovery = await waitForDiscoveryRecord(home, 'prod', 15_000).catch((error: unknown) => {
      throw new Error(`Coordinator startup failed: ${coordinator.output()}`, { cause: error });
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(STARTUP_HARD_BOUND_MS);

    expect(discovery.bundleHash).toBe(fixture.bundleHash);
    expect(discovery.flavor).toBe('prod');

    const files = coordinatorFilesForHome(home, 'prod');
    expect(existsSync(files.infoFile)).toBe(true);
    expect(existsSync(files.socketPath)).toBe(true);

    const dbPath = storeDbPathForHome(home, 'prod', '1');
    await waitForCondition(() => existsSync(dbPath), 15_000);
    const db = newRawDatabase(dbPath, { readonly: true });

    try {
      const tableNames = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      expect(tableNames.has('events')).toBe(true);
      expect(tableNames.has('consumer_cursors')).toBe(true);
      expect(tableNames.has('projection_jobs')).toBe(true);
    } finally {
      db.close();
    }

    await waitForCondition(() => observeProcessLiveness(discovery.pid) !== 'absent', 1_000);
    expect(observeProcessLiveness(discovery.pid)).toBe('alive');
    expect(discovery.port).toBeGreaterThan(0);

    // Shutdown removes coordinator.json (Phase B+C contract).
    await stopCoordinator(coordinators.pop()!);
    await waitForCondition(() => !existsSync(files.infoFile), 5_000);
    expect(existsSync(files.infoFile)).toBe(false);
  });

  it('resolves a dead succession attempt once it binds, even when its discovery record names a live pid', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected clients/build/coral-backend.cjs to exist before running integration tests');
    }
    const home = mkdtempSync(join(tmpdir(), 'coral-cold-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
    const files = coordinatorFilesForHome(home, 'prod');
    const first = spawnCoordinator({ fixture, home, tempRoots });
    coordinators.push(first);
    const record = await waitForDiscoveryRecord(home, 'prod', 15_000);
    await stopCoordinator(first);
    // A recorded pid that is alive, as a reused one is after a reboot, reads as a coordinator that may answer.
    writeFileSync(files.infoFile, `${JSON.stringify({ ...record, pid: process.pid })}\n`, { mode: 0o600 });
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
    if (exited.pid === undefined) throw new Error('exited child has no pid');
    const owner = { kind: 'incumbent' as const, instanceId: 'dead-incumbent', pid: exited.pid, incarnation: null };
    const attemptId = randomUUID();
    const written = await compareAndSwapUpgradeIntent(files.runDir, null, {
      requestId: randomUUID(),
      incumbent: { ...owner, version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod' },
      target: {
        build: {
          version: '99.0.0',
          buildSetId: randomUUID(),
          flavor: 'prod',
          storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
          bundleHash: '0123456789abcdef',
          cliBundleHash: '0123456789abcdef',
          claudeAppserverBundleHash: '0123456789abcdef',
          durableWrapperBundleHash: '0123456789abcdef',
        },
        pluginRootLabel: join(home, 'missing-target'),
      },
      attemptId,
      attemptOwner: owner,
      attemptChild: null,
      disposition: 'pending',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
    });
    expect(written.kind).toBe('written');

    const coordinator = spawnCoordinator({ fixture, home, tempRoots });
    coordinators.push(coordinator);
    await waitForCondition(() => {
      try {
        return (JSON.parse(readFileSync(files.infoFile, 'utf8')) as { pid?: unknown }).pid === coordinator.child.pid;
      } catch {
        return false;
      }
    }, 15_000).catch((error: unknown) => {
      throw new Error(`Coordinator startup failed: ${coordinator.output()}`, { cause: error });
    });

    await waitForCondition(() => {
      const intent = readUpgradeIntent(files.runDir);
      return intent.kind === 'readable' && intent.intent.attemptId !== attemptId;
    }, 15_000);
  });
});
