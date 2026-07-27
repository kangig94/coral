import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openWritableStoreDbNoReset } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  buildArtifactsAvailable,
  createPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  storeDbPathForHome,
  waitForDiscoveryRecord,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const RETIRED_ID = 'retired-vector';

afterEach(async () => {
  for (const coordinator of coordinators.splice(0).reverse()) {
    await stopCoordinator(coordinator);
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function coralRoot(home: string): string {
  return join(home, '.coral');
}

function kbRuntimeDir(home: string, flavor: BuildFlavor): string {
  return join(coralRoot(home), flavor === 'prod' ? 'data' : 'data-dev', 'kb');
}

function writeSentinel(path: string, value: string): string {
  mkdirSync(path, { recursive: true });
  const sentinel = join(path, 'sentinel');
  writeFileSync(sentinel, value);
  return sentinel;
}

function seedRetiredExpansion(home: string, flavor: BuildFlavor): void {
  const runtime = createRealRuntime(flavor, { baseDir: coralRoot(home) });
  const db = openWritableStoreDbNoReset(runtime, {
    path: storeDbPathForHome(home, flavor),
    storeFormat: currentCoralStoreFormat(),
  });
  try {
    db.prepare('INSERT INTO expansion_state (id, version, installed_at) VALUES (?, ?, ?)').run(
      RETIRED_ID,
      '0.9.0',
      '2026-01-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO consumer_cursors
         (consumer_id, authority, cursor, registered_at, registration_kind)
       VALUES (?, 'journal', 0, '2026-01-01T00:00:00.000Z', 'expansion')`,
    ).run(RETIRED_ID);
  } finally {
    db.close();
  }
}

function runBuiltCli(fixture: PluginFixture, home: string, flavor: BuildFlavor, args: readonly string[]): unknown {
  const result = spawnSync(process.execPath, [join(fixture.root, 'bridge', 'coral-cli.cjs'), ...args], {
    cwd: fixture.root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: home,
      CLAUDE_PLUGIN_ROOT: fixture.root,
      CORAL_FLAVOR: flavor,
      CORAL_KB_EXTRA_LANGS: '',
    },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  if (result.status !== 0) {
    throw new Error(`built CLI failed (${String(result.status)}): ${result.stdout}${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as unknown;
}

function rowCount(home: string, flavor: BuildFlavor, table: string): number {
  const db = newRawDatabase(storeDbPathForHome(home, flavor), { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id = ?`).get(RETIRED_ID) as { count: number })
      .count;
  } finally {
    db.close();
  }
}

function cursorCount(home: string, flavor: BuildFlavor): number {
  const db = newRawDatabase(storeDbPathForHome(home, flavor), { readonly: true });
  try {
    return (
      db.prepare('SELECT COUNT(*) AS count FROM consumer_cursors WHERE consumer_id = ?').get(RETIRED_ID) as {
        count: number;
      }
    ).count;
  } finally {
    db.close();
  }
}

describe('retired expansion full-boot upgrade', () => {
  it('keeps prod residue visible until the built CLI performs explicit cleanup', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected clients/build/coral-backend.cjs to exist before running integration tests');
    }
    const flavor = 'prod';
    const otherFlavor = 'dev';
    const home = mkdtempSync(join(tmpdir(), `coral-retired-${flavor}-home-`));
    tempRoots.push(home);
    seedRetiredExpansion(home, flavor);
    seedRetiredExpansion(home, otherFlavor);

    const selectedEngine = writeSentinel(enginePaths(flavor, { baseDir: coralRoot(home) }).dataDir(RETIRED_ID), flavor);
    const selectedProjection = writeSentinel(join(kbRuntimeDir(home, flavor), RETIRED_ID), flavor);
    const selectedStaging = writeSentinel(join(kbRuntimeDir(home, flavor), `${RETIRED_ID}-staging`), flavor);
    const otherEngine = writeSentinel(
      enginePaths(otherFlavor, { baseDir: coralRoot(home) }).dataDir(RETIRED_ID),
      otherFlavor,
    );
    const otherProjection = writeSentinel(join(kbRuntimeDir(home, otherFlavor), RETIRED_ID), otherFlavor);

    const fixture = createPluginFixture(tempRoots, { flavor });
    const coordinator = spawnCoordinator({
      fixture,
      home,
      tempRoots,
      env: {
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
        CORAL_KB_EXTRA_LANGS: '',
      },
    });
    coordinators.push(coordinator);
    await waitForDiscoveryRecord(home, flavor, 15_000);

    const list = runBuiltCli(fixture, home, flavor, ['expansion', 'list']) as {
      status: string;
      packages: Array<{
        id: string;
        status: string;
        lastError?: string;
      }>;
    };
    expect(list.status).toBe('catalog');
    expect(list.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: RETIRED_ID,
          status: 'installed-not-active',
          lastError: expect.stringContaining(`coral-cli expansion remove-catalog ${RETIRED_ID}`),
        }),
      ]),
    );
    expect(readFileSync(selectedEngine, 'utf8')).toBe(flavor);
    expect(readFileSync(selectedProjection, 'utf8')).toBe(flavor);
    expect(readFileSync(selectedStaging, 'utf8')).toBe(flavor);
    expect(rowCount(home, flavor, 'expansion_state')).toBe(1);
    expect(cursorCount(home, flavor)).toBe(1);

    expect(runBuiltCli(fixture, home, flavor, ['expansion', 'remove-catalog', RETIRED_ID])).toEqual({
      status: 'uninstalled',
    });

    expect(existsSync(selectedEngine)).toBe(false);
    expect(existsSync(selectedProjection)).toBe(false);
    expect(existsSync(selectedStaging)).toBe(false);
    expect(rowCount(home, flavor, 'expansion_state')).toBe(0);
    expect(cursorCount(home, flavor)).toBe(0);

    expect(readFileSync(otherEngine, 'utf8')).toBe(otherFlavor);
    expect(readFileSync(otherProjection, 'utf8')).toBe(otherFlavor);
    expect(rowCount(home, otherFlavor, 'expansion_state')).toBe(1);
    expect(cursorCount(home, otherFlavor)).toBe(1);
  }, 20_000);
});
