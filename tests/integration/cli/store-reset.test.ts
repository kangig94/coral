import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { epochPath, settleStoreEpoch, storeEpochHolderPath, sweepStoreEpochs } from '#src/store/epoch/index.js';
import { releaseStoreReset as releaseStoreResetWithSocketGuard } from '#src/store/operator-store-reset.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint, openTestStoreDatabase } from '#tests/helpers/store-db.js';

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

function releaseStoreReset(
  options: Omit<Parameters<typeof releaseStoreResetWithSocketGuard>[0], 'acquireSocketGuard'>,
) {
  return releaseStoreResetWithSocketGuard({
    ...options,
    acquireSocketGuard: async () => ({ release: async () => undefined }),
  });
}

function publishEpoch(dbDir: string, epoch: string): void {
  const directory = join(dbDir, `epoch-${epoch}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.lock'), '');
  openTestStoreDatabase({
    path: join(directory, 'store.db'),
    storage: createRealRuntime('prod').storage,
    storeFormat,
  }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'unavailable' },
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
    const opened = settleStoreEpoch(runtime, { storeFormat, build, authorizeMint: authorizeFixtureStoreMint });
    opened.db.close();

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: opened.store.epoch })).resolves.toMatchObject({
      kind: 'current',
      epoch: opened.store.epoch,
    });
  });

  it('reaps a stale holder despite pid reuse and remains complete on repeated retries', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    publishEpoch(dbDir, '5');
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
          return 'alive';
        };
      },
    });
    const reusedRuntime = { ...runtime, process };

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
        storeEpoch: '5',
      },
      runtime,
    );

    expect(sweepStoreEpochs(reusedRuntime, dbDir, '5')).toBe('complete');
    expect(sweepStoreEpochs(reusedRuntime, dbDir, '5')).toBe('complete');
    expect(observations).toBe(0);
    expect(existsSync(holderPath)).toBe(false);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
  });
});
