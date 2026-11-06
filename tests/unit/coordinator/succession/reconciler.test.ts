import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { createSuccessionReconciliationPass } from '#src/coordinator/succession/reconciler/pass.js';
import { createSuccessionReconcilerState } from '#src/coordinator/succession/reconciler/state.js';
import { requestedIntent } from '#src/coordinator/succession/intent-transitions.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';
import { formatPendingUpgrade } from '#src/cli/format/backend.js';
import { visibleUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { pendingIntent, closeUnavailableLegacyRequest } from '#src/coordinator-launch/pending-upgrade.js';
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
const targetObservations = vi.hoisted(() => new Map<string, 'invalid' | 'unobservable'>());

vi.mock('#src/infra/upgrade-intent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UpgradeIntentModule>();
  return {
    ...actual,
    revalidateUpgradeIntentTarget: (intent: UpgradeIntent, pluginRoot?: string) => {
      const observation = targetObservations.get(intent.target.pluginRootLabel);
      if (observation !== undefined)
        return {
          kind: observation,
          evidence: {
            bundleDir: join(intent.target.pluginRootLabel, 'bridge'),
            expectedManifest: intent.target.build,
            failure: observation === 'invalid' ? 'adjacent-manifest-mismatch' : 'bundle-dir-unavailable',
          },
        };
      return installedTargets.has(intent.target.pluginRootLabel)
        ? { kind: 'validated', target: {} }
        : actual.revalidateUpgradeIntentTarget(intent, pluginRoot);
    },
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

it('keeps unchanged target-change holds silent and reports a real intent transition', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-held-observation-'));
  const held = await seedHeldIntent(runDir, serving);
  const logs: string[] = [];
  const reconciler = createSuccessionReconciler({
    runtime,
    runDir,
    incumbent: () => serving,
    owners: [],
    epochKey: () => null,
    admissionRevision: () => 0,
    observation: {
      bootId: 'held-intent-test',
      log: (line) => logs.push(line),
    },
  });
  try {
    await reconciler.reconcile();
    await flushMicrotasks();
    expect(logs.filter((line) => line.includes('event=finish'))).toHaveLength(1);
    const initialHold = [...logs];
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'deferred',
        reason: 'successor target must change after failed attempt',
      });
    await flushMicrotasks();
    expect(logs).toEqual(initialHold);
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { revision: held.revision, disposition: 'deferred' } });
    const changed = await compareAndSwapUpgradeIntent(runDir, held.revision, {
      ...held,
      target: { ...held.target, build: { ...held.target.build, version: serving.version } },
    });
    expect(changed.kind).toBe('written');
    expect(await reconciler.reconcile()).toMatchObject({
      kind: 'refused',
      reason: 'target does not strictly outrank the incumbent',
    });
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { disposition: 'closed' } });
    expect(logs).toHaveLength(initialHold.length + 1);
    expect(logs.at(-1)).toContain('state=cleared');
    expect(await reconciler.reconcile()).toMatchObject({ kind: 'deferred', reason: 'upgrade intent has ended' });
    expect(logs).toHaveLength(initialHold.length + 1);
  } finally {
    reconciler.dispose();
    rmSync(runDir, { recursive: true, force: true });
  }
});

