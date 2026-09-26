import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  dischargeDeadSuccessionAttempt,
  openPreferredStoreEpoch,
  prepareCommittedSuccessorRecovery,
  resolveIncompleteSuccessionAtStartup,
  SuccessionAttemptStartupHoldError,
  type IncompleteSuccessionResolution,
  type SuccessionStartupHold,
} from '#src/coordinator/succession/startup.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { isProcessIncarnation, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntentChange } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { encodeResolvedStoreEpoch, settleStoreEpoch } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';

const roots: string[] = [];
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeFixture(): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-startup-'));
  roots.push(root);
  return createRealRuntime('prod', { baseDir: root });
}

/** A pid whose process has exited, so its absence is decisive. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.pid === undefined) throw new Error('exited child has no pid');
  return child.pid;
}

function preparation(attemptId: string, receipts: SuccessionPreparation['receipts'] = []): SuccessionPreparation {
  return {
    version: 'v1',
    requestId: 'request-1',
    attemptId,
    incumbentInstanceId: 'incumbent',
    incumbentPid: 1,
    incumbentKey: 'incumbent-key',
    targetKey: 'target-key',
    capabilitiesKey: 'capabilities-key',
    epochKey: 'epoch-key',
    admissionRevision: 0,
    accepts: [],
    receipts,
    stage: 'prepared',
    ready: null,
  };
}

type OwnerRecord = Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>;

async function seedRecoveryGrant(
  runtime: Runtime,
  owner: OwnerRecord,
  successionPreparation: unknown = preparation('recovery-attempt'),
): Promise<void> {
  const change: UpgradeIntentChange = {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'incumbent',
      pid: owner.pid,
      incarnation: owner.incarnation,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
    attemptId: 'recovery-attempt',
    attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', ...owner },
    attemptChild: null,
    disposition: 'deferred',
    blockers: [],
    retryCondition: { kind: 'target-change', evidence: 'same-build recovery in progress' },
    attemptDeadline: null,
    completionReceipt: null,
    recoveryAttemptId: 'recovery-attempt',
    successionPreparation,
  };
  const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, change);
  if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
}

async function holdOf(pending: Promise<IncompleteSuccessionResolution>): Promise<SuccessionStartupHold> {
  const resolution = await pending;
  if (resolution.kind !== 'hold') throw new Error(`startup resolved ${resolution.kind} instead of holding`);
  return resolution.hold;
}

function resolveAt(runtime: Runtime, startupId: string) {
  return resolveIncompleteSuccessionAtStartup({
    runtime,
    currentBuild: build,
    startupId,
    prepareRecoveryGrantHandoff: () => null,
  });
}

describe('incomplete succession at startup', () => {
  it('should abandon an attempt whose deaths stay unproven once patience is exhausted', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toMatchObject({ kind: 'deaths-unproven', alive: false });
    const visible = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    expect(visible.kind === 'readable' ? visible.intent.blockers : []).toEqual([
      { owner: 'succession-startup', reason: 'attempt process deaths are unproven (startup 1 of 3)' },
    ]);
    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toMatchObject({ kind: 'deaths-unproven' });
    expect(await holdOf(resolveAt(runtime, 'startup-2'))).toMatchObject({ kind: 'deaths-unproven' });

    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
    const abandoned = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    expect(abandoned).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'deferred',
        attemptId: null,
        attemptOwner: null,
        successionPreparation: null,
        blockers: [
          { owner: 'succession-startup', reason: 'abandoned after 3 startups: attempt process deaths are unproven' },
        ],
      },
    });
    await expect(resolveAt(runtime, 'startup-4')).resolves.toEqual({ kind: 'none' });
  });

  it('should hold without spending patience while the recorded owner is observed alive', async () => {
    const runtime = runtimeFixture();
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('this process has no readable incarnation');
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation });

    for (const startupId of ['startup-1', 'startup-2', 'startup-3', 'startup-4']) {
      expect(await holdOf(resolveAt(runtime, startupId))).toEqual({
        kind: 'deaths-unproven',
        attemptId: 'recovery-attempt',
        alive: true,
      });
    }
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { attemptId: 'recovery-attempt' },
    });
  });

  it('should report an unreadable attempt record apart from unproven deaths', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: await exitedPid(), incarnation: null }, { stage: 'prepared' });

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toEqual({
      kind: 'attempt-record-unreadable',
      attemptId: 'recovery-attempt',
    });
  });

  it('should abandon a grant whose old controller never becomes available', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: await exitedPid(), incarnation: null });

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toEqual({
      kind: 'grant-controller-unavailable',
      attemptId: 'recovery-attempt',
    });
    await holdOf(resolveAt(runtime, 'startup-2'));
    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { attemptId: null, recoveryAttemptId: null },
    });
  });

  it('should hold an unserved transfer whose recovery grants do not verify', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedPid();
    const childIncarnation = 'recorded-child-incarnation';
    if (!isProcessIncarnation(childIncarnation)) throw new Error('child incarnation is not well-formed');
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'incumbent',
        pid: dead,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'attempt-1',
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: dead, incarnation: null },
      attemptChild: { attemptId: 'attempt-1', pid: dead, incarnation: childIncarnation },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation('attempt-1', [
        {
          owner: 'durable-cli',
          generation: 1,
          attemptId: 'attempt-1',
          receiptId: 'durable-cli:attempt-1',
          recoveryGrantId: 'grant-1',
          payload: null,
        },
      ]),
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toEqual({
      kind: 'recovery-grants-unverified',
      attemptId: 'attempt-1',
    });
  });

  it('should retire a dead attempt that transferred nothing, and discharge it once this startup serves', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedPid();
    const childIncarnation = 'recorded-child-incarnation';
    if (!isProcessIncarnation(childIncarnation)) throw new Error('child incarnation is not well-formed');
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'incumbent',
        pid: dead,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'attempt-1',
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: dead, incarnation: null },
      attemptChild: { attemptId: 'attempt-1', pid: dead, incarnation: childIncarnation },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation('attempt-1'),
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);

    await expect(resolveAt(runtime, 'startup-1')).resolves.toEqual({ kind: 'retire', attemptId: 'attempt-1' });
    const serving = {
      instanceId: 'serving',
      pid: process.pid,
      incarnation: probeProcessIncarnation(process.pid),
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod' as const,
    };
    await dischargeDeadSuccessionAttempt(runtime, 'attempt-1', serving);
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        incumbent: serving,
        target: { build },
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        successionPreparation: null,
        disposition: 'deferred',
        retryCondition: { kind: 'attempt-expiry' },
      },
    });
  });

  describe('an attempt its incumbent prepared but never began committing', () => {
    async function seedPreparedAttempt(runtime: Runtime, owner: OwnerRecord): Promise<void> {
      const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
        requestId: 'request-1',
        incumbent: {
          instanceId: 'incumbent',
          ...owner,
          version: '0.10.13',
          bundleHash: 'fedcba9876543210',
          flavor: 'prod',
        },
        target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
        attemptId: 'prepared-attempt',
        attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', ...owner },
        attemptChild: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: null,
        successionPreparation: preparation('prepared-attempt', [
          {
            owner: 'durable-cli',
            generation: 1,
            attemptId: 'prepared-attempt',
            receiptId: 'durable-cli:prepared-attempt',
            recoveryGrantId: 'durable-cli:prepared-attempt',
            payload: null,
          },
        ]),
      });
      if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    }

    it('should retire it once its incumbent is proven gone, without verifying grants it never transferred', async () => {
      const runtime = runtimeFixture();
      await seedPreparedAttempt(runtime, { pid: await exitedPid(), incarnation: null });

      await expect(resolveAt(runtime, 'startup-1')).resolves.toEqual({
        kind: 'retire',
        attemptId: 'prepared-attempt',
      });
    });

    it('should hold without spending patience while its incumbent is observed alive', async () => {
      const runtime = runtimeFixture();
      const incarnation = probeProcessIncarnation(process.pid);
      if (incarnation === null) throw new Error('this process has no readable incarnation');
      await seedPreparedAttempt(runtime, { pid: process.pid, incarnation });

      for (const startupId of ['startup-1', 'startup-2', 'startup-3', 'startup-4']) {
        expect(await holdOf(resolveAt(runtime, startupId))).toEqual({
          kind: 'deaths-unproven',
          attemptId: 'prepared-attempt',
          alive: true,
        });
      }
    });

    it('should hold an unproven death under patience, then abandon the attempt', async () => {
      const runtime = runtimeFixture();
      await seedPreparedAttempt(runtime, { pid: process.pid, incarnation: null });

      expect(await holdOf(resolveAt(runtime, 'startup-1'))).toEqual({
        kind: 'deaths-unproven',
        attemptId: 'prepared-attempt',
        alive: false,
      });
      await holdOf(resolveAt(runtime, 'startup-2'));
      await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        kind: 'readable',
        intent: { attemptId: null, successionPreparation: null, disposition: 'deferred' },
      });
    });
  });

  it('should hold a committed successor whose writer generation cannot be attributed, then abandon it', async () => {
    const runtime = runtimeFixture();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const dead = await exitedPid();
    const owner = { kind: 'incumbent' as const, instanceId: 'incumbent', pid: dead, incarnation: null };
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: { ...owner, version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod' },
      target: { build: current, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'attempt-1',
      attemptOwner: owner,
      attemptChild: null,
      disposition: 'completed',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: {
        kind: 'serving',
        attemptId: 'attempt-1',
        successor: { instanceId: 'successor', pid: dead, incarnation: null, build: current },
        epochKey: encodeResolvedStoreEpoch(runtime, settled.store),
        controlGeneration: 1,
        acceptedObligations: [],
        recordedAt: new Date().toISOString(),
      },
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    const recoverAt = (instanceId: string) =>
      prepareCommittedSuccessorRecovery(runtime, { pluginRoot: '/plugin', instanceId }, format, current, () => false);

    await expect(recoverAt('startup-1')).resolves.toEqual({
      kind: 'hold',
      hold: {
        kind: 'committed-successor-unattributable',
        attemptId: 'attempt-1',
        reason: 'committed successor generation cannot be attributed',
      },
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'completed', blockers: [{ owner: 'succession-startup' }] },
    });
    await expect(recoverAt('startup-2')).resolves.toMatchObject({ kind: 'hold' });
    await expect(recoverAt('startup-3')).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'completed', completionReceipt: { attemptId: 'attempt-1' } },
    });
  });

  it('should hold an unopenable preferred epoch under startup patience, then fall back to ordinary selection', async () => {
    const runtime = runtimeFixture();
    const format = currentCoralStoreFormat();
    const context = {
      runtime,
      storeFormat: format,
      currentBuild: { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint },
      busyTimeoutMs: 1_000,
    };
    const openAt = (startupId: string) => openPreferredStoreEpoch(context, startupId, 'not-an-epoch-key', null);

    for (const startupId of ['startup-1', 'startup-2']) {
      const held = await openAt(startupId).catch((error: unknown) => error);
      expect(held).toBeInstanceOf(SuccessionAttemptStartupHoldError);
      expect((held as SuccessionAttemptStartupHoldError).hold).toMatchObject({
        kind: 'preferred-epoch-unopenable',
        attemptId: null,
        epochKey: 'not-an-epoch-key',
      });
    }
    await expect(openAt('startup-3')).resolves.toBeNull();
  });
});
