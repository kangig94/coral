import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { STARTUP_DEADLINE } from '../../lock.js';
import { isProcessAlive } from '../../../shared/node-process.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readLockRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  storeDbPathForHome,
  waitForCondition,
  waitForDiscoveryRecord,
  type SpawnedCoordinator,
} from './helpers.js';

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

describe('coordinator cold-start integration', () => {
  it('creates discovery and lock files, applies migrations, and remains alive well within the startup deadline', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected build/coral-backend.cjs to exist before running integration tests');
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

    const discovery = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(STARTUP_DEADLINE);

    const lock = readLockRecordForHome(home, 'prod');
    expect(lock).toMatchObject({
      pid: discovery.pid,
      bundleHash: fixture.bundleHash,
      flavor: 'prod',
    });

    const files = coordinatorFilesForHome(home, 'prod');
    expect(existsSync(files.infoFile)).toBe(true);
    expect(existsSync(files.lockFile)).toBe(true);

    const dbPath = storeDbPathForHome(home, 'prod');
    await waitForCondition(() => existsSync(dbPath), 15_000);
    const db = new Database(dbPath, { readonly: true });

    try {
      const tableNames = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      expect(tableNames.has('events')).toBe(true);
      expect(tableNames.has('equipment_cursors')).toBe(true);
      expect(tableNames.has('projection_jobs')).toBe(true);
    } finally {
      db.close();
    }

    await waitForCondition(() => isProcessAlive(discovery.pid), 1_000);
    expect(discovery.bundleHash).toBe(fixture.bundleHash);
    expect(discovery.flavor).toBe('prod');
    expect(discovery.port).toBeGreaterThan(0);
  });
});
