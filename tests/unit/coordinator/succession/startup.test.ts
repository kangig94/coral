import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completeWaiterLaunchedUpgrade,
  dischargeDeadSuccessionAttempt,
  heldUnservedMint,
  openPreferredStoreEpoch,
  prepareCommittedSuccessorRecovery,
  publishAttemptServing,
  resolveIncompleteSuccessionAtStartup,
  retryRecordedMintDiscard,
  SuccessionAttemptStartupHoldError,
  type IncompleteSuccessionResolution,
  type SuccessionStartupHold,
} from '#src/coordinator/succession/startup.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { recordRetirementDisposition } from '#src/coordinator/succession/retirement-disposition.js';
import { isProcessIncarnation, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntentChange } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { encodeResolvedStoreEpoch, epochDirectory, resolvedStoreEpoch, settleStoreEpoch } from '#src/store/epoch.js';
import { protectStoreEpoch } from '#src/store/epoch-protection.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import * as writerGeneration from '#src/store/succession-writer-generation.js';
import {
  advanceSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  observeSuccessionServing,
} from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { SuccessionAttemptChild } from '#src/coordinator/succession/attempt-child.js';
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
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const startupClocks = new WeakMap<Runtime, { now: number; startupId: string | null }>();

function runtimeFixture(): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-startup-'));
  roots.push(root);
  const base = createRealRuntime('prod', { baseDir: root });
  const clock = { now: Date.now(), startupId: null as string | null };
  const runtime: Runtime = { ...base, time: { ...base.time, now: () => clock.now } };
  startupClocks.set(runtime, clock);
  return runtime;
}

/** Distinct startups happen a patience interval apart; one startup repeated keeps its instant. */
function atStartup(runtime: Runtime, startupId: string): void {
  const clock = startupClocks.get(runtime);
  if (clock === undefined) throw new Error('runtime has no startup clock');
  if (clock.startupId !== null && clock.startupId !== startupId) clock.now += 60_000;
  clock.startupId = startupId;
}

/** A pid whose process has exited, so its absence is decisive. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.pid === undefined) throw new Error('exited child has no pid');
  return child.pid;
}

/** A process that has exited, recorded with the incarnation it had, so its absence is decisive. */
async function exitedIncarnation(): Promise<Readonly<{ pid: number; incarnation: ProcessIncarnation }>> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  const incarnation = child.pid === undefined ? null : probeProcessIncarnation(child.pid);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  if (child.pid === undefined || incarnation === null) throw new Error('exited child has no incarnation');
  return { pid: child.pid, incarnation };
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
  atStartup(runtime, startupId);
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

  it('should hold a committed successor whose writer generation cannot be attributed, then abandon it for good', async () => {
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
    const recoverAt = (instanceId: string) => {
      atStartup(runtime, instanceId);
      return prepareCommittedSuccessorRecovery(
        runtime,
        { pluginRoot: '/plugin', instanceId },
        format,
        current,
        () => false,
      );
    };

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
    // Nothing changes a completed intent, so the abandonment must outlive it: every later startup proceeds.
    for (const startupId of ['startup-4', 'startup-5', 'startup-6']) {
      await expect(recoverAt(startupId)).resolves.toEqual({ kind: 'none' });
    }
  });

  it("should record the discard of an abandoned attempt's possible retirement mint", async () => {
    const runtime = runtimeFixture();
    const attemptId = runtime.ids.uuid();
    const owner = { kind: 'incumbent' as const, instanceId: 'incumbent', pid: process.pid, incarnation: null };
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: { ...owner, version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod' },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId,
      attemptOwner: owner,
      attemptChild: { attemptId, ...(await exitedIncarnation()) },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation(attemptId),
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    recordRetirementDisposition(runtime, {
      version: 'v1',
      attemptId,
      incumbentEpochKey: 'epoch-key',
      incumbentFingerprint: build.storeFormatFingerprint,
      successorFingerprint: build.storeFormatFingerprint,
      certificateRevision: 0,
      certificateJobIds: [],
      custodySettled: true,
    });

    await expect(holdOf(resolveAt(runtime, 'startup-1'))).resolves.toMatchObject({ kind: 'deaths-unproven' });
    await expect(holdOf(resolveAt(runtime, 'startup-2'))).resolves.toMatchObject({ kind: 'deaths-unproven' });
    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });

    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { attemptId: null, unservedMintDiscard: { attemptId, incumbentEpochKey: 'epoch-key' } },
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
    const openAt = (startupId: string) => {
      atStartup(runtime, startupId);
      return openPreferredStoreEpoch(context, startupId, 'not-an-epoch-key', null);
    };

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
    // The next time the same epoch will not open is a new hold, with patience of its own.
    await expect(openAt('startup-4')).rejects.toBeInstanceOf(SuccessionAttemptStartupHoldError);
  });

  it('should count a burst of startups within one patience interval as a single startup', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });

    for (const startupId of ['burst-1', 'burst-2', 'burst-3', 'burst-4']) {
      const resolution = await resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild: build,
        startupId,
        prepareRecoveryGrantHandoff: () => null,
      });
      expect(resolution).toMatchObject({ kind: 'hold', hold: { kind: 'deaths-unproven', alive: false } });
    }
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        attemptId: 'recovery-attempt',
        blockers: [{ owner: 'succession-startup', reason: 'attempt process deaths are unproven (startup 1 of 3)' }],
      },
    });
  });

  it('should record serving at the instant its deadline check passed, even when the clock crosses it after', async () => {
    const base = runtimeFixture();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(base, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    const writer = joinSuccessionWriterGeneration(base, settled.store);
    writer.park();
    const generation = advanceSuccessionWriterGeneration(base, writer.generation, settled.store);
    writer.rebind(generation);
    writer.unpark();
    const deadline = Date.now() + 60_000;
    const attemptId = base.ids.uuid();
    const written = await compareAndSwapUpgradeIntent(base.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'incumbent',
        pid: process.pid,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build: current, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId,
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: process.pid, incarnation: null },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(deadline).toISOString(),
      completionReceipt: null,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    // The successor reads its clock twice before serving; the wall clock crosses the deadline right after.
    let reads = 0;
    const runtime: Runtime = {
      ...base,
      time: { ...base.time, now: () => (++reads <= 2 ? deadline - 1 : deadline + 1_000) },
    };
    const child: SuccessionAttemptChild = {
      attemptId,
      bootToken: 'boot-token',
      epochKey: encodeResolvedStoreEpoch(base, settled.store),
      receiptIds: [],
      recovery: false,
      adoptListeners: async () => undefined,
      acknowledge: async () => undefined,
      waitForWritersParked: async () => undefined,
      waitForServing: async () => undefined,
      isServing: () => false,
      markServing: () => undefined,
    };

    await publishAttemptServing(runtime, child, { db: settled.db, store: settled.store, generation }, null, {
      instanceId: 'successor',
      publishDiscovery: () => undefined,
      listener: { server: createServer(), sockets: new Set<Socket>(), socketPath: null },
      productVersion: format.productVersion,
      signal: new AbortController().signal,
      interposition: { at: () => undefined },
    });
    settled.db.close();

    const serving = observeSuccessionServing(base, attemptId);
    expect(serving).not.toBeNull();
    expect(Date.parse(serving?.recordedAt ?? '')).toBeLessThan(deadline);
  });
});

