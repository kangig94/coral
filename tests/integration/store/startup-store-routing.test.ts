import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  readActiveStoreSelection,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { routeOrOpenBackendStoreAtStartup } from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

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
  it('opens epoch zero for the current selection', async () => {
    const { runtime, current } = harness();
    publish(runtime, current);

    const result = await route(runtime, current);

    expect(result.kind).toBe('open');
    if (result.kind === 'open') result.db.close();
    expect(existsSync(join(runtime.paths.coral.store.dbDir, 'store.db'))).toBe(true);
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

    const result = await route(runtime, current);

    expect(result.kind).toBe('reset-newer-invalid');
    if (result.kind === 'reset-newer-invalid') result.db.close();
    const retainedRoot = join(
      resolveGenerationBoundaryPaths(runtime).coordinationRoot,
      'retained-active-store-transitions',
    );
    expect(readdirSync(retainedRoot)).toHaveLength(1);
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection: current });
  });
});