describe('succession reconciler', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    installedTargets.clear();
    targetObservations.clear();
  });

  it.each(['idle', 'deadline', 'missing-target', 'retained-build', 'retained-recovery'] as const)(
    'converges two deadline misses through %s retirement without another hot launch',
    async (exit) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-deadline-'));
      directories.push(runDir);
      let intent = await seedHeldIntent(runDir, serving);
      const miss = { kind: 'transient', retryAfterMs: 1000, servingDeadline: true } as const;
      for (let i = 0; i < 2; i++) {
        const written = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          ...failedAttemptRetry(intent, miss, 'target changed', time.now()),
        });
        if (written.kind !== 'written') throw new Error(written.kind);
        intent = written.intent;
      }
      expect(intent.servingDeadline?.misses).toBe(2);
      expect(intent.retryCondition?.kind).toBe('incumbent-retirement');
      if (exit !== 'missing-target') installedTargets.set(intent.target.pluginRootLabel, {});
      let currentIncumbent = serving;
      let busy = exit === 'deadline';
      const retire = vi.fn();
      const launch = vi.fn();
      const reconciler = createSuccessionReconciler({
        runtime,
        runDir,
        incumbent: () => currentIncumbent,
        owners: [],
        epochKey: () => 'epoch',
        admissionRevision: () => 0,
        commitAvailable: true,
        liveJobIds: () => (busy ? ['busy-job'] : []),
        requiredOwners: [],
        retireForCutover: retire,
        launchPrepared: launch,
      });
      try {
        expect(await reconciler.prepare(intent.requestId)).toMatchObject({
          kind: 'deferred',
          reason: expect.stringContaining('quiescent-cutover'),
        });
        if (exit === 'missing-target') installedTargets.delete(intent.target.pluginRootLabel);
        await reconciler.reconcile();
        if (exit === 'missing-target') {
          await reconciler.reconcile();
          expect(retire).not.toHaveBeenCalled();
          await closeUnavailableLegacyRequest(runDir, intent.requestId);
          const missing = readUpgradeIntent(runDir);
          if (missing.kind !== 'readable') throw new Error(missing.kind);
          const visible = visibleUpgradeIntent(missing.intent);
          if (visible === null) throw new Error('fallback disappeared');
          expect(formatPendingUpgrade(visible)).toContain('target no longer validates');
          expect(formatPendingUpgrade(visible)).not.toContain('6 hours');
          expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'unavailable' } } });
          return;
        }
        if (exit === 'deadline') {
          expect(retire).not.toHaveBeenCalled();
          time.tick(10 * 60_000 + 1);
          await reconciler.reconcile();
        }
        await reconciler.reconcile();
        expect(retire).toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        expect(pendingIntent(runDir)?.target).toEqual(intent.target);
        if (exit === 'retained-build' || exit === 'retained-recovery') {
          const before = readUpgradeIntent(runDir);
          if (before.kind !== 'readable') throw new Error(before.kind);
          currentIncumbent = { ...serving, instanceId: 'ordinary-restart' };
          await compareAndSwapUpgradeIntent(runDir, before.intent.revision, {
            ...before.intent,
            incumbent: currentIncumbent,
          });
          retire.mockClear();
          await reconciler.reconcile();
          await reconciler.reconcile();
          expect(retire).not.toHaveBeenCalled();
          expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'unavailable' } } });
          if (exit === 'retained-recovery') {
            time.tick(60 * 60_000 - 1);
            await flushMicrotasks();
            expect(retire).not.toHaveBeenCalled();
            time.tick(1);
            await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
            expect(readUpgradeIntent(runDir)).toMatchObject({
              intent: {
                servingDeadline: { outcome: 'retiring', retirementIncumbent: currentIncumbent.instanceId },
              },
            });
            expect(launch).not.toHaveBeenCalled();
            return;
          }
        }
        // A closed intent and a fresh request ID must not purchase another pair of boots.
        const current = readUpgradeIntent(runDir);
        if (current.kind !== 'readable') throw new Error(current.kind);
        const closed = await compareAndSwapUpgradeIntent(runDir, current.intent.revision, {
          ...current.intent,
          disposition: 'closed',
        });
        expect(closed.kind).toBe('written');
        await reconciler.request({ requestId: 'renewed', target: intent.target });
        await reconciler.reconcile();
        expect(readUpgradeIntent(runDir)).toMatchObject({
          kind: 'readable',
          intent: {
            requestId: 'renewed',
            legacyRetirement: true,
            servingDeadline: { misses: 2 },
          },
        });
        expect(launch).not.toHaveBeenCalled();
        if (exit === 'retained-build') {
          const renewed = readUpgradeIntent(runDir);
          if (renewed.kind !== 'readable') throw new Error(renewed.kind);
          expect(visibleUpgradeIntent(renewed.intent)?.reason).toContain('hot succession suppressed');
          await compareAndSwapUpgradeIntent(runDir, renewed.intent.revision, {
            ...renewed.intent,
            retryCondition: null,
          });
          await expect(reconciler.reconcile()).resolves.toMatchObject({
            reason: expect.stringContaining('hot succession suppressed'),
          });
        }
        if (exit === 'idle') {
          const relocation = await reconciler.request({
            requestId: 'relocated',
            target: { ...intent.target, pluginRootLabel: '/relocated/same-build' },
          });
          if (relocation.kind !== 'registered') throw new Error(relocation.kind);
          expect(await reconciler.prepare(relocation.intent.requestId)).toMatchObject({
            kind: 'deferred',
            reason: expect.stringContaining('quiescent-cutover'),
          });
        }
        busy = false;
        const different = { ...intent.target, build: { ...build, version: '0.12.0', buildSetId: 'different' } };
        installedTargets.set(different.pluginRootLabel, {
          version: SUCCESSION_CAPABILITY_VERSION,
          buildSetId: 'different',
          bundleHash: build.bundleHash,
          protocols: ['prepare', 'commit'],
          accepts: [],
        });
        await reconciler.request({ requestId: 'different', target: different });
        if (exit === 'retained-build') {
          expect(await reconciler.prepare('different')).toMatchObject({ kind: 'prepared' });
          expect(readUpgradeIntent(runDir)).toMatchObject({ kind: 'readable', intent: { legacyRetirement: false } });
        } else {
          await reconciler.reconcile();
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: {
              legacyRetirement: true,
              target: intent.target,
              nextTarget: { requestId: 'different', target: different },
            },
          });
          expect(await reconciler.prepare('different')).toMatchObject({ kind: 'refused' });
        }
      } finally {
        reconciler.dispose();
      }
    },
  );

  it('does not inherit deadline history or cutover suppression for a different build at the same version', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-same-version-'));
    directories.push(runDir);
    let intent = await seedHeldIntent(runDir, serving);
    const miss = { kind: 'transient', retryAfterMs: 1000, servingDeadline: true } as const;
    for (let i = 0; i < 2; i++) {
      intent = { ...intent, ...failedAttemptRetry(intent, miss, 'changed', time.now()) };
    }
    const closed = await compareAndSwapUpgradeIntent(runDir, intent.revision, { ...intent, disposition: 'closed' });
    if (closed.kind !== 'written') throw new Error(closed.kind);
    const replacement = { ...intent.target, build: { ...intent.target.build, buildSetId: 'replacement' } };
    installedTargets.set(replacement.pluginRootLabel, {
      version: SUCCESSION_CAPABILITY_VERSION,
      buildSetId: replacement.build.buildSetId,
      bundleHash: replacement.build.bundleHash,
      protocols: ['prepare', 'commit'],
      accepts: [],
    });
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
    });
    try {
      const registered = await reconciler.request({ requestId: 'same-version-replacement', target: replacement });
      if (registered.kind !== 'registered') throw new Error(registered.kind);
      expect(registered.intent.target).toEqual(replacement);
      expect(await reconciler.prepare(registered.intent.requestId)).toMatchObject({ kind: 'prepared' });
      const firstMiss = failedAttemptRetry(registered.intent, miss, 'changed', time.now());
      expect(firstMiss.servingDeadline).toMatchObject({ misses: 1, cutoverAt: null });
      expect(firstMiss.legacyRetirement).toBeUndefined();
    } finally {
      reconciler.dispose();
    }
  });

  it('does not drain when another request replaces the observed retirement revision', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-revision-'));
    directories.push(runDir);
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++) {
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          time.now(),
        ),
      };
    }
    const policy = intent.servingDeadline;
    if (policy === undefined) throw new Error('missing deadline policy');
    const seeded = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
      ...intent,
      servingDeadline: { ...policy, outcome: 'retiring', retirementIncumbent: serving.instanceId },
    });
    if (seeded.kind !== 'written') throw new Error(seeded.kind);
    installedTargets.set(intent.target.pluginRootLabel, {});
    const replacement = { ...intent.target, build: { ...build, version: '0.12.0', buildSetId: 'replacement' } };
    const retire = vi.fn();
    const unexpected = vi.fn(async () => ({ kind: 'deferred', reason: 'unexpected orchestration' }) as const);
    const pass = createSuccessionReconciliationPass({
      options: {
        runtime,
        runDir,
        incumbent: () => serving,
        owners: [],
        epochKey: () => 'epoch',
        admissionRevision: () => 0,
        liveJobIds: () => [],
        retireForCutover: retire,
      },
      state: createSuccessionReconcilerState(),
      status: () => {
        const observed = readUpgradeIntent(runDir);
        if (observed.kind !== 'readable') throw new Error(observed.kind);
        writeFileSync(
          upgradeIntentPath(runDir),
          JSON.stringify({
            ...observed.intent,
            ...requestedIntent({ requestId: 'replacement', target: replacement }, serving, null),
            revision: observed.intent.revision + 1,
          }),
        );
        return { kind: 'readable', intent: observed.intent, preparation: null };
      },
      notifyObligationChange: vi.fn(),
      adopt: unexpected,
      adoptNextTarget: unexpected,
      close: unexpected,
      prepare: unexpected,
      commit: unexpected,
      abort: unexpected,
    });
    await pass();
    expect(retire).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: { requestId: 'replacement', target: replacement, legacyRetirement: false },
    });
  });

  it('commits retirement before draining and queues a later target until ordinary startup', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-claim-'));
    directories.push(runDir);
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++)
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          time.now(),
        ),
      };
    expect((await compareAndSwapUpgradeIntent(runDir, intent.revision, intent)).kind).toBe('written');
    installedTargets.set(intent.target.pluginRootLabel, {});
    const retire = vi.fn(() => {
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: {
          legacyRetirement: true,
          servingDeadline: { outcome: 'retiring', retirementIncumbent: serving.instanceId },
        },
      });
      expect(pendingIntent(runDir)?.target).toEqual(intent.target);
    });
    const launch = vi.fn();
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      liveJobIds: () => [],
      retireForCutover: retire,
      launchPrepared: launch,
    });
    try {
      await reconciler.reconcile();
      expect(retire).toHaveBeenCalled();
      const target = { ...intent.target, build: { ...build, version: '0.12.0', buildSetId: 'queued-build' } };
      installedTargets.set(target.pluginRootLabel, {
        version: SUCCESSION_CAPABILITY_VERSION,
        buildSetId: target.build.buildSetId,
        bundleHash: target.build.bundleHash,
        protocols: ['prepare'],
        accepts: [],
      });
      expect(await reconciler.request({ requestId: 'queued', target })).toMatchObject({ kind: 'registered' });
      await reconciler.reconcile();
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { target: intent.target, legacyRetirement: true, nextTarget: { requestId: 'queued', target } },
      });
      expect(pendingIntent(runDir)?.target).toEqual(intent.target);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      reconciler.dispose();
    }
  });

  it('does not commit retirement for a different build retained after an older closer', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-stale-build-'));
    directories.push(runDir);
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++)
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          time.now(),
        ),
      };
    const policy = intent.servingDeadline;
    if (policy === undefined) throw new Error('missing deadline policy');
    expect(
      (
        await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          disposition: 'closed',
          servingDeadline: { ...policy, outcome: 'retiring', retirementIncumbent: serving.instanceId },
        })
      ).kind,
    ).toBe('written');
    const reconciler = servingReconciler(runDir);
    try {
      const second = { ...intent.target, build: { ...build, version: '0.12.0', buildSetId: 'second' } };
      const third = { ...intent.target, build: { ...build, version: '0.13.0', buildSetId: 'third' } };
      expect(await reconciler.request({ requestId: 'second', target: second })).toMatchObject({ kind: 'registered' });
      expect(await reconciler.request({ requestId: 'third', target: third })).toMatchObject({
        kind: 'registered',
        intent: { requestId: 'third', target: third, legacyRetirement: false, nextTarget: null },
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { requestId: 'third', target: third, legacyRetirement: false },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('retires a busy incumbent automatically at the durable cutover deadline', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-wakeup-'));
    directories.push(runDir);
    const clock = new VirtualTime();
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++)
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          clock.now(),
        ),
      };
    expect((await compareAndSwapUpgradeIntent(runDir, intent.revision, intent)).kind).toBe('written');
    installedTargets.set(intent.target.pluginRootLabel, {});
    const retire = vi.fn();
    const errors = vi.fn();
    const reconciler = createSuccessionReconciler({
      runtime: { ...runtime, time: clock },
      runDir,
      incumbent: () => serving,
      owners: [],
      epochKey: () => 'epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      liveJobIds: () => ['busy-job'],
      retireForCutover: retire,
      retryIntervalMs: 60 * 60_000,
      onReconcileError: errors,
    });
    try {
      await reconciler.reconcile();
      await flushMicrotasks();
      const at = intent.servingDeadline?.cutoverAt;
      if (at === undefined || at === null) throw new Error('missing cutover deadline');
      clock.tick(Date.parse(at) - clock.now() - 1);
      await flushMicrotasks();
      expect(retire).not.toHaveBeenCalled();
      clock.tick(1);
      await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
      expect(errors).not.toHaveBeenCalled();
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'retiring' } } });
    } finally {
      reconciler.dispose();
    }
  });

  it.each(['recovers', 'invalid', 'slow-recovery'] as const)(
    'settles cutover target evidence when it %s',
    async (scenario) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-evidence-'));
      directories.push(runDir);
      const clock = new VirtualTime();
      let intent = await seedHeldIntent(runDir, serving);
      for (let i = 0; i < 2; i++)
        intent = {
          ...intent,
          ...failedAttemptRetry(
            intent,
            { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
            'changed',
            clock.now(),
          ),
        };
      expect((await compareAndSwapUpgradeIntent(runDir, intent.revision, intent)).kind).toBe('written');
      const root = intent.target.pluginRootLabel;
      installedTargets.set(root, {});
      targetObservations.set(root, scenario === 'invalid' ? 'invalid' : 'unobservable');
      const retire = vi.fn();
      const launch = vi.fn();
      const reconciler = createSuccessionReconciler({
        runtime: { ...runtime, time: clock },
        runDir,
        incumbent: () => serving,
        owners: [],
        epochKey: () => 'epoch',
        admissionRevision: () => 0,
        commitAvailable: true,
        liveJobIds: () => (scenario === 'recovers' ? [] : ['busy-job']),
        retireForCutover: retire,
        launchPrepared: launch,
        retryIntervalMs: 6 * 60 * 60_000,
      });
      try {
        if (scenario !== 'recovers') clock.tick(10 * 60_000);
        await reconciler.reconcile();
        await flushMicrotasks();
        expect(retire).not.toHaveBeenCalled();
        if (scenario === 'invalid') {
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: {
              servingDeadline: {
                outcome: 'unavailable',
                targetRevalidation: { attempts: 1, retryAt: new Date(clock.now() + 60 * 60_000).toISOString() },
              },
            },
          });
          clock.tick(60 * 60_000 - 1);
          await flushMicrotasks();
          expect(retire).not.toHaveBeenCalled();
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: { servingDeadline: { outcome: 'unavailable', targetRevalidation: { attempts: 1 } } },
          });
          clock.tick(1);
          await vi.waitFor(() =>
            expect(readUpgradeIntent(runDir)).toMatchObject({
              intent: {
                servingDeadline: {
                  outcome: 'unavailable',
                  targetRevalidation: { attempts: 2, retryAt: new Date(clock.now() + 60 * 60_000).toISOString() },
                },
              },
            }),
          );
          expect(retire).not.toHaveBeenCalled();
          targetObservations.delete(root);
          clock.tick(60 * 60_000 - 1);
          await flushMicrotasks();
          expect(retire).not.toHaveBeenCalled();
          clock.tick(1);
          await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
          expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'retiring' } } });
        } else {
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: {
              servingDeadline: { outcome: 'waiting', retirementIncumbent: null, targetRevalidation: { attempts: 1 } },
            },
          });
          clock.tick(4_999);
          await flushMicrotasks();
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: { servingDeadline: { targetRevalidation: { attempts: 1 } } },
          });
          if (scenario === 'recovers') targetObservations.delete(root);
          clock.tick(1);
          if (scenario === 'recovers') {
            await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
            expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'retiring' } } });
          } else {
            await vi.waitFor(() =>
              expect(readUpgradeIntent(runDir)).toMatchObject({
                intent: { servingDeadline: { targetRevalidation: { attempts: 2 } } },
              }),
            );
            clock.tick(5_000);
            await vi.waitFor(() =>
              expect(readUpgradeIntent(runDir)).toMatchObject({
                intent: {
                  servingDeadline: {
                    outcome: 'unobservable',
                    targetRevalidation: { attempts: 3, retryAt: new Date(clock.now() + 60_000).toISOString() },
                  },
                },
              }),
            );
            clock.tick(59_999);
            await flushMicrotasks();
            expect(retire).not.toHaveBeenCalled();
            expect(readUpgradeIntent(runDir)).toMatchObject({
              intent: { servingDeadline: { outcome: 'unobservable', targetRevalidation: { attempts: 3 } } },
            });
            targetObservations.delete(root);
            clock.tick(1);
            await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
            expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { servingDeadline: { outcome: 'retiring' } } });
          }
        }
        expect(launch).not.toHaveBeenCalled();
      } finally {
        reconciler.dispose();
      }
    },
  );

  it('preserves the busy cutover deadline through repeated same-target renewal and restoration', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-renewal-'));
    directories.push(runDir);
    const clock = new VirtualTime();
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++)
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          clock.now(),
        ),
      };
    expect((await compareAndSwapUpgradeIntent(runDir, intent.revision, intent)).kind).toBe('written');
    const originalDeadline = intent.servingDeadline?.cutoverAt;
    if (originalDeadline === undefined || originalDeadline === null) throw new Error('missing deadline');
    installedTargets.set(intent.target.pluginRootLabel, {});
    const retire = vi.fn();
    const reconciler = createSuccessionReconciler({
      runtime: { ...runtime, time: clock },
      runDir,
      incumbent: () => serving,
      owners: [],
      epochKey: () => 'epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      liveJobIds: () => ['busy-job'],
      retireForCutover: retire,
      retryIntervalMs: 24 * 60 * 60_000,
    });
    try {
      await reconciler.reconcile();
      for (let renewal = 1; renewal <= 3; renewal++) {
        clock.tick(2 * 60_000);
        const before = readUpgradeIntent(runDir);
        if (before.kind !== 'readable') throw new Error(before.kind);
        expect(
          (
            await compareAndSwapUpgradeIntent(runDir, before.intent.revision, {
              ...before.intent,
              disposition: 'closed',
            })
          ).kind,
        ).toBe('written');
        expect(await reconciler.request({ requestId: `renewal-${renewal}`, target: intent.target })).toMatchObject({
          kind: 'registered',
        });
        await reconciler.reconcile();
        await vi.waitFor(() =>
          expect(readUpgradeIntent(runDir)).toMatchObject({
            intent: {
              requestId: `renewal-${renewal}`,
              legacyRetirement: true,
              blockers: [expect.objectContaining({ owner: 'quiescent-cutover' })],
              servingDeadline: { cutoverAt: originalDeadline },
            },
          }),
        );
        expect(retire).not.toHaveBeenCalled();
      }
      clock.tick(Date.parse(originalDeadline) - clock.now() - 1);
      await flushMicrotasks();
      expect(retire).not.toHaveBeenCalled();
      clock.tick(1);
      await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    } finally {
      reconciler.dispose();
    }
  });

  it('caps ongoing unobservable target revalidation at one hour', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-cutover-slow-cap-'));
    directories.push(runDir);
    const clock = new VirtualTime();
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 2; i++)
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          clock.now(),
        ),
      };
    const policy = intent.servingDeadline;
    if (policy === undefined) throw new Error('missing deadline policy');
    expect(
      (
        await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          servingDeadline: { ...policy, outcome: 'unobservable', targetRevalidation: { attempts: 8, retryAt: null } },
        })
      ).kind,
    ).toBe('written');
    targetObservations.set(intent.target.pluginRootLabel, 'unobservable');
    clock.tick(10 * 60_000);
    const retire = vi.fn();
    const reconciler = createSuccessionReconciler({
      runtime: { ...runtime, time: clock },
      runDir,
      incumbent: () => serving,
      owners: [],
      epochKey: () => 'epoch',
      admissionRevision: () => 0,
      commitAvailable: true,
      liveJobIds: () => ['busy-job'],
      retireForCutover: retire,
      retryIntervalMs: 24 * 60 * 60_000,
    });
    try {
      await reconciler.reconcile();
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: {
          servingDeadline: {
            outcome: 'unobservable',
            targetRevalidation: { attempts: 9, retryAt: new Date(clock.now() + 60 * 60_000).toISOString() },
          },
        },
      });
      clock.tick(60 * 60_000 - 1);
      await flushMicrotasks();
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { servingDeadline: { targetRevalidation: { attempts: 9 } } },
      });
      clock.tick(1);
      await vi.waitFor(() =>
        expect(readUpgradeIntent(runDir)).toMatchObject({
          intent: {
            servingDeadline: {
              targetRevalidation: { attempts: 10, retryAt: new Date(clock.now() + 60 * 60_000).toISOString() },
            },
          },
        }),
      );
      expect(retire).not.toHaveBeenCalled();
    } finally {
      reconciler.dispose();
    }
  });

  it('keeps races transient and requires consecutive deadline evidence', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-deadline-race-'));
    directories.push(runDir);
    const intent = await seedHeldIntent(runDir, serving);
    const miss = { kind: 'transient', retryAfterMs: 1000, servingDeadline: true } as const;
    const exhausted = {
      ...intent,
      transientRetry: {
        targetKey: successionTargetKey(intent.target),
        failures: 6,
        retryAfter: new Date(time.now()).toISOString(),
      },
    };
    const first = { ...exhausted, ...failedAttemptRetry(exhausted, miss, 'changed', time.now()) };
    expect(first.disposition).not.toBe('closed');
    expect(first.transientRetry?.failures).toBe(6);
    expect(first.servingDeadline?.misses).toBe(1);
    const race = {
      ...first,
      ...failedAttemptRetry(
        first,
        { kind: 'transient', retryAfterMs: 1000, obligationChange: true },
        'changed',
        time.now(),
      ),
    };
    expect(race.servingDeadline?.misses).toBe(0);
    expect(failedAttemptRetry(race, miss, 'changed', time.now()).legacyRetirement).toBeUndefined();
  });

  it('bounds alternating deadline misses and genuine transient failures', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-alternating-'));
    directories.push(runDir);
    let intent = await seedHeldIntent(runDir, serving);
    for (let i = 0; i < 14 && intent.disposition !== 'closed'; i++) {
      intent = {
        ...intent,
        ...failedAttemptRetry(
          intent,
          { kind: 'transient', retryAfterMs: 1000, ...(i % 2 === 0 ? { servingDeadline: true } : {}) },
          'changed',
          time.now(),
        ),
      };
    }
    expect(intent.disposition).toBe('closed');
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

  it('reports changed mint-discard hold reasons once without changing the held decision', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-discard-observation-'));
    directories.push(runDir);
    const held = await seedHeldIntent(runDir, serving);
    const seeded = await compareAndSwapUpgradeIntent(runDir, held.revision, {
      ...held,
      target: { ...held.target, build: { ...build, storeFormatFingerprint: `sha256:${'1'.repeat(64)}` } },
      unservedMintDiscard: { attemptId: 'failed-retirement', incumbentEpochKey: 'retired-epoch' },
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    let reason = 'retirement source is unproven';
    const logs: string[] = [];
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => serving,
      owners: [],
      storeFormatFingerprint: build.storeFormatFingerprint,
      epochKey: () => 'serving-epoch',
      admissionRevision: () => 0,
      discardUnservedMint: () => ({ kind: 'held', reason }),
      observation: { bootId: 'discard-hold-test', log: (line) => logs.push(line) },
    });
    const pass = async () => {
      expect(await reconciler.reconcile()).toEqual({
        kind: 'deferred',
        reason: `unserved retirement mint is not yet discarded (${reason})`,
      });
      await flushMicrotasks();
    };
    try {
      await pass();
      expect(logs.some((line) => line.includes(reason))).toBe(true);
      const first = [...logs];
      await pass();
      expect(logs).toEqual(first);
      reason = 'retirement marker is unreadable';
      await pass();
      expect(logs.slice(first.length).some((line) => line.includes(reason))).toBe(true);
      expect(logs.filter((line) => line.includes('event=finish'))).toHaveLength(2);
      const changed = [...logs];
      await pass();
      expect(logs).toEqual(changed);
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: seeded.intent });
      const closed = await compareAndSwapUpgradeIntent(runDir, seeded.intent.revision, {
        ...seeded.intent,
        unservedMintDiscard: null,
        disposition: 'closed',
      });
      expect(closed.kind).toBe('written');
      expect(await reconciler.reconcile()).toMatchObject({ kind: 'deferred', reason: 'upgrade intent has ended' });
      await flushMicrotasks();
      expect(logs.at(-1)).toContain('state=cleared');
      const cleared = [...logs];
      await reconciler.reconcile();
      await flushMicrotasks();
      expect(logs).toEqual(cleared);
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
    targetObservations.clear();
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
