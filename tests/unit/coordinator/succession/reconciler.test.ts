import type * as MockedNodeProcessModule from '#src/infra/node-process.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import { SUCCESSION_METHODS } from '#src/infra/succession-address.js';
import { upgradeIntentPath } from '#src/infra/path/index.js';
import { successionTargetKey } from '#src/coordinator/succession/protocol.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { SUCCESSION_CAPABILITY_VERSION } from '#src/infra/bundle-manifest-address.js';
import type { SuccessionCapabilities } from '#src/coordinator/succession/protocol.js';
import type * as ProtocolModule from '#src/coordinator/succession/protocol.js';
import type * as UpgradeIntentModule from '#src/infra/upgrade-intent.js';

vi.mock('#src/infra/node-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MockedNodeProcessModule>()),
  probeProcessIncarnation: (pid: number) => (pid === process.pid ? testIncarnation(pid) : null),
  observeProcessLiveness: (pid: number) => (pid === process.pid ? 'alive' : 'absent'),
}));

/** Plugin roots whose target validates and declares these capabilities, with no bundle on disk. */
const installedTargets = vi.hoisted(() => new Map<string, unknown>());

vi.mock('#src/infra/upgrade-intent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UpgradeIntentModule>();
  return {
    ...actual,
    revalidateUpgradeIntentTarget: (intent: UpgradeIntent, pluginRoot?: string) =>
      installedTargets.has(intent.target.pluginRootLabel)
        ? { kind: 'validated', target: {} }
        : actual.revalidateUpgradeIntentTarget(intent, pluginRoot),
  };
});

vi.mock('#src/coordinator/succession/protocol.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolModule>();
  return {
    ...actual,
    readSuccessionCapabilities: (...args: Parameters<typeof actual.readSuccessionCapabilities>) => {
      const declared = installedTargets.get(join(args[1], '..'));
      return declared === undefined
        ? actual.readSuccessionCapabilities(...args)
        : { kind: 'declared', capabilities: declared };
    },
  };
});

const baseRuntime = createRealRuntime('prod', { baseDir: tmpdir() });
const time = new VirtualTime();
const runtime = {
  ...baseRuntime,
  time,
};

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

async function exitedPid(): Promise<number> {
  return 41_001;
}

const serving = {
  instanceId: 'serving',
  pid: process.pid,
  incarnation: testIncarnation(process.pid),
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
    installedTargets.clear();
  });

  it('quarantines a corrupt intent and accepts the next recorded target', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-corrupt-'));
    directories.push(runDir);
    writeFileSync(upgradeIntentPath(runDir), '{broken');
    installedTargets.set('/installed/replacement', {});
    const reconciler = servingReconciler(runDir);
    try {
      await reconciler.reconcile();
      expect(readUpgradeIntent(runDir).kind).toBe('absent');
      expect(
        await reconciler.request({
          requestId: 'replacement-request',
          target: { build, pluginRootLabel: '/installed/replacement' },
        }),
      ).toMatchObject({ kind: 'registered', intent: { requestId: 'replacement-request' } });
    } finally {
      reconciler.dispose();
    }
  });

  it('closes a registered intent after a repeated validation failure and confirmed missing root', async () => {
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
        intent: {
          revision: first.intent.revision + 1,
          disposition: 'closed',
          blockers: [{ owner: 'target', reason: 'target build no longer validates' }],
        },
      });
    } finally {
      reconciler.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onIntentChanged).toHaveBeenCalledTimes(3);
  });

  it('holds the next attempt through an obligation wake until transient backoff ends, then wakes itself', async () => {
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
    const retryAfterMs = time.now() + 1_500;
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
    const changed = createDeferred<void>();
    let notify: (() => void) | undefined;
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => incumbent,
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
      commitAvailable: true,
      onIntentChanged: () => changed.resolve(),
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

      time.tick(1_500);
      await changed.promise;
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { revision: seeded.intent.revision + 1 } });
      expect(time.now()).toBeGreaterThanOrEqual(retryAfterMs);
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
      await reconciler.reconcile();
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
    let discardAllowed = false;
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
        const kind = discardAllowed ? 'discarded' : 'held';
        return kind === 'held' ? { kind, reason: 'a reader holds the mint' } : { kind };
      },
    });
    try {
      await reconciler.reconcile();
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { unservedMintDiscard: discard } });
      discardAllowed = true;
      await reconciler.reconcile();
      await reconciler.reconcile();
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { unservedMintDiscard: null } });
      expect(attempts[0]).toEqual(['retired-epoch', 'failed-retirement']);
    } finally {
      reconciler.dispose();
    }
  });
});

