import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import { ACTIVE_STORE_SELECTION_VERSION, publishActiveStoreSelection } from '#src/store/active-store-selection.js';
import { classifyStoreFile } from '#src/store/db.js';
import { observeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { commit } from '#src/store/append.js';
import { executionHarness, requestedExecution } from '#tests/helpers/job-executions.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { retainedExecutionsFixture } from '#tests/helpers/retained-executions.js';
import { buildReleasedStorageReader } from '#tests/helpers/released-storage-reader.js';
import {
  createPluginFixture,
  createShippedPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  waitForProcessExit,
  readDiscoveryRecordForHome,
  coordinatorFilesForHome,
  shippedCliEnvironment,
  type SpawnedCoordinator,
  type PluginFixture,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children: SpawnedCoordinator[] = [];
const homes: Array<{ home: string; fixture: PluginFixture }> = [];

afterEach(async () => {
  for (const { home, fixture } of homes.splice(0)) {
    // The HOME points exclusively at a home created by this test.
    if (readDiscoveryRecordForHome(home, 'prod') !== null)
      spawnSync(process.execPath, [join(fixture.root, 'bridge', 'coral-cli'), 'backend', 'shutdown'], {
        env: shippedCliEnvironment({ HOME: home, TMPDIR: home }),
        encoding: 'utf8',
        timeout: 15_000,
      });
  }
  for (const child of children.splice(0)) await stopCoordinator(child);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function select(f: ReturnType<typeof retainedExecutionsFixture>, bundle: PluginFixture): StrictBundleManifest {
  const manifest = JSON.parse(
    readFileSync(join(bundle.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
  ) as StrictBundleManifest;
  expect(manifest.storeFormatFingerprint).toBe(f.fingerprint);
  const lease = acquireDirectoryLockSync(join(f.root, 'selection.lock'), {
    storage: f.runtime.storage,
    time: f.runtime.time,
  });
  try {
    publishActiveStoreSelection(
      f.runtime,
      {
        version: ACTIVE_STORE_SELECTION_VERSION,
        manifest,
        bundleDir: join(bundle.root, 'bridge'),
        activeStoreFingerprint: f.fingerprint,
      },
      lease.actuator,
    );
  } finally {
    lease();
  }
  return manifest;
}

function pendingSecondRequest(f: ReturnType<typeof retainedExecutionsFixture>): number {
  expect(
    seedHistoricalEpoch(f.runtime, f.index, f.epoch, f.epochKey, f.fingerprint, f.jobsRoot, f.runtime.storage, [], true)
      .kind,
  ).toBe('complete');
  expect(f.index.resultsReleased(f.epochKey)).toBe(true);
  const db = newRawDatabase(f.epoch.path);
  const template = executionHarness();
  try {
    f.index.withAdmissionGuard(f.epochKey, db, () => {
      f.index.prepareAdmission(f.jobId, 2, f.epochKey, f.index.read(f.jobId)!.subject);
      expect(f.index.certificate(f.epochKey)).toBeNull();
      commit(
        db,
        (c) => {
          c.append(requestedExecution(2));
          return undefined;
        },
        { ...template.ctx, beforeAppend: (input) => f.index.beforeAppend(input, f.epochKey) },
      );
    });
    expect(f.index.read(f.jobId)).toMatchObject({ disposition: 'active-owner', latestExecution: 2, openExecution: 2 });
    expect(f.index.resultsReleased(f.epochKey)).toBe(false);
    return db.prepare<[], { seq: number }>('SELECT MAX(seq) AS seq FROM events').get()!.seq;
  } finally {
    db.close();
    template.db.close();
  }
}

function sourceSnapshot(f: ReturnType<typeof retainedExecutionsFixture>) {
  const epoch = observeResolvedStoreEpoch(f.runtime, f.epochKey);
  if (epoch === undefined) throw new Error('Retained source identity is unavailable');
  const db = newRawDatabase(epoch.path, { readonly: true });
  try {
    return db.prepare('SELECT seq,type,hex(body) AS body FROM events ORDER BY seq').all();
  } finally {
    db.close();
  }
}

describe('jobs store generation with the shipped v0.10.21 bundle', () => {
  it('classifies the shipped predecessor as older-incompatible and current state as newer-incompatible in shipped code', async () => {
    const f = retainedExecutionsFixture(roots);
    const old = createShippedPluginFixture(roots, 'v0.10.21');
    expect(old.storeFormatFingerprint).toBe('sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521');
    expect(old.storeFormatFingerprint).not.toBe(f.fingerprint);
    const oldPath = join(f.root, 'old.db');
    const db = newRawDatabase(oldPath);
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO meta VALUES (?,?)').run('store_format_fingerprint', old.storeFormatFingerprint);
    db.prepare('INSERT INTO meta VALUES (?,?)').run('store_product_version', old.version);
    db.close();
    expect(
      classifyStoreFile(oldPath, f.runtime.storage, { ...currentCoralStoreFormat(), productVersion: '0.10.22' }).kind,
    ).toBe('older-incompatible');
    const outfile = join(f.root, 'old-classification.mjs');
    await buildReleasedStorageReader('v0.10.21', outfile, 'export {classifyStoreFile} from "#src/store/db.js";');
    const shipped = (await import(pathToFileURL(outfile).href)) as { classifyStoreFile: typeof classifyStoreFile };
    expect(
      shipped.classifyStoreFile(f.epoch.path, f.runtime.storage, {
        fingerprint: 'sha256:ca97b533a127b1475b45a487793ab7183ae70620894d1ca36e193431065b2521',
        productVersion: old.version,
      }).kind,
    ).toBe('newer-incompatible');
  });

  it('hands shipped-old startup to an available newer bundle and preserves pending execution evidence', async () => {
    const { f, before, newer, selected, handle } = rollbackFixture(true);
    homes.push({ home: f.root, fixture: newer });
    expect(await waitForProcessExit(handle, 30_000)).toEqual({ code: 0, signal: null });
    await waitForCondition(
      () => readDiscoveryRecordForHome(f.root, 'prod')?.bundleHash === selected.bundleHash,
      30_000,
    );
    expect(handle.output()).not.toContain('Fatal startup error');
    expect(existsSync(coordinatorFilesForHome(f.root, 'prod').startupErrorFile)).toBe(false);
    expectPendingEvidence(f, before);
  }, 90_000);

  it('preserves pending current-format evidence when shipped-old startup recovers an unavailable selected bundle', async () => {
    const { f, before, handle, old } = rollbackFixture(false);
    homes.push({ home: f.root, fixture: old });
    await waitForCondition(() => readDiscoveryRecordForHome(f.root, 'prod')?.bundleHash === old.bundleHash, 30_000);
    expect(handle.output()).toContain('Recovered the newer-incompatible active store');
    expect(handle.output()).not.toContain('Fatal startup error');
    const files = coordinatorFilesForHome(f.root, 'prod');
    expect(existsSync(files.startupErrorFile)).toBe(false);
    expectPendingEvidence(f, before);
    expect(sourceSnapshot(f)).toEqual(before);
    expect(f.index.read(f.jobId)).toMatchObject({ latestExecution: 2, openExecution: 2 });
  }, 90_000);
});

function rollbackFixture(available: boolean) {
  const f = retainedExecutionsFixture(roots, 1);
  pendingSecondRequest(f);
  const before = sourceSnapshot(f);
  const newer = createPluginFixture(roots, { flavor: 'prod', version: '0.10.22', accepts: 'bundled' });
  const selected = select(f, newer);
  const old = createShippedPluginFixture(roots, 'v0.10.21');
  if (!available) renameSync(join(newer.root, 'bridge'), join(newer.root, 'unavailable-bridge'));
  const handle = spawnCoordinator({
    fixture: old,
    home: f.root,
    tempRoots: roots,
    env: {
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((name) => name.startsWith('CORAL_'))
          .map((name) => [name, undefined]),
      ),
      CORAL_KB_PATH: join(f.root, 'kb'),
    },
  });
  children.push(handle);
  return { f, before, newer, selected, handle, old };
}

function expectPendingEvidence(
  f: ReturnType<typeof retainedExecutionsFixture>,
  before: ReturnType<typeof sourceSnapshot>,
) {
  expect(f.index.read(f.jobId)?.executions?.[0]?.detail.exit?.content).toBe('result #1');
  const after = sourceSnapshot(f);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.slice(before.length).every((row) => (row as { type: string }).type !== 'job.terminal.recorded')).toBe(
    true,
  );
}
