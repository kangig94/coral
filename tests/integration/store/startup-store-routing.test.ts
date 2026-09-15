import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  publishActiveStoreSelection,
  readActiveStoreSelection,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { epochPath, sweepStoreEpochs, STORE_EPOCH_METADATA_FILE_NAME } from '#src/store/epoch.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();

function manifest(version: string, buildSetId: string): StrictBundleManifest {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  return {
    version,
    buildSetId,
    bundleHash: digest('backend'),
    cliBundleHash: digest('cli'),
    claudeAppserverBundleHash: digest('appserver'),
    durableWrapperBundleHash: digest('wrapper'),
    flavor: 'prod',
    storeFormatFingerprint: storeFormat.fingerprint,
  };
}

function createBundle(root: string, build: StrictBundleManifest): string {
  const bundleDir = mkdtempSync(join(root, 'bundle-'));
  for (const [name, contents] of [
    ['coral-backend.cjs', 'backend'],
    ['coral-cli.cjs', 'cli'],
    ['coral-claude-appserver.cjs', 'appserver'],
    ['coral-durable-wrapper.cjs', 'wrapper'],
  ] as const) {
    writeFileSync(join(bundleDir, name), contents);
  }
  writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(build));
  return bundleDir;
}

function selection(build: StrictBundleManifest, bundleDir: string): ActiveStoreSelection {
  return {
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest: build,
    bundleDir,
    activeStoreFingerprint: build.storeFormatFingerprint,
  };
}