describe('succession reconciler over an installed target', () => {
  const directories: string[] = [];
  afterEach(() => {
    installedTargets.clear();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function installedTarget(pluginRootLabel: string, version = build.version): UpgradeIntent['target'] {
    const capabilities: SuccessionCapabilities = {
      version: SUCCESSION_CAPABILITY_VERSION,
      buildSetId: build.buildSetId,
      bundleHash: build.bundleHash,
      protocols: ['prepare', 'commit'],
      accepts: [{ owner: 'durable-cli', generation: 1 }],
    };
    installedTargets.set(pluginRootLabel, capabilities);
    return { build: { ...build, version }, pluginRootLabel };
  }

  function runDirectory(): string {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    return runDir;
  }

  function intentOf(runDir: string): UpgradeIntent {
    const observed = readUpgradeIntent(runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    return observed.intent;
  }

  it('should clear a self-owned attempt whose commit ended without landing its clearing write, and adopt the target queued behind it', async () => {
    const runDir = runDirectory();
    const target = installedTarget('/installed/target');
    let settle: (value: unknown) => void = () => undefined;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    let committing: string | null = null;
    const replacementPrepared = createDeferred<void>();
    const adopted = createDeferred<void>();
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      requiredOwners: [],
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      onIntentChanged: () => {
        const observed = readUpgradeIntent(runDir);
        if (observed.kind === 'readable' && observed.intent.requestId === 'request-2') adopted.resolve();
      },
      retryIntervalMs: 60_000,
      launchPrepared: async (intent, preparation) => {
        const written = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          disposition: 'attempting',
          attemptDeadline: new Date(time.now() + 5_000).toISOString(),
        });
        if (written.kind !== 'written') throw new Error(`attempting write was ${written.kind}`);
        committing = preparation.attemptId;
        if (intent.requestId === 'request-2') replacementPrepared.resolve();
        return { settled } as Awaited<
          ReturnType<NonNullable<Parameters<typeof createSuccessionReconciler>[0]['launchPrepared']>>
        >;
      },
    });
    try {
      await reconciler.request({ requestId: 'request-1', target });
      await reconciler.reconcile();
      expect(committing).not.toBeNull();
      const newer = installedTarget('/installed/newer', '0.12.0');
      await reconciler.request({ requestId: 'request-2', target: newer });
      expect(intentOf(runDir)).toMatchObject({ disposition: 'attempting', nextTarget: { requestId: 'request-2' } });

      // The commit reclaimed in place, but the write clearing its attempt failed.
      settle({
        kind: 'clear-owed',
        attemptId: committing,
        clear: (intent: UpgradeIntent): UpgradeIntent => ({
          ...intent,
          disposition: 'deferred',
          attemptId: null,
          attemptChild: null,
          attemptOwner: null,
          attemptDeadline: null,
          successionPreparation: null,
          blockers: [{ owner: 'succession-commit', reason: 'incumbent reclaimed after an injected failure' }],
          retryCondition: { kind: 'target-change', evidence: 'successor committed-open failure' },
        }),
      });

      await adopted.promise;
      await replacementPrepared.promise;
      expect(intentOf(runDir).requestId).toBe('request-2');
      expect(intentOf(runDir)).toMatchObject({ target: newer, attemptId: expect.any(String) as unknown });
    } finally {
      reconciler.dispose();
    }
  });

  it('should refuse to prepare over or abort a same-build recovery attempt', async () => {
    const runDir = runDirectory();
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      incumbent: serving,
      target: { build, pluginRootLabel: '/missing/target' },
      attemptId: 'recovery-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: serving.instanceId, pid: serving.pid, incarnation: null },
      disposition: 'deferred',
      blockers: [{ owner: 'succession-commit', reason: 'same-build recovery after a failed commit' }],
      retryCondition: { kind: 'target-change', evidence: 'same-build recovery in progress' },
      attemptDeadline: null,
      completionReceipt: null,
      recoveryAttemptId: 'recovery-attempt',
      recoveryBuildSetId: build.buildSetId,
      recoveryRetry: { kind: 'target-change' },
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    const coordinator = createSuccessionCoordinator({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      retryIntervalMs: 60_000,
    });
    try {
      expect(await coordinator.dispatch(SUCCESSION_METHODS.prepare, { requestId: 'request-1' })).toMatchObject({
        kind: 'refused',
      });
      expect(await coordinator.dispatch(SUCCESSION_METHODS.abort, { attemptId: 'recovery-attempt' })).toMatchObject({
        kind: 'refused',
      });
      expect(intentOf(runDir)).toMatchObject({
        revision: seeded.intent.revision,
        attemptId: 'recovery-attempt',
        recoveryAttemptId: 'recovery-attempt',
      });
    } finally {
      coordinator.reconciler.dispose();
    }
  });
});
