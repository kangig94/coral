import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { observeProcessLiveness, probeProcessIncarnation } from '#src/infra/node-process.js';
import { supervisorLockPath } from '#src/infra/path/coordinator.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type AttemptRetry } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeResolvedStoreEpoch, inspectCurrentStore } from '#src/store/epoch.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
/** Coordinators a startup handoff launched, which no spawned handle owns. */
const handedOffPids: number[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  for (const root of roots) {
    const runDir = coordinatorFilesForHome(root, 'prod').runDir;
    if (!existsSync(supervisorLockPath(runDir))) continue;
    const launch = new SupervisorEvidence(runDir);
    try {
      const state = launch.read();
      for (const identity of [state.owner?.process, state.launch?.child, state.attempt?.child]) {
        if (identity === undefined || probeProcessIncarnation(identity.pid) !== identity.incarnation) continue;
        try {
          process.kill(identity.pid, 'SIGTERM');
        } catch {
          // The recorded process may have exited after observation.
        }
      }
    } finally {
      launch.close();
    }
  }
  const pids = handedOffPids.splice(0);
  for (const pid of pids) {
    if (observeProcessLiveness(pid) === 'alive') process.kill(pid, 'SIGTERM');
  }
  await waitForCondition(() => pids.every((pid) => observeProcessLiveness(pid) === 'absent'), 15_000);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function manifestOf(fixture: PluginFixture): StrictBundleManifest {
  return JSON.parse(
    readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf-8'),
  ) as StrictBundleManifest;
}

/**
 * The state a failed commit leaves when every reclaim fails: the incumbent recorded a same-build recovery grant
 * for its own epoch and exited, so only a startup of its build may serve from that epoch.
 */
async function recordRestartGrant(
  home: string,
  incumbent: Readonly<{ fixture: PluginFixture; pid: number; instanceId: string }>,
  target: PluginFixture,
  recoveryRetry: AttemptRetry,
): Promise<void> {
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const current = inspectCurrentStore(runtime);
  if (current.kind !== 'current') throw new Error(`incumbent store is ${current.kind}`);
  const incumbentBuild = manifestOf(incumbent.fixture);
  const owner = { instanceId: incumbent.instanceId, pid: incumbent.pid, incarnation: null };
  const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
    requestId: 'request-1',
    incumbent: {
      ...owner,
      version: incumbentBuild.version,
      bundleHash: incumbentBuild.bundleHash,
      flavor: incumbentBuild.flavor,
    },
    target: { build: manifestOf(target), pluginRootLabel: target.root },
    attemptId: 'restart-grant',
    attemptOwner: { kind: 'incumbent', ...owner },
    attemptChild: null,
    disposition: 'deferred',
    blockers: [{ owner: 'succession-commit', reason: 'same-build recovery after an injected failure' }],
    retryCondition: { kind: 'target-change', evidence: 'same-build recovery in progress' },
    attemptDeadline: null,
    completionReceipt: null,
    recoveryAttemptId: 'restart-grant',
    recoveryBuildSetId: incumbentBuild.buildSetId,
    recoveryRetry,
    successionPreparation: {
      version: 'v1',
      requestId: 'request-1',
      attemptId: 'restart-grant',
      incumbentInstanceId: incumbent.instanceId,
      incumbentPid: incumbent.pid,
      incumbentKey: 'restarted-incumbent',
      targetKey: 'restarted-target',
      capabilitiesKey: 'restarted-capabilities',
      epochKey: encodeResolvedStoreEpoch(runtime, current.epoch),
      admissionRevision: 0,
      accepts: [],
      receipts: [],
      stage: 'prepared',
      ready: null,
    },
  });
  if (written.kind !== 'written') throw new Error(`restart grant seed was ${written.kind}`);
}

/** Boots the old build, stops it, and leaves its restart grant for a newer build's startup to find. */
async function restartGrantScenario(recoveryRetry: AttemptRetry) {
  assertBuildArtifactsAvailable();
  const home = mkdtempSync(join(tmpdir(), 'coral-succession-grant-'));
  roots.push(home);
  const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
  const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
  const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
  coordinators.push(old);
  const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
  if (initial.instanceId === undefined) throw new Error('Incumbent discovery has no instance id.');
  await stopCoordinator(old);
  await recordRestartGrant(
    home,
    { fixture: oldFixture, pid: initial.pid, instanceId: initial.instanceId },
    newerFixture,
    recoveryRetry,
  );

  // The newer build finds the grant and hands startup to the grant's own build, which consumes it.
  const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
  coordinators.push(contender);
  try {
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== initial.pid && discovery.bundleHash === oldFixture.bundleHash;
    }, 20_000);
  } catch (error: unknown) {
    const record = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
    try {
      throw new Error(
        `Grant recovery did not serve: ${JSON.stringify({
          launch: record.read(),
          discovery: readDiscoveryRecordForHome(home, 'prod'),
          intent: readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir),
          contender: contender.output(),
        })}`,
        { cause: error },
      );
    } finally {
      record.close();
    }
  }
  const restarted = readDiscoveryRecordForHome(home, 'prod');
  if (restarted === null) throw new Error('The grant build did not serve.');
  handedOffPids.push(restarted.pid);
  return { home, oldFixture, newerFixture, restarted };
}

