import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import { createForeignTargetValidator } from '#src/infra/handoff-target.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  publishActiveStoreSelection,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';
import { encodeResolvedStoreEpoch, STORE_EPOCH_METADATA_FILE_NAME } from '#src/store/epoch/index.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint, openTestStoreDatabase } from '#tests/helpers/store-db.js';

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
    ['coral-cli', 'cli'],
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
      classification: { kind: 'unavailable' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

async function runStoreCapabilityFixture(root: string, store: string, version: string): Promise<{ epoch: string }> {
  const bundle = join(root, 'kb-daemon-store-capability.mjs');
  await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'kb-daemon-store-capability.ts',
      loader: 'ts',
      contents: `
        import { createKbDaemonWriteRuntimeHost } from '#src/kb-daemon/runtime-host.js';
        import { createRealRuntime } from '#src/runtime/real.js';
        import { decodeResolvedStoreEpoch } from '#src/store/epoch/index.js';
        const runtime = createRealRuntime('prod', { baseDir: process.env.CORAL_TEST_BASE_DIR });
        const store = decodeResolvedStoreEpoch(runtime, process.env.CORAL_KB_DAEMON_STORE);
        const host = createKbDaemonWriteRuntimeHost({
          pluginRoot: process.cwd(),
          backendNamespace: 'store-capability-fixture',
          bundleHash: 'store-capability-fixture',
          curateUsageBudget: { isExhausted: async () => false },
          runtime,
          store,
        });
        try {
          const observation = await host.withKb(({ db }) => {
            const epoch = db.prepare('SELECT epoch FROM epoch_marker').get()?.epoch ?? null;
            db.exec('CREATE TABLE daemon_marker (value TEXT NOT NULL)');
            db.prepare('INSERT INTO daemon_marker (value) VALUES (?)').run('opened-by-daemon');
            return { epoch };
          });
          process.stdout.write(JSON.stringify(observation));
        } finally {
          await host.dispose();
        }
      `,
    },
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
      authorizeMint: authorizeFixtureStoreMint,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('startup store routing', () => {
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
      encodeResolvedStoreEpoch(runtime, result.store),
      current.manifest.version,
    );
    const daemonMarker = result.db.prepare<[], { value: string }>('SELECT value FROM daemon_marker').get()?.value;
    const configuredTarget = realpathSync(configuredRoot) === newRoot ? 'new' : 'old';
    result.db.close();

    expect(coordinatorEpoch).toBe('1');
    expect(daemon).toEqual({ epoch: '1' });
    expect(daemonMarker).toBe('opened-by-daemon');
    expect(configuredTarget).toBe('new');
  });

  it('hands off to a valid newer selection without creating a store', async () => {
    const { runtime, current } = harness('1.0.0');
    const newer = manifest('2.0.0', '223e4567-e89b-42d3-a456-426614174000');
    publish(runtime, selection(newer, createBundle(dirname(current.bundleDir), newer)));

    const result = await route(runtime, current);

    expect(result.kind).toBe('handoff');
    expect(existsSync(join(runtime.paths.coral.store.dbDir, 'store.db'))).toBe(false);
  });

  it('refuses a rejected current transition without discarding its evidence', async () => {
    const { root, runtime, current } = harness();
    publish(runtime, current);
    const paths = resolveActiveStoreRecordPaths(runtime);
    const evidencePath = join(root, 'linked-transition-evidence');
    writeFileSync(evidencePath, 'linked transition evidence');
    symlinkSync(evidencePath, paths.transitionFile);

    await expect(route(runtime, current)).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: { record: 'transition', failureCode: 'record_link' },
    });
    expect(readFileSync(paths.transitionFile, 'utf8')).toBe('linked transition evidence');
  });

  it('refuses an unsafe active-store coordination directory', async () => {
    const { root, runtime, current } = harness();
    const { coordinationRoot } = resolveActiveStoreRecordPaths(runtime);
    const target = join(root, 'linked-coordination-root');
    mkdirSync(dirname(coordinationRoot), { recursive: true });
    mkdirSync(target);
    symlinkSync(target, coordinationRoot);

    await expect(route(runtime, current)).rejects.toMatchObject({
      code: 'active_store_coordination_invalid',
      context: { record: 'transition', failureCode: 'coordination_directory_link' },
    });
    expect(realpathSync(coordinationRoot)).toBe(target);
  });
});
