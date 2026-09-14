import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reportStoreResetLocal, type StoreResetCliDependencies } from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { discardCurrentStoreEpoch, epochPath, settleStoreEpoch } from '#src/store/epoch.js';
import { releaseStoreReset } from '#src/store/operator-store-reset.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build: StrictBundleManifest = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
  flavor: 'prod',
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness() {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-store-reset-cli-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publishEpoch(dbDir: string, epoch: string): void {
  const directory = join(dbDir, `epoch-${epoch}`);
  mkdirSync(directory, { recursive: true });
  openTestStoreDatabase({
    path: join(directory, 'store.db'),
    storage: createRealRuntime('prod').storage,
    storeFormat,
  }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: '0',
      classification: { kind: 'unavailable', cause: 'test' },
      build,
      publishedAt: '2026-09-15T00:00:00.000Z',
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store-reset operator epochs', () => {
  it('refuses only the current epoch', async () => {
    const runtime = harness();
    const opened = settleStoreEpoch(runtime, { storeFormat, build });
    opened.db.close();

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: opened.epoch })).resolves.toMatchObject({
      kind: 'current',
      epoch: opened.epoch,
    });
  });

  it('releases a preserved epoch and reports an absent epoch', async () => {
    const runtime = harness();
    const flat = epochPath(runtime.paths.coral.store.dbDir, '0');
    openTestStoreDatabase({ path: flat, storage: runtime.storage, storeFormat }).close();
    const discarded = discardCurrentStoreEpoch(runtime, { storeFormat, build });
    discarded.db.close();
    writeDiscoveryRecord(
      {
        pid: 999_999_991,
        port: 1,
        socketPath: join(runtime.paths.coral.coordinator.runDir, 'dead.sock'),
        bundleHash: 'dead-coordinator',
        flavor: runtime.flavor,
        namespace: 'dead-coordinator',
        startedAt: Date.now(),
        token: 'dead-coordinator',
        bootToken: 'dead-coordinator',
        version: '0.10.9',
      },
      runtime,
    );

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '0' })).resolves.toMatchObject({
      kind: 'released',
      epoch: '0',
    });
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '99' })).resolves.toMatchObject({
      kind: 'absent',
      epoch: '99',
    });
  });

  it('registers a report diagnostic holder before the child opens an epoch', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    writeDiscoveryRecord(
      {
        pid: 999_999_991,
        port: 1,
        socketPath: join(runtime.paths.coral.coordinator.runDir, 'dead.sock'),
        bundleHash: 'dead-coordinator',
        flavor: runtime.flavor,
        namespace: 'dead-coordinator',
        startedAt: Date.now(),
        token: 'dead-coordinator',
        bootToken: 'dead-coordinator',
        version: '0.10.9',
      },
      runtime,
    );
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: () => {
        throw new Error('legacy inspection is not used');
      },
      createDiagnosticRunner: () => {
        throw new Error('legacy diagnostics are not used');
      },
      diagnoseEpoch: async (_path, holderPath) => {
        expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toHaveLength(1);
        expect(holderPath.startsWith(dbDir)).toBe(true);
        await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
          kind: 'release-unproven',
        });
        return { integrity: 'ok', termination: 'completed', cleanup: 'not_required' };
      },
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    const report = await reportStoreResetLocal('gen2', '1', dependencies);

    expect(report.kind).toBe('epoch');
    expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toEqual([]);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
  });

  it('preserves a report holder when diagnostic child termination is unconfirmed', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: () => {
        throw new Error('legacy inspection is not used');
      },
      createDiagnosticRunner: () => {
        throw new Error('legacy diagnostics are not used');
      },
      diagnoseEpoch: async () => ({
        integrity: 'unavailable',
        termination: 'termination_unconfirmed',
        cleanup: 'not_required',
      }),
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    await expect(reportStoreResetLocal('gen2', '1', dependencies)).resolves.toMatchObject({ kind: 'epoch' });

    expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toHaveLength(1);
  });
});