describe('succession restart grant discharge', () => {
  it('discharges a consumed restart grant so a later boot of the newer build serves itself', async () => {
    const { home, oldFixture, newerFixture, restarted } = await restartGrantScenario({ kind: 'target-change' });
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return observed.kind === 'readable' && observed.intent.incumbent.pid === restarted.pid;
    }, 30_000);
    expect(readUpgradeIntent(runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        attemptId: null,
        attemptOwner: null,
        recoveryAttemptId: null,
        successionPreparation: null,
        disposition: 'deferred',
        retryCondition: { kind: 'target-change' },
      },
    });

    process.kill(restarted.pid, 'SIGTERM');
    await waitForCondition(() => observeProcessLiveness(restarted.pid) === 'absent', 30_000);
    const second = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(second);
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== restarted.pid;
    }, 60_000);
    const served = readDiscoveryRecordForHome(home, 'prod');
    if (served === null) throw new Error('The second boot did not serve.');
    handedOffPids.push(served.pid);
    expect(served.bundleHash).toBe(newerFixture.bundleHash);
    expect(served.bundleHash).not.toBe(oldFixture.bundleHash);
  });

  it('applies the upgrade after a restart grant whose failure was transient is served', async () => {
    const { home, newerFixture, restarted } = await restartGrantScenario({ kind: 'transient', retryAfterMs: 1_000 });

    try {
      await waitForCondition(
        () => readDiscoveryRecordForHome(home, 'prod')?.bundleHash === newerFixture.bundleHash,
        15_000,
      );
    } catch (error) {
      throw new Error(
        `The upgrade did not apply after the restart: ${JSON.stringify(readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir))}`,
        { cause: error },
      );
    }
    const upgraded = readDiscoveryRecordForHome(home, 'prod');
    if (upgraded !== null) handedOffPids.push(upgraded.pid);
    await waitForCondition(() => observeProcessLiveness(restarted.pid) === 'absent', 30_000);
  });
});

describe('succession attempt prepared by an incumbent that died before committing', () => {
  it('retires the prepared attempt at startup so the upgrade then applies unattended', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-prepared-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    if (initial.instanceId === undefined) throw new Error('Incumbent discovery has no instance id.');
    await stopCoordinator(old);

    // What a reconciler pass leaves once `prepare` is recorded and before the commit records `attempting`.
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current') throw new Error(`incumbent store is ${current.kind}`);
    const incumbentBuild = manifestOf(oldFixture);
    const owner = { instanceId: initial.instanceId, pid: initial.pid, incarnation: null };
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        ...owner,
        version: incumbentBuild.version,
        bundleHash: incumbentBuild.bundleHash,
        flavor: incumbentBuild.flavor,
      },
      target: { build: manifestOf(newerFixture), pluginRootLabel: newerFixture.root },
      attemptId: 'prepared-attempt',
      attemptOwner: { kind: 'incumbent', ...owner },
      attemptChild: null,
      disposition: 'pending',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: {
        version: 'v1',
        requestId: 'request-1',
        attemptId: 'prepared-attempt',
        incumbentInstanceId: initial.instanceId,
        incumbentPid: initial.pid,
        incumbentKey: 'dead-incumbent',
        targetKey: 'prepared-target',
        capabilitiesKey: 'prepared-capabilities',
        epochKey: encodeResolvedStoreEpoch(runtime, current.epoch),
        admissionRevision: 0,
        accepts: [],
        receipts: [],
        stage: 'prepared',
        ready: null,
      },
    });
    if (written.kind !== 'written') throw new Error(`prepared attempt seed was ${written.kind}`);

    const restarted = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots, supervised: true });
    coordinators.push(restarted);
    try {
      await waitForCondition(
        () => readDiscoveryRecordForHome(home, 'prod')?.bundleHash === newerFixture.bundleHash,
        30_000,
      );
    } catch (error) {
      throw new Error(
        `The upgrade did not apply after the prepared attempt was retired: ${JSON.stringify(readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir))}`,
        { cause: error },
      );
    }
    const upgraded = readDiscoveryRecordForHome(home, 'prod');
    if (upgraded !== null) handedOffPids.push(upgraded.pid);
  });
});
