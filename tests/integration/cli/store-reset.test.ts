import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reportStoreResetLocal, type StoreResetCliDependencies } from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  discardCurrentStoreEpoch,
  epochPath,
  listStoreEpochHolders,
  settleStoreEpoch,
  storeEpochHolderPath,
  sweepStoreEpochs,
} from '#src/store/epoch.js';
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
      diagnoseEpoch: async () => {
        const holder = readdirSync(dbDir).find((name) => name.startsWith('.epoch-holder-'));
        expect(holder).toBeDefined();
        expect(JSON.parse(readFileSync(join(dbDir, holder ?? ''), 'utf-8'))).toEqual({
          epoch: '1',
          pid: runtime.env.pid(),
        });
        await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
          kind: 'release-holder-live',
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

  it('removes a report holder when diagnostic child termination is unconfirmed', async () => {
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

    expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toEqual([]);
  });

  it('lists and reaps a stale holder only after rechecking its absent pid', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    const holderPath = storeEpochHolderPath(dbDir, 'stale');
    writeFileSync(holderPath, `${JSON.stringify({ epoch: '1', pid: 999_999_991 })}\n`);
    writeDiscoveryRecord(
      {
        pid: runtime.env.pid(),
        port: 1,
        socketPath: join(runtime.paths.coral.coordinator.runDir, 'live.sock'),
        bundleHash: 'current-coordinator',
        flavor: runtime.flavor,
        namespace: 'current-coordinator',
        startedAt: Date.now(),
        token: 'current-coordinator',
        bootToken: 'current-coordinator',
        version: '0.10.9',
      },
      runtime,
    );

    expect(listStoreEpochHolders(runtime)).toEqual([{ id: 'stale', epoch: '1', pid: 999_999_991, state: 'stale' }]);
    expect(sweepStoreEpochs(runtime, dbDir, '3')).toBe('complete');
    expect(existsSync(holderPath)).toBe(false);
  });

  it('does not reap a stale holder when its pid is reused before the deletion check', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    const reusedPid = 999_999_991;
    const holderPath = storeEpochHolderPath(dbDir, 'reused');
    writeFileSync(holderPath, `${JSON.stringify({ epoch: '1', pid: reusedPid })}\n`);
    let observations = 0;
    const process = new Proxy(runtime.process, {
      get(subject, property, receiver) {
        if (property !== 'observeLiveness') return Reflect.get(subject, property, receiver) as unknown;
        return (pid: number): 'absent' | 'alive' | 'unknown' => {
          if (pid !== reusedPid) return subject.observeLiveness(pid);
          observations += 1;
          return observations === 1 ? 'absent' : 'alive';
        };
      },
    });
    const reusedRuntime = { ...runtime, process };

    expect(sweepStoreEpochs(reusedRuntime, dbDir, '3')).toBe('live-holder');
    expect(observations).toBe(2);
    expect(existsSync(holderPath)).toBe(true);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
  });

  it('clears a malformed holder through release and succeeds on retry', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    const holderPath = storeEpochHolderPath(dbDir, 'malformed');
    writeFileSync(holderPath, '{');

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
      kind: 'release-holder-unobservable',
    });
    expect(existsSync(holderPath)).toBe(false);
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
      kind: 'released',
    });
  });
});
