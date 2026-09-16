import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
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
import {
  encodeResolvedStoreEpoch,
  epochPath,
  sweepStoreEpochs,
  STORE_EPOCH_METADATA_FILE_NAME,
} from '#src/store/epoch.js';
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

function harness(version = '2.0.0'): { root: string; runtime: Runtime; current: ActiveStoreSelection } {
  const root = mkdtempSync(join(tmpdir(), 'coral-startup-store-routing-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const build = manifest(version, '123e4567-e89b-42d3-a456-426614174000');
  return { root, runtime, current: selection(build, createBundle(root, build)) };
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
  publishEpochAtRoot(runtime, runtime.paths.coral.store.dbDir, epoch, build);
}

function publishEpochAtRoot(runtime: Runtime, storeRoot: string, epoch: string, build: StrictBundleManifest): void {
  const directory = join(storeRoot, `epoch-${epoch}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.lock'), '');
  const db = openTestStoreDatabase({ path: join(directory, 'store.db'), storage: runtime.storage, storeFormat });
  db.exec('CREATE TABLE epoch_marker (epoch TEXT NOT NULL)');
  db.prepare('INSERT INTO epoch_marker (epoch) VALUES (?)').run(epoch);
  db.close();
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

async function runStoreCapabilityFixture(root: string, store: string, version: string): Promise<{ epoch: string }> {
  const fixture = fileURLToPath(new URL('../../fixtures/kb-daemon-store-capability.ts', import.meta.url));
  const bundle = join(root, 'kb-daemon-store-capability.mjs');
  await build({
    entryPoints: [fixture],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    loader: { '.sql': 'text' },
    define: { __VERSION__: JSON.stringify(version) },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const child = spawn(process.execPath, [bundle], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORAL_TEST_BASE_DIR: root,
      CORAL_KB_DAEMON_STORE: store,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`Store capability fixture exited ${String(exitCode)}: ${stderr}`);
  return JSON.parse(stdout) as { epoch: string };
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
        storeEpoch: result.store.epoch,
      },
      runtime,
    );
    const sweepEpoch = result.store.epoch;
    const sweep = sweepStoreEpochs(routedRuntime, runtime.paths.coral.store.dbDir, sweepEpoch);
    const openDatabasePresent = existsSync(epochPath(runtime.paths.coral.store.dbDir, '1'));
    console.log(
      `re-derivation-cell settlement=epoch-1 metadata-after=epoch-3 sweep=${sweepEpoch} open-database-present=${openDatabasePresent}`,
    );
    result.db.close();

    expect(result).toMatchObject({
      kind: 'open',
      store: {
        epoch: '1',
        path: epochPath(runtime.paths.coral.store.dbDir, '1'),
      },
    });
    expect(sweep).toBe('complete');
    expect(openDatabasePresent).toBe(true);
  });

  it('hands the settled store capability to a real daemon process across a root retarget', async () => {
    const { root, runtime, current } = harness();
    const configuredRoot = runtime.paths.coral.store.dbDir;
    const oldRoot = join(root, 'old-store-root');
    const newRoot = join(root, 'new-store-root');
    publishEpochAtRoot(runtime, oldRoot, '1', current.manifest);
    publishEpochAtRoot(runtime, newRoot, '2', current.manifest);
    mkdirSync(dirname(configuredRoot), { recursive: true });
    symlinkSync(oldRoot, configuredRoot);
    publish(runtime, current);

    const result = await route(runtime, current);
    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    const coordinatorEpoch = result.db.prepare<[], { epoch: string }>('SELECT epoch FROM epoch_marker').get()?.epoch;

    rmSync(configuredRoot);
    symlinkSync(newRoot, configuredRoot);
    const daemon = await runStoreCapabilityFixture(
      root,
      encodeResolvedStoreEpoch(result.store),
      current.manifest.version,
    );
    const daemonMarker = result.db.prepare<[], { value: string }>('SELECT value FROM daemon_marker').get()?.value;
    const configuredTarget = realpathSync(configuredRoot) === newRoot ? 'new' : 'old';
    console.log(
      `coordinator-daemon-retarget-cell coordinator=${String(coordinatorEpoch)} daemon=${daemon.epoch} same-database=${String(daemonMarker === 'opened-by-daemon')} configured-root=${configuredTarget}`,
    );
    result.db.close();

    expect(coordinatorEpoch).toBe('1');
    expect(daemon).toEqual({ epoch: '1' });
    expect(daemonMarker).toBe('opened-by-daemon');
    expect(configuredTarget).toBe('new');
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