describe('waiter-launched upgrade completion', () => {
  async function waiterAttempt(attemptDeadline: string) {
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const base = runtimeFixture();
    let now = Date.parse('2026-09-25T00:00:00.000Z');
    const runtime: Runtime = {
      ...base,
      time: { ...base.time, now: () => (now += 1) },
      env: {
        ...base.env,
        get: (name: string) => (name === 'CORAL_STARTUP_ATTEMPT_ID' ? 'waiter-attempt' : base.env.get(name)),
      },
    };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    writerGeneration.joinSuccessionWriterGeneration(runtime, settled.store);
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'legacy',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build: current, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'waiter-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: 1234, incarnation: null },
      attemptChild: null,
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline,
      completionReceipt: null,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('this process has no observable incarnation');
    const complete = () =>
      completeWaiterLaunchedUpgrade(runtime, current, settled.store, 'target', process.pid, incarnation);
    return { runtime, complete, revision: written.intent.revision };
  }

  it('should leave an attempt whose deadline passed to its waiter instead of failing the serving target', async () => {
    const { runtime, complete, revision } = await waiterAttempt('2026-09-24T23:59:30.000Z');

    await expect(complete()).resolves.toBeUndefined();
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { revision, disposition: 'attempting', completionReceipt: null },
    });
    expect(writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt')).toBeNull();
  });

  it('should complete an attempt whose intent changed while its serving record was being written', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    let raced = false;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      const served = record(...args);
      if (!raced) {
        raced = true;
        const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
        if (observed.kind !== 'readable') throw new Error('intent disappeared');
        void compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, observed.intent.revision, {
          ...observed.intent,
          blockers: [{ owner: 'waiter', reason: 'renewed' }],
        });
      }
      return served;
    });

    await complete();

    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'completed', completionReceipt: { attemptId: 'waiter-attempt' } },
    });
  });
});

describe('recorded unserved mint discard at startup', () => {
  /** Epoch 1 serves again after the retirement attempt that minted epoch 2 failed and could not discard it. */
  async function recordedUnservedMint(): Promise<Readonly<{ runtime: Runtime; mint: string }>> {
    const runtime = runtimeFixture();
    const format = currentCoralStoreFormat();
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint },
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    const mint = epochDirectory(dbDir, '2');
    cpSync(epochDirectory(dbDir, '1'), mint, { recursive: true });
    writeFileSync(
      join(mint, '.retirement-attempt.v1.json'),
      `${JSON.stringify({ version: 'v1', attemptId: 'failed' })}\n`,
    );
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'gone',
        pid: await exitedPid(),
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/missing/target' },
      attemptId: null,
      attemptOwner: null,
      disposition: 'deferred',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      unservedMintDiscard: { attemptId: 'failed', incumbentEpochKey: encodeResolvedStoreEpoch(runtime, settled.store) },
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    return { runtime, mint };
  }

  it('should discard a recorded unserved mint and clear its record', async () => {
    const { runtime, mint } = await recordedUnservedMint();

    expect(await retryRecordedMintDiscard(runtime)).toEqual({ kind: 'discarded' });
    expect(existsSync(mint)).toBe(false);
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { unservedMintDiscard: null },
    });
  });

  it('should keep the record while a reader still holds the mint', async () => {
    const { runtime, mint } = await recordedUnservedMint();
    const reader = createSharedFileLockSync(join(mint, '.lock'));
    try {
      expect(await retryRecordedMintDiscard(runtime)).toEqual({
        kind: 'held',
        reason: expect.stringContaining('removal was') as unknown,
      });
    } finally {
      reader();
    }
    expect(existsSync(mint)).toBe(true);
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { unservedMintDiscard: { attemptId: 'failed' } },
    });
    // Beside its predecessor the mint is never read as the store; once that epoch is protected away, it would be.
    expect(heldUnservedMint(runtime)).toBeNull();
    protectStoreEpoch(runtime, resolvedStoreEpoch(realpathSync(runtime.paths.coral.store.dbDir), '1'));
    expect(heldUnservedMint(runtime)).toMatchObject({ kind: 'unserved-mint-held', attemptId: 'failed' });
  });
});
