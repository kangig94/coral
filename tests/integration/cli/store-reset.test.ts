import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listStoreResetIncidentsLocal,
  releaseStoreResetLocal,
  reportStoreResetLocal,
  type StoreResetCliDependencies,
} from '#src/cli/store-reset.js';
import { formatStoreEpochReport, formatStoreResetList } from '#src/cli/format/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { createStoreResetInspectionFs } from '#src/infra/store-reset-inspection-fs.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  discardCurrentStoreEpoch,
  epochPath,
  listStoreEpochHolders,
  settleStoreEpoch,
  storeEpochHolderPath,
  sweepStoreEpochs,
} from '#src/store/epoch.js';
import { releaseStoreReset as releaseStoreResetWithSocketGuard } from '#src/store/operator-store-reset.js';
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
  it('reports an unreadable store root as unobservable rather than empty', () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    mkdirSync(dbDir, { recursive: true });
    const parent = dirname(dbDir);
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: createStoreResetInspectionFs,
      quarantineRoot: () => join(dirname(parent), 'legacy-quarantine'),
      runtime: () => runtime,
    };
    chmodSync(parent, 0o600);
    let rendered: string;
    try {
      rendered = formatStoreResetList(listStoreResetIncidentsLocal('gen2', dependencies), 'gen2');
    } finally {
      chmodSync(parent, 0o700);
    }

    expect(rendered).toContain('unobservable');
    expect(rendered).not.toContain('No gen2 store epochs');
  });

  it('keeps a vanished symlink target unobservable through list and report resolution', async () => {
    const baseRuntime = harness();
    const configuredRoot = baseRuntime.paths.coral.store.dbDir;
    const targetRoot = join(dirname(configuredRoot), 'store-target');
    publishEpoch(targetRoot, '1');
    mkdirSync(dirname(configuredRoot), { recursive: true });
    symlinkSync(targetRoot, configuredRoot);
    let removed = false;
    const storage = new Proxy(baseRuntime.storage, {
      get(subject, property, receiver) {
        if (property !== 'realpathSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string): string => {
          if (!removed && path === configuredRoot) {
            removed = true;
            rmSync(targetRoot, { recursive: true });
          }
          return subject.realpathSync(path);
        };
      },
    });
    const runtime = { ...baseRuntime, storage };
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: createStoreResetInspectionFs,
      quarantineRoot: () => join(dirname(configuredRoot), 'legacy-quarantine'),
      runtime: () => runtime,
    };

    const listed = listStoreResetIncidentsLocal('gen2', dependencies);
    expect(listed.epochs).toEqual([
      expect.objectContaining({ epoch: 'unobservable', role: 'unobservable', epochJson: { kind: 'unreadable' } }),
    ]);
    expect(listed.holders).toEqual([{ id: 'unobservable', epoch: null, pid: null, state: 'unobservable' }]);
    expect(listed.residues).toEqual([{ name: 'unobservable', bytes: null, state: 'unobservable' }]);

    publishEpoch(targetRoot, '1');
    removed = false;
    await expect(reportStoreResetLocal('gen2', '1', dependencies)).rejects.toMatchObject({
      code: 'store_reset_reporting_failed',
    });
  });

  it('rejects release zero because the flat store is not addressable', () => {
    expect(() => releaseStoreResetLocal('gen2', 'prod', '0')).toThrowError(
      expect.objectContaining({ code: 'invalid_store_reset_release_incident_id' }),
    );
  });

  it('refuses only the current epoch', async () => {
    const runtime = harness();
    const opened = settleStoreEpoch(runtime, { storeFormat, build });
    opened.db.close();

    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: opened.store.epoch })).resolves.toMatchObject({
      kind: 'current',
      epoch: opened.store.epoch,
    });
  });

  it('releases a preserved epoch and reports an absent epoch', async () => {
    const runtime = harness();
    const opened = settleStoreEpoch(runtime, { storeFormat, build });
    opened.db.close();
    const discarded = discardCurrentStoreEpoch(runtime, { storeFormat, build });
    discarded.db.close();
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
      kind: 'released',
      epoch: '1',
    });
    await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '99' })).resolves.toMatchObject({
      kind: 'absent',
      epoch: '99',
    });
  });

  it('reports current, preserved, garbage, and malformed epochs without opening SQLite', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '2');
    publishEpoch(dbDir, '3');
    publishEpoch(dbDir, '4');
    writeFileSync(join(dbDir, 'epoch-4', 'epoch.json'), '{malformed');
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: createStoreResetInspectionFs,
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    for (const [epoch, role] of [
      ['3', 'current'],
      ['2', 'preserved'],
      ['1', 'garbage'],
      ['4', 'garbage'],
    ] as const) {
      const dbPath = epochPath(dbDir, epoch);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      const report = await reportStoreResetLocal('gen2', epoch, dependencies);
      if (report.kind !== 'epoch') throw new Error('expected epoch report');
      expect(report.epoch.role).toBe(role);
      const rendered = formatStoreEpochReport(report);
      expect(rendered).toContain(`- Database: \`epoch-${epoch}/store.db\``);
      expect(rendered).toContain(`command=sqlite3 \`<store-root>/epoch-${epoch}/store.db\` \`PRAGMA quick_check(1)\``);
      expect(rendered).not.toContain(dbDir);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    }
  });

  it('does not render raw metadata failures or stored absolute-path causes', async () => {
    const baseRuntime = harness();
    const dbDir = baseRuntime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    const metadataPath = join(dbDir, 'epoch-1', 'epoch.json');
    const rawCause = join(dbDir, 'private-source.db') + ': permission denied';
    writeFileSync(
      metadataPath,
      JSON.stringify({
        supersedes: null,
        classification: { kind: 'unavailable', cause: rawCause },
        build,
        publishedAt: '2026-09-15T00:00:00.000Z',
      }),
    );
    const dependencies = (runtime: typeof baseRuntime): StoreResetCliDependencies => ({
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: createStoreResetInspectionFs,
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    });

    const unavailable = await reportStoreResetLocal('gen2', '1', dependencies(baseRuntime));
    if (unavailable.kind !== 'epoch') throw new Error('expected epoch report');
    const unavailableOutput = formatStoreEpochReport(unavailable);
    expect(unavailableOutput).not.toContain(rawCause);
    expect(unavailableOutput).not.toContain(dbDir);

    const storage = new Proxy(baseRuntime.storage, {
      get(subject, property, receiver) {
        if (property !== 'readFileSync') return Reflect.get(subject, property, receiver) as unknown;
        return (path: string, encoding: 'utf-8'): string => {
          if (path === metadataPath) throw Object.assign(new Error(rawCause), { code: 'EACCES' });
          return subject.readFileSync(path, encoding);
        };
      },
    });
    const unreadable = await reportStoreResetLocal('gen2', '1', dependencies({ ...baseRuntime, storage }));
    if (unreadable.kind !== 'epoch') throw new Error('expected epoch report');
    const unreadableOutput = formatStoreEpochReport(unreadable);
    expect(unreadableOutput).toContain('- Epoch metadata: `unreadable`');
    expect(unreadableOutput).not.toContain(rawCause);
    expect(unreadableOutput).not.toContain(dbDir);
  });

  it('lists holder liveness as unknown and reaps a stale holder during the sweep', () => {
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

    expect(listStoreEpochHolders(runtime)).toEqual([
      { id: 'stale', epoch: '1', pid: 999_999_991, state: 'unobservable' },
    ]);
    expect(sweepStoreEpochs(runtime, dbDir, '3')).toBe('complete');
    expect(existsSync(holderPath)).toBe(false);
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
    expect(existsSync(epochPath(dbDir, '1'))).toBe(false);
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