function harness(version = '2.0.0'): { runtime: Runtime; current: ActiveStoreSelection } {
  const root = mkdtempSync(join(tmpdir(), 'coral-startup-store-routing-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const build = manifest(version, '123e4567-e89b-42d3-a456-426614174000');
  return { runtime, current: selection(build, createBundle(root, build)) };
}

function publish(runtime: Runtime, selected: ActiveStoreSelection): void {
  const lockRoot = mkdtempSync(join(tmpdir(), 'coral-startup-selection-publish-'));
  roots.push(lockRoot);
  const lease = acquireDirectoryLockSync(join(lockRoot, 'lease.lock'), {
    storage: runtime.storage,
    time: runtime.time,
  });
  try {
    publishActiveStoreSelection(runtime, selected, lease.actuator);
  } finally {
    lease();
  }
}

function publishEpoch(runtime: Runtime, epoch: string, build: StrictBundleManifest): void {
  const directory = join(runtime.paths.coral.store.dbDir, `epoch-${epoch}`);
  openTestStoreDatabase({ path: join(directory, 'store.db'), storage: runtime.storage, storeFormat }).close();
  writeFileSync(
    join(directory, STORE_EPOCH_METADATA_FILE_NAME),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable', cause: 'test' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

async function route(runtime: Runtime, current: ActiveStoreSelection) {
  return routeOrOpenBackendStoreAtStartup({
    runtime,
    validateForeignTarget: createForeignTargetValidator(),
    options: {
      storeFormat: { ...storeFormat, productVersion: current.manifest.version },
      currentSelection: current,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('startup store routing', () => {
  it('carries the opened epoch across readiness so changing metadata cannot redirect the sweep', async () => {
    const { runtime, current } = harness();
    publishEpoch(runtime, '1', current.manifest);
    publishEpoch(runtime, '3', current.manifest);
    const newerMetadata = join(runtime.paths.coral.store.dbDir, 'epoch-3', STORE_EPOCH_METADATA_FILE_NAME);
    let metadataReads = 0;
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === newerMetadata && (metadataReads += 1) === 1) {
            throw Object.assign(new Error('injected settlement EIO'), { code: 'EIO' });
          }
          return subject.readFileSync(path, encoding);
        };
      },
    });
    const routedRuntime = { ...runtime, storage };

    const result = await route(routedRuntime, current);
    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    writeDiscoveryRecord(
      {
        pid: runtime.env.pid(),
        port: 1,
        socketPath: join(runtime.paths.coral.coordinator.runDir, 'live.sock'),
        bundleHash: current.manifest.bundleHash,
        flavor: runtime.flavor,
        namespace: 'startup-routing-test',
        startedAt: Date.now(),
        token: 'startup-routing-test',
        bootToken: 'startup-routing-test',
        storeEpoch: 'epoch' in result && typeof result.epoch === 'string' ? result.epoch : undefined,
      },
      runtime,
    );
    const sweepEpoch = 'epoch' in result && typeof result.epoch === 'string' ? result.epoch : '3';
    const sweep = sweepStoreEpochs(routedRuntime, runtime.paths.coral.store.dbDir, sweepEpoch);
    const openDatabasePresent = existsSync(epochPath(runtime.paths.coral.store.dbDir, '1'));
    console.log(
      `re-derivation-cell settlement=epoch-1 metadata-after=epoch-3 sweep=${sweepEpoch} open-database-present=${openDatabasePresent}`,
    );
    result.db.close();

    expect(result).toMatchObject({
      kind: 'open',
      epoch: '1',
      path: epochPath(runtime.paths.coral.store.dbDir, '1'),
    });
    expect(sweep).toBe('complete');
    expect(openDatabasePresent).toBe(true);
  });

  it('publishes epoch one when no store epoch is proven', async () => {
    const { runtime, current } = harness();
    publish(runtime, current);

    const result = await route(runtime, current);

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
    expect(existsSync(join(runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'))).toBe(true);
  });

  it('hands off to a valid newer selection without creating a store', async () => {
    const { runtime, current } = harness('1.0.0');
    const newer = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    publish(runtime, selection(newer, createBundle(dirname(current.bundleDir), newer)));

    const result = await route(runtime, current);

    expect(result.kind).toBe('handoff');
    expect(existsSync(join(runtime.paths.coral.store.dbDir, 'store.db'))).toBe(false);
  });

  it('retains invalid-selection evidence inside the generation coordination root', async () => {
    const { runtime, current } = harness('1.0.0');
    const newer = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    publish(runtime, selection(newer, join(dirname(current.bundleDir), 'missing-bundle')));
    const syncedDirectories: string[] = [];
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => {
          syncedDirectories.push(path);
          return subject.syncDirectoryDurableSync(path);
        };
      },
    });

    const result = await route({ ...runtime, storage }, current);

    expect(result.kind).toBe('reset-newer-invalid');
    if (result.kind === 'reset-newer-invalid') result.db.close();
    const retainedRoot = join(
      resolveGenerationBoundaryPaths(runtime).coordinationRoot,
      'retained-active-store-transitions',
    );
    expect(readdirSync(retainedRoot)).toHaveLength(1);
    expect(syncedDirectories).toContain(retainedRoot);
    expect(syncedDirectories).toContain(resolveGenerationBoundaryPaths(runtime).coordinationRoot);
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: current });
  });

  it('rejects retained transition success when its destination sync is unproven', async () => {
    const { runtime, current } = harness('1.0.0');
    const newer = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    publish(runtime, selection(newer, join(dirname(current.bundleDir), 'missing-bundle')));
    const retainedRoot = join(
      resolveGenerationBoundaryPaths(runtime).coordinationRoot,
      'retained-active-store-transitions',
    );
    const storage = new Proxy(runtime.storage, {
      get(subject, property, receiver) {
        if (property !== 'syncDirectoryDurableSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): boolean => (path === retainedRoot ? false : subject.syncDirectoryDurableSync(path));
      },
    });

    await expect(route({ ...runtime, storage }, current)).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: { cause: expect.stringContaining('Failed to durably retain active-store transition') },
    });
  });

  it('boots through the startup route when another process holds the adoption lock', async () => {
    const { runtime, current } = harness();
    const { adoptionLock } = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(dirname(adoptionLock), { recursive: true });
    const lease = acquireDirectoryLockSync(adoptionLock, { storage: runtime.storage, time: runtime.time });
    try {
      const result = await route(runtime, current);

      expect(result.kind).toBe('open');
      if (result.kind === 'open') result.db.close();
    } finally {
      lease();
    }
  }, 10_000);

  it('boots through the startup route when a dead owner leaves a fresh markerless adoption lock', async () => {
    const { runtime, current } = harness();
    const { adoptionLock } = resolveGenerationBoundaryPaths(runtime);
    mkdirSync(adoptionLock, { recursive: true });

    const result = await route(runtime, current);

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
  }, 10_000);
});
