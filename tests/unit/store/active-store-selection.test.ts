import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { acquireDirectoryLockSync } from '#src/infra/fs-lock.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_VERSION,
  publishActiveStoreSelection,
  readActiveStoreSelection,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
} from '#src/store/active-store-selection.js';

const roots: string[] = [];

function publicationActuator(runtime: Runtime) {
  const lockRoot = mkdtempSync(join(tmpdir(), 'coral-selection-publish-'));
  roots.push(lockRoot);
  return acquireDirectoryLockSync(join(lockRoot, 'lease.lock'), {
    storage: runtime.storage,
    time: runtime.time,
  }).actuator;
}
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function harness(): {
  readonly runtime: Runtime;
  readonly bundleDir: string;
  readonly selection: ActiveStoreSelection;
} {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-active-selection-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  const bundleDir = join(baseDir, 'bundle');
  mkdirSync(bundleDir, { mode: 0o700 });
  const selection: ActiveStoreSelection = {
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest,
    bundleDir,
    activeStoreFingerprint: manifest.storeFormatFingerprint,
  };
  return { runtime, bundleDir, selection };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store-selection', () => {
  it('publishes a selection readable through the public boundary', () => {
    const { runtime, selection } = harness();
    publishActiveStoreSelection(runtime, selection, publicationActuator(runtime));

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
  });

  it('rejects a selection record with non-private permissions', () => {
    const { runtime, selection } = harness();
    publishActiveStoreSelection(runtime, selection, publicationActuator(runtime));
    chmodSync(resolveActiveStoreRecordPaths(runtime).selectionFile, 0o755);

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'rejected', failureCode: 'record_mode' });
  });
});
