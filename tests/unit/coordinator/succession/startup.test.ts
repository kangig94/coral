import * as epochObservation from '#src/store/epoch/observation.js';
import type * as MockedNodeProcessModule from '#src/infra/node-process.js';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  heldUnservedMint,
  prepareCommittedSuccessorRecovery,
  publishAttemptServing,
  resolveIncompleteSuccessionAtStartup,
  retryRecordedMintDiscard,
  type IncompleteSuccessionResolution,
  type SuccessionStartupHold,
} from '#src/coordinator/succession/startup.js';
import { successionTargetKey, type SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { isProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import {
  compareAndSwapUpgradeIntent,
  hasQuarantinedUpgradeIntent,
  readUpgradeIntent,
  type UpgradeIntentChange,
} from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  encodeResolvedStoreEpoch,
  epochDirectory,
  resolvedStoreEpoch,
  settleStoreEpoch,
} from '#src/store/epoch/index.js';
import { protectStoreEpoch } from '#src/store/epoch/index.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import * as writerGeneration from '#src/store/succession-writer-generation.js';
import {
  advanceSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  observeSuccessionServing,
} from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import type { SuccessionAttemptChild } from '#src/coordinator/succession/attempt-child.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';

vi.mock('#src/infra/node-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MockedNodeProcessModule>()),
  probeProcessIncarnation: (pid: number) => (pid === process.pid ? testIncarnation(pid) : null),
  observeProcessLiveness: (pid: number) => (pid === process.pid ? 'alive' : 'absent'),
}));

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
  const clock = { now: 1_700_000_000_000, startupId: null as string | null };
  const runtime: Runtime = {
    ...base,
    time: { ...base.time, now: () => clock.now },
  };
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

async function exitedPid(): Promise<number> {
  return 41_001;
}

async function exitedIncarnation(): Promise<Readonly<{ pid: number; incarnation: ProcessIncarnation }>> {
  return { pid: 41_001, incarnation: testIncarnation(41_001) };
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
  it('quarantines a corrupt intent and lets ordinary startup continue', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    writeFileSync(upgradeIntentPath(runtime.paths.coral.coordinator.runDir), '{"version":');
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('corrupt');

    await expect(resolveAt(runtime, 'startup-1')).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('absent');
    expect(hasQuarantinedUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toBe(true);
    await expect(resolveAt(runtime, 'startup-2')).resolves.toEqual({ kind: 'none' });
  });

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

  it('holds an unserved attempting transfer whose recovery grants do not verify', async () => {
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

  it.each([false, true])(
    'holds and bounds an unattributable committed successor, unreadable identity=%s',
    async (unreadableIdentity) => {
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
      if (unreadableIdentity) vi.spyOn(epochObservation, 'observeResolvedStoreEpochKey').mockReturnValue(null);
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
          reason: unreadableIdentity
            ? 'current epoch identity is temporarily unreadable; startup recovery re-observes it within its bounded patience window'
            : 'committed successor generation cannot be attributed',
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
    },
  );

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
    const deadline = base.time.now() + 60_000;
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

  it('should complete a served attempt before choosing ordinary recovery', async () => {
    const runtime = runtimeFixture();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const writer = joinSuccessionWriterGeneration(runtime, settled.store);
    const dead = await exitedIncarnation();
    const attemptId = runtime.ids.uuid();
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    const target = { build: current, pluginRootLabel: '/installed/coral/0.11.0' };
    const prepared = {
      ...preparation(attemptId, [
        {
          owner: 'durable-cli',
          generation: 1,
          attemptId,
          receiptId: `durable-cli:${attemptId}`,
          recoveryGrantId: `grant:${attemptId}`,
          payload: null,
        },
      ]),
      targetKey: successionTargetKey(target),
      epochKey,
      stage: 'ready' as const,
      ready: {
        attemptId,
        successorPid: dead.pid,
        targetKey: successionTargetKey(target),
        epochKey,
        admissionRevision: 0,
        receiptIds: [`durable-cli:${attemptId}`],
      },
    };
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'incumbent',
        ...dead,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target,
      attemptId,
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', ...dead },
      attemptChild: { attemptId, ...dead },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
      completionReceipt: null,
      successionPreparation: prepared,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    writerGeneration.recordSuccessionServing(runtime, writer.generation, {
      attemptId,
      epochKey,
      successorInstanceId: 'successor',
      controlGeneration: writer.generation.generation,
      recordedAt: new Date().toISOString(),
    });

    await prepareCommittedSuccessorRecovery(
      runtime,
      { pluginRoot: '/plugin', instanceId: 'restart' },
      format,
      current,
      () => false,
    );
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        disposition: 'completed',
        completionReceipt: {
          attemptId,
          epochKey,
          acceptedObligations: [
            {
              owner: 'durable-cli',
              receiptId: `durable-cli:${attemptId}`,
              controlGeneration: writer.generation.generation,
            },
          ],
        },
      },
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
