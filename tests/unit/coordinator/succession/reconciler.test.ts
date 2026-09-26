import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import { SUCCESSION_METHODS } from '#src/infra/succession-address.js';
import { successionTargetKey } from '#src/coordinator/succession/protocol.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const runtime = createRealRuntime('prod', { baseDir: tmpdir() });

const build = {
  version: '0.11.0',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

/** A pid whose process has exited, so its absence is decisive. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.pid === undefined) throw new Error('exited child has no pid');
  return child.pid;
}

const serving = {
  instanceId: 'serving',
  pid: process.pid,
  incarnation: probeProcessIncarnation(process.pid),
  version: '0.10.13',
  bundleHash: 'fedcba9876543210',
  flavor: 'prod' as const,
};

/** An intent with no attempt, left by an earlier incumbent under a hold only a newer target ends. */
async function seedHeldIntent(
  runDir: string,
  incumbent: UpgradeIntent['incumbent'],
  targetVersion = build.version,
): Promise<UpgradeIntent> {
  const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
    requestId: 'request-1',
    incumbent,
    target: { build: { ...build, version: targetVersion }, pluginRootLabel: '/missing/target' },
    attemptId: null,
    attemptOwner: null,
    disposition: 'deferred',
    blockers: [
      { owner: 'succession-startup', reason: 'abandoned after 3 startups: attempt process deaths are unproven' },
    ],
    retryCondition: { kind: 'target-change', evidence: 'abandoned incomplete succession attempt' },
    attemptDeadline: null,
    completionReceipt: null,
  });
  if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
  return seeded.intent;
}

function servingReconciler(runDir: string) {
  return createSuccessionReconciler({
    runtime,
    runDir,
    incumbent: () => serving,
    owners: [],
    epochKey: () => 'serving-epoch',
    admissionRevision: () => 0,
    commitAvailable: true,
  });
}

