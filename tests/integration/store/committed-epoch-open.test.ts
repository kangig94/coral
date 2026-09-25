import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  listStoreEpochs,
  resolvedStoreEpoch,
  settleStoreEpoch,
} from '#src/store/epoch.js';
import {
  openCommittedBackendStoreAtStartup,
  prepareCommittedBackendStoreAtStartup,
} from '#src/store/startup-store-routing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const roots: string[] = [];
const format = currentCoralStoreFormat();
const build: StrictBundleManifest = {
  version: format.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod',
  storeFormatFingerprint: format.fingerprint,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('committed epoch open', () => {
  it('holds the agreed epoch when the selected format cannot open it, without minting', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-committed-open-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build });
    initial.db.close();

    const incompatibleFormat = {
      ...format,
      fingerprint: `sha256:${'0'.repeat(64)}` as const,
    };
    const result = openCommittedBackendStoreAtStartup(
      runtime,
      { storeFormat: incompatibleFormat, build: { ...build, storeFormatFingerprint: incompatibleFormat.fingerprint } },
      initial.store,
    );

    expect(result.kind).toBe('holding');
    expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toEqual(['1']);
  });

  it('opens only the full agreed epoch key', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-committed-open-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build });
    initial.db.close();

    const wrong = openCommittedBackendStoreAtStartup(
      runtime,
      { storeFormat: format, build },
      resolvedStoreEpoch(initial.store.storeRoot, '2'),
    );
    const wrongLineage = openCommittedBackendStoreAtStartup(
      runtime,
      { storeFormat: format, build },
      resolvedStoreEpoch(join(root, 'other-store'), '1'),
    );
    const reopened = openCommittedBackendStoreAtStartup(runtime, { storeFormat: format, build }, initial.store);

    expect(wrong).toEqual({ kind: 'holding', reason: 'epoch-unproven' });
    expect(wrongLineage).toEqual({ kind: 'holding', reason: 'epoch-unproven' });
    expect(reopened.kind).toBe('opened');
    if (reopened.kind === 'opened') {
      expect(reopened.store).toEqual(initial.store);
      reopened.db.close();
    }
    expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toEqual(['1']);
  });

  it('holds a proven epoch whose database was truncated instead of initializing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-committed-open-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build });
    initial.db.close();
    writeFileSync(initial.store.path, '');
    rmSync(`${initial.store.path}-wal`, { force: true });
    rmSync(`${initial.store.path}-shm`, { force: true });

    const result = openCommittedBackendStoreAtStartup(runtime, { storeFormat: format, build }, initial.store);

    expect(result.kind).toBe('holding');
    expect(statSync(initial.store.path).size).toBe(0);
    expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toEqual(['1']);
  });

  it('holds an attempt child open failure after read-only acceptance without minting', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-committed-open-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build });
    initial.db.close();
    const epochKey = encodeResolvedStoreEpoch(initial.store);
    const prepared = prepareCommittedBackendStoreAtStartup(runtime, { storeFormat: format, build }, epochKey);
    expect(prepared).toEqual({ kind: 'prepared', store: initial.store });
    if (prepared.kind !== 'prepared') return;

    writeFileSync(initial.store.path, '');
    rmSync(`${initial.store.path}-wal`, { force: true });
    rmSync(`${initial.store.path}-shm`, { force: true });
    const opened = openCommittedBackendStoreAtStartup(runtime, { storeFormat: format, build }, prepared.store);

    expect(opened.kind).toBe('holding');
    expect(statSync(initial.store.path).size).toBe(0);
    expect(listStoreEpochs(runtime).map(({ epoch }) => epoch)).toEqual(['1']);
  });

  it('prepares and opens the agreed epoch when a newer epoch is visible', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-committed-open-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build });
    initial.db.close();
    const newerDirectory = join(initial.store.storeRoot, 'epoch-2');
    mkdirSync(newerDirectory);
    copyFileSync(initial.store.path, join(newerDirectory, 'store.db'));
    copyFileSync(join(initial.store.storeRoot, 'epoch-1', 'epoch.json'), join(newerDirectory, 'epoch.json'));
    copyFileSync(join(initial.store.storeRoot, 'epoch-1', '.lock'), join(newerDirectory, '.lock'));
    expect(inspectCurrentStore(runtime)).toMatchObject({ kind: 'current', epoch: { epoch: '2' } });

    const prepared = prepareCommittedBackendStoreAtStartup(
      runtime,
      { storeFormat: format, build },
      encodeResolvedStoreEpoch(initial.store),
    );
    expect(prepared).toEqual({ kind: 'prepared', store: initial.store });
    if (prepared.kind !== 'prepared') return;
    const opened = openCommittedBackendStoreAtStartup(runtime, { storeFormat: format, build }, prepared.store);
    expect(opened.kind).toBe('opened');
    if (opened.kind === 'opened') {
      expect(opened.store).toEqual(initial.store);
      opened.db.close();
    }
    expect(listStoreEpochs(runtime).map(({ epoch }) => epoch).sort()).toEqual(['1', '2']);
  });
});
