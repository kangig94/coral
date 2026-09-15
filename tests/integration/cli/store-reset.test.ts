import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { reportStoreResetLocal, type StoreResetCliDependencies } from '#src/cli/store-reset.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { acquireSharedFileLockSync } from '#src/infra/fs-lock.js';
import { createNodeStoreResetDiagnosticSupervisor } from '#src/infra/store-reset-diagnostic-supervisor.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  discardCurrentStoreEpoch,
  epochPath,
  listStoreEpochHolders,
  settleStoreEpoch,
  storeEpochHolderPath,
  storeEpochLockPath,
  sweepStoreEpochs,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch.js';
import { releaseStoreReset as releaseStoreResetWithSocketGuard } from '#src/store/operator-store-reset.js';
import { SQLITE_DIAGNOSTIC_PROGRAM, superviseStoreResetDiagnosticChild } from '#src/store/reset-incident-diagnostic.js';
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('store-reset operator epochs', () => {
  it('records the diagnostic child pid before that child opens SQLite', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    const holderPath = storeEpochHolderPath(dbDir, 'real-child');

    await expect(
      superviseStoreResetDiagnosticChild(
        createNodeStoreResetDiagnosticSupervisor(),
        process.execPath,
        epochPath(dbDir, '1'),
        { path: holderPath, epoch: '1' },
      ),
    ).resolves.toEqual({ integrity: 'ok', termination: 'completed' });

    const holder = JSON.parse(readFileSync(holderPath, 'utf-8')) as { epoch: string; pid: number };
    expect(holder).toMatchObject({ epoch: '1', pid: expect.any(Number) });
    expect(holder.pid).not.toBe(runtime.env.pid());
    expect(runtime.process.observeLiveness(holder.pid)).toBe('absent');
  });

  it('keeps a diagnostic child holder live after its parent is killed', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    publishEpoch(dbDir, '1');
    publishEpoch(dbDir, '3');
    publishEpoch(dbDir, '5');
    const oldPath = epochPath(dbDir, '1');
    const holderPath = storeEpochHolderPath(dbDir, 'parent-killed');
    const programPath = join(dbDir, 'diagnostic-program.cjs');
    writeFileSync(programPath, SQLITE_DIAGNOSTIC_PROGRAM);
    const blocker = new DatabaseSync(oldPath);
    blocker.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE');
    const parent = spawn(
      process.execPath,
      [join(process.cwd(), 'tests/fixtures/store-reset-diagnostic-parent.cjs'), programPath, oldPath, holderPath, '1'],
      { stdio: 'ignore' },
    );
    try {
      await waitUntil(() => existsSync(holderPath));
      const holder = JSON.parse(readFileSync(holderPath, 'utf-8')) as { epoch: string; pid: number };
      expect(holder.pid).not.toBe(parent.pid);
      parent.kill('SIGKILL');
      await new Promise<void>((resolveExit) => parent.once('exit', () => resolveExit()));

      expect(runtime.process.observeLiveness(holder.pid)).toBe('alive');
      expect(await sweepStoreEpochsPostReady(runtime, dbDir, '5')).toBe('live-holder');
      expect(existsSync(oldPath)).toBe(true);
      console.log(`diagnostic-parent-sigkill-cell parent=absent child=${holder.pid} holder=live removed=false`);

      blocker.exec('ROLLBACK');
      blocker.close();
      await waitUntil(() => runtime.process.observeLiveness(holder.pid) === 'absent');
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      try {
        blocker.exec('ROLLBACK');
      } catch {
        // Already released on the primary path.
      }
      try {
        blocker.close();
      } catch {
        // Already closed on the primary path.
      }
    }
  });

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
    const baseRuntime = harness();
    const diagnosticPid = baseRuntime.env.pid() + 100_000;
    const runtime = {
      ...baseRuntime,
      process: new Proxy(baseRuntime.process, {
        get(subject, property, receiver) {
          if (property !== 'observeLiveness') return Reflect.get(subject, property, receiver) as unknown;
          return (pid: number) => (pid === diagnosticPid ? 'alive' : subject.observeLiveness(pid));
        },
      }),
    };
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
      diagnoseEpoch: async (_storeDbPath, holderRegistration) => {
        const holderLock = acquireSharedFileLockSync(storeEpochLockPath(dbDir, '1'));
        expect(holderRegistration).toBeDefined();
        try {
          runtime.storage.writeAtomicDurableSync(
            holderRegistration?.path ?? '',
            `${JSON.stringify({ epoch: holderRegistration?.epoch, pid: diagnosticPid })}\n`,
            { encoding: 'utf-8', mode: 0o600 },
          );
          const holder = readdirSync(dbDir).find((name) => name.startsWith('.epoch-holder-'));
          expect(holder).toBeDefined();
          expect(JSON.parse(readFileSync(join(dbDir, holder ?? ''), 'utf-8'))).toEqual({
            epoch: '1',
            pid: diagnosticPid,
          });
          await expect(releaseStoreReset({ target: 'gen2', runtime, epoch: '1' })).resolves.toMatchObject({
            kind: 'release-holder-live',
          });
          return { integrity: 'ok', termination: 'completed', cleanup: 'not_required' };
        } finally {
          holderLock();
        }
      },
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    const report = await reportStoreResetLocal('gen2', '1', dependencies);

    expect(report.kind).toBe('epoch');
    expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toEqual([]);
    expect(existsSync(epochPath(dbDir, '1'))).toBe(true);
  });

  it('retains a report holder when diagnostic child termination is unconfirmed', async () => {
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
      diagnoseEpoch: async (_storeDbPath, holderRegistration) => {
        runtime.storage.writeAtomicDurableSync(
          holderRegistration?.path ?? '',
          `${JSON.stringify({ epoch: holderRegistration?.epoch, pid: runtime.env.pid() + 100_000 })}\n`,
          { encoding: 'utf-8', mode: 0o600 },
        );
        return {
          integrity: 'unavailable',
          termination: 'termination_unconfirmed',
          cleanup: 'not_required',
        };
      },
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    await expect(reportStoreResetLocal('gen2', '1', dependencies)).resolves.toMatchObject({ kind: 'epoch' });

    expect(readdirSync(dbDir).filter((name) => name.startsWith('.epoch-holder-'))).toHaveLength(1);
  });

  it('does not inventory or diagnose a statically disproven store symlink', async () => {
    const runtime = harness();
    const dbDir = runtime.paths.coral.store.dbDir;
    const external = join(dbDir, '..', 'external.db');
    openTestStoreDatabase({ path: external, storage: runtime.storage, storeFormat }).close();
    mkdirSync(dbDir, { recursive: true });
    symlinkSync(external, epochPath(dbDir, '0'));
    let diagnostics = 0;
    const dependencies: StoreResetCliDependencies = {
      resolveIdentity: () => ({ ok: true, manifest: build }),
      createInspectionFs: () => {
        throw new Error('legacy inspection is not used');
      },
      createDiagnosticRunner: () => {
        throw new Error('legacy diagnostics are not used');
      },
      diagnoseEpoch: async () => {
        diagnostics += 1;
        return { integrity: 'ok', termination: 'completed', cleanup: 'not_required' };
      },
      quarantineRoot: () => join(dbDir, 'store-reset-quarantine'),
      runtime: () => runtime,
    };

    const report = await reportStoreResetLocal('gen2', '0', dependencies);

    expect(report).toMatchObject({ kind: 'epoch', epoch: { bytes: null }, diagnostic: { integrity: 'unavailable' } });
    expect(diagnostics).toBe(0);
    expect(existsSync(external)).toBe(true);
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