describe('succession reconciler', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a commit-incapable incumbent intent claimable by a legacy waiter', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      }),
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
    });
    try {
      expect(
        await reconciler.request({
          requestId: 'legacy-request',
          target: { build, pluginRootLabel: '/missing/target' },
        }),
      ).toMatchObject({ kind: 'registered' });
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'deferred',
        reason: 'incumbent needs a legacy retirement waiter',
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: { attemptOwner: null, attemptId: null },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('declares commit incapability to a contender before it exits', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const coordinator = createSuccessionCoordinator({
      runtime,
      runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      }),
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
    });
    try {
      expect(
        await coordinator.dispatch(SUCCESSION_METHODS.request, {
          requestId: 'request-1',
          target: { build, pluginRootLabel: '/installed/target' },
        }),
      ).toMatchObject({ kind: 'registered', incumbentCanCommit: false });
    } finally {
      coordinator.reconciler.dispose();
    }
  });

  it('reconciles a registered intent and does not rewrite an unchanged hold on retry', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const onIntentChanged = vi.fn();
    const unsubscribe = vi.fn();
    let notify: (() => void) | undefined;
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      }),
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
      commitAvailable: true,
      onIntentChanged,
      subscribeObligationChanges: (callback) => {
        notify = callback;
        return unsubscribe;
      },
    });
    try {
      expect(
        await reconciler.request({
          requestId: 'request-1',
          target: { build, pluginRootLabel: '/missing/target' },
        }),
      ).toMatchObject({ kind: 'registered' });
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'refused',
        reason: 'target build no longer validates',
      });
      const first = readUpgradeIntent(runDir);
      expect(first).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'deferred', retryCondition: { kind: 'target-change' } },
      });
      if (first.kind !== 'readable') throw new Error('intent not readable');

      notify?.();
      expect(await reconciler.reconcile()).toMatchObject({ kind: 'refused' });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: { revision: first.intent.revision },
      });
    } finally {
      reconciler.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onIntentChanged).toHaveBeenCalledTimes(2);
  });

  it('holds the next attempt through an obligation wake until a transient backoff ends, then wakes itself', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const incumbent = {
      instanceId: 'incumbent',
      pid: 1234,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod' as const,
    };
    const target = { build, pluginRootLabel: '/missing/target' };
    const retryAfterMs = Date.now() + 1_500;
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent,
      target,
      attemptId: null,
      attemptOwner: null,
      disposition: 'deferred',
      blockers: [{ owner: 'succession-commit', reason: 'Successor missed its serving deadline.' }],
      retryCondition: { kind: 'attempt-expiry', evidence: 'transient attempt failure 1 of 6' },
      attemptDeadline: null,
      completionReceipt: null,
      transientRetry: {
        targetKey: successionTargetKey(target),
        failures: 1,
        retryAfter: new Date(retryAfterMs).toISOString(),
      },
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    let notify: (() => void) | undefined;
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => incumbent,
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
      commitAvailable: true,
      subscribeObligationChanges: (callback) => {
        notify = callback;
        return () => undefined;
      },
    });
    try {
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'deferred',
        reason: expect.stringContaining('backs off until'),
      });
      notify?.();
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'deferred',
        reason: expect.stringContaining('backs off'),
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { revision: seeded.intent.revision } });

      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.revision > seeded.intent.revision;
      }, 10_000);
      expect(Date.now()).toBeGreaterThanOrEqual(retryAfterMs);
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { blockers: [{ owner: 'target', reason: 'target build no longer validates' }] },
      });
    } finally {
      reconciler.dispose();
    }
  });
  it('adopts the intent of an exited incumbent and keeps the hold its target is under', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const exited = { ...serving, instanceId: 'exited', pid: await exitedPid(), incarnation: null };
    const seeded = await seedHeldIntent(runDir, exited);
    const reconciler = servingReconciler(runDir);
    try {
      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.incumbent.instanceId === serving.instanceId;
      }, 5_000);
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: {
          incumbent: serving,
          disposition: 'deferred',
          blockers: seeded.blockers,
          retryCondition: seeded.retryCondition,
        },
      });
      expect(await reconciler.reconcile()).toEqual({
        kind: 'deferred',
        reason: 'successor target must change after failed attempt',
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('closes an adopted intent whose target no longer outranks the adopting incumbent', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const exited = { ...serving, instanceId: 'exited', pid: await exitedPid(), incarnation: null };
    await seedHeldIntent(runDir, exited, serving.version);
    const reconciler = servingReconciler(runDir);
    try {
      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.disposition === 'closed';
      }, 5_000);
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { incumbent: serving, retryCondition: null } });
    } finally {
      reconciler.dispose();
    }
  });

  it('closes an intent recorded against an incumbent that already runs its target', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    await seedHeldIntent(runDir, serving, serving.version);
    const reconciler = servingReconciler(runDir);
    try {
      expect(await reconciler.reconcile()).toEqual({
        kind: 'refused',
        reason: 'target does not strictly outrank the incumbent',
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { disposition: 'closed' } });
    } finally {
      reconciler.dispose();
    }
  });

  it('leaves the intent of an incumbent that is still alive to that incumbent and records why, once', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const alive = { ...serving, instanceId: 'alive' };
    const seeded = await seedHeldIntent(runDir, alive);
    const reconciler = servingReconciler(runDir);
    const reason = `recorded incumbent alive (pid ${process.pid}) is alive; adoption waits until its exit is proven`;
    try {
      expect(await reconciler.reconcile()).toEqual({ kind: 'deferred', reason });
      expect(await reconciler.reconcile()).toEqual({ kind: 'deferred', reason });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: {
          revision: seeded.revision + 1,
          incumbent: alive,
          blockers: [...seeded.blockers, { owner: 'succession-adoption', reason }],
          retryCondition: seeded.retryCondition,
        },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('removes the adoption hold once the recorded incumbent is proven gone', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const exited = { ...serving, instanceId: 'exited', pid: await exitedPid(), incarnation: null };
    const seeded = await seedHeldIntent(runDir, exited);
    const held = await compareAndSwapUpgradeIntent(runDir, seeded.revision, {
      ...seeded,
      blockers: [...seeded.blockers, { owner: 'succession-adoption', reason: 'recorded incumbent is unknown' }],
    });
    if (held.kind !== 'written') throw new Error(`hold seed was ${held.kind}`);
    const reconciler = servingReconciler(runDir);
    try {
      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.incumbent.instanceId === serving.instanceId;
      }, 5_000);
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { blockers: seeded.blockers } });
    } finally {
      reconciler.dispose();
    }
  });

  it('recognizes its own intent when it wrote that intent before its incarnation could be read', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    let incarnationSettled = false;
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => ({ ...serving, incarnation: incarnationSettled ? serving.incarnation : null }),
      owners: [],
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
    });
    try {
      expect(
        await reconciler.request({ requestId: 'request-1', target: { build, pluginRootLabel: '/missing/target' } }),
      ).toMatchObject({ kind: 'registered', intent: { incumbent: { incarnation: null } } });
      incarnationSettled = true;

      expect(await reconciler.reconcile()).toEqual({
        kind: 'deferred',
        reason: 'incumbent needs a legacy retirement waiter',
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { incumbent: { instanceId: serving.instanceId }, blockers: [] },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('leaves an attempt its incumbent is committing to that commit', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const committing = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent: serving,
      target: { build, pluginRootLabel: '/missing/target' },
      attemptId: 'committing-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: serving.instanceId, pid: serving.pid, incarnation: null },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(Date.now() - 1_000).toISOString(),
      completionReceipt: null,
    });
    if (committing.kind !== 'written') throw new Error(`intent seed was ${committing.kind}`);
    const reconciler = servingReconciler(runDir);
    try {
      expect(await reconciler.reconcile()).toEqual({ kind: 'deferred', reason: 'succession attempt is committing' });
      expect(await reconciler.abort('committing-attempt')).toEqual({
        kind: 'refused',
        reason: 'attempt is committing',
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { revision: committing.intent.revision, disposition: 'attempting', attemptId: 'committing-attempt' },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('should clear every attempt field a stale intent carried when a fresh request replaces it', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const incumbent = { ...serving, instanceId: 'former', pid: await exitedPid(), incarnation: null };
    const discard = { attemptId: 'retirement-attempt', incumbentEpochKey: 'retired-epoch' };
    const staleIncarnation = probeProcessIncarnation(process.pid);
    if (staleIncarnation === null) throw new Error('this process has no observable incarnation');
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent,
      target: { build: { ...build, version: '0.10.50' }, pluginRootLabel: '/missing/target' },
      attemptId: 'recovery-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: 'former', pid: incumbent.pid, incarnation: null },
      attemptChild: { attemptId: 'recovery-attempt', pid: incumbent.pid, incarnation: staleIncarnation },
      disposition: 'deferred',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      recoveryAttemptId: 'recovery-attempt',
      recoveryBuildSetId: build.buildSetId,
      recoveryRetry: { kind: 'transient', retryAfterMs: 1_000 },
      unservedMintDiscard: discard,
      fieldFromNewerBuild: 'kept',
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const reconciler = servingReconciler(runDir);
    try {
      expect(
        await reconciler.request({ requestId: 'request-2', target: { build, pluginRootLabel: '/missing/target' } }),
      ).toMatchObject({ kind: 'registered', intent: { requestId: 'request-2' } });
      const written = readUpgradeIntent(runDir);
      if (written.kind !== 'readable') throw new Error(`intent is ${written.kind}`);
      expect(written.intent).toMatchObject({
        attemptId: null,
        attemptChild: null,
        recoveryAttemptId: null,
        recoveryBuildSetId: null,
        recoveryRetry: null,
        unservedMintDiscard: discard,
        fieldFromNewerBuild: 'kept',
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('should settle a same-build recovery that serves without its own intent write, instead of refusing it forever', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const failedIncumbent = { ...serving, instanceId: 'failed-incumbent', pid: await exitedPid(), incarnation: null };
    const target = { build, pluginRootLabel: '/missing/target' };
    const recoveryPreparation = {
      version: 'v1',
      requestId: 'request-1',
      attemptId: 'recovery-attempt',
      incumbentInstanceId: failedIncumbent.instanceId,
      incumbentPid: failedIncumbent.pid,
      incumbentKey: 'failed-incumbent-key',
      targetKey: successionTargetKey(target),
      capabilitiesKey: '{}',
      epochKey: 'serving-epoch',
      admissionRevision: 0,
      accepts: [],
      receipts: [],
      stage: 'prepared',
      ready: null,
    };
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent: failedIncumbent,
      target,
      attemptId: 'recovery-attempt',
      attemptOwner: {
        kind: 'incumbent',
        instanceId: failedIncumbent.instanceId,
        pid: failedIncumbent.pid,
        incarnation: null,
      },
      disposition: 'deferred',
      blockers: [{ owner: 'succession-commit', reason: 'same-build recovery after a failed commit' }],
      retryCondition: { kind: 'target-change', evidence: 'same-build recovery in progress' },
      attemptDeadline: null,
      completionReceipt: null,
      recoveryAttemptId: 'recovery-attempt',
      recoveryBuildSetId: build.buildSetId,
      recoveryRetry: { kind: 'target-change' },
      successionPreparation: recoveryPreparation,
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      observeServing: (attemptId) =>
        attemptId === 'recovery-attempt'
          ? {
              epochKey: 'serving-epoch',
              controlGeneration: 2,
              successorInstanceId: serving.instanceId,
              recordedAt: new Date().toISOString(),
            }
          : null,
    });
    try {
      await reconciler.commit('recovery-attempt');
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: {
          incumbent: { instanceId: serving.instanceId },
          attemptId: null,
          recoveryAttemptId: null,
          successionPreparation: null,
          disposition: 'deferred',
          retryCondition: { kind: 'target-change' },
        },
      });
      expect(
        await reconciler.request({
          requestId: 'request-2',
          target: { build: { ...build, version: '0.12.0' }, pluginRootLabel: '/missing/newer' },
        }),
      ).toMatchObject({ kind: 'registered', intent: { requestId: 'request-2' } });
    } finally {
      reconciler.dispose();
    }
  });

  it('should retry the discard of an unserved retirement mint before preparing again, and clear it only once discarded', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const discard = { attemptId: 'failed-retirement', incumbentEpochKey: 'retired-epoch' };
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent: serving,
      target: { build: { ...build, storeFormatFingerprint: `sha256:${'1'.repeat(64)}` }, pluginRootLabel: '/t' },
      attemptId: null,
      attemptOwner: null,
      disposition: 'deferred',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      unservedMintDiscard: discard,
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const outcomes: ('held' | 'discarded')[] = ['held', 'discarded'];
    const attempts: (readonly [string, string])[] = [];
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      storeFormatFingerprint: build.storeFormatFingerprint,
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      retryIntervalMs: 60_000,
      discardUnservedMint: (incumbentEpochKey, attemptId) => {
        attempts.push([incumbentEpochKey, attemptId]);
        const kind = outcomes.shift() ?? 'discarded';
        return kind === 'held' ? { kind, reason: 'a reader holds the mint' } : { kind };
      },
    });
    try {
      await waitForCondition(() => attempts.length >= 1);
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { unservedMintDiscard: discard } });
      expect(await reconciler.reconcile()).toMatchObject({ kind: 'deferred' });
      await waitForCondition(() => {
        const observed = readUpgradeIntent(runDir);
        return observed.kind === 'readable' && observed.intent.unservedMintDiscard === null;
      });
      expect(attempts[0]).toEqual(['retired-epoch', 'failed-retirement']);
    } finally {
      reconciler.dispose();
    }
  });
});
