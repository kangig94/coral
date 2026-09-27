import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeServedIntentAtCleanExit,
  completeWaiterLaunchedUpgrade,
  dischargeDeadSuccessionAttempt,
  heldUnservedMint,
  holdFailedCommittedRecovery,
  openPreferredStoreEpoch,
  prepareCommittedSuccessorRecovery,
  publishAttemptServing,
  resolveIncompleteSuccessionAtStartup,
  retryRecordedMintDiscard,
  SuccessionAttemptStartupHoldError,
  type IncompleteSuccessionResolution,
  type SuccessionStartupHold,
} from '#src/coordinator/succession/startup.js';
import { successionTargetKey, type SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { recordRetirementDisposition } from '#src/coordinator/succession/retirement-disposition.js';
import { isProcessIncarnation, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntentChange } from '#src/infra/upgrade-intent.js';
import { writeBackendInfo } from '#src/infra/backend-discovery.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
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
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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
  it('retires archived attempts and resolves the current recovery grant in the same startup', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedPid();
    const owner = { kind: 'incumbent' as const, instanceId: 'incumbent', pid: dead, incarnation: null };
    const incumbent = { ...owner, version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod' as const };
    const completed = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'completed-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'completed-attempt',
      attemptOwner: owner,
      disposition: 'completed',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: {
        kind: 'serving',
        attemptId: 'completed-attempt',
        successor: { instanceId: 'successor', pid: dead, incarnation: null, build },
        epochKey: 'epoch-key',
        controlGeneration: 1,
        acceptedObligations: [],
        recordedAt: new Date().toISOString(),
      },
    });
    if (completed.kind !== 'written') throw new Error(`intent seed was ${completed.kind}`);
    const retired = {
      ...completed.intent,
      requestId: 'retired-request',
      attemptId: 'retired-attempt',
      disposition: 'pending' as const,
      completionReceipt: null,
    };
    const closed = {
      ...retired,
      requestId: 'closed-request',
      attemptId: null,
      attemptOwner: null,
      disposition: 'closed' as const,
    };
    const current = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      completed.intent.revision,
      {
        ...retired,
        requestId: 'current-request',
        attemptId: 'recovery-attempt',
        disposition: 'deferred',
        recoveryAttemptId: 'recovery-attempt',
        recoveryBuildSetId: build.buildSetId,
        successionPreparation: preparation('recovery-attempt'),
        supersededAttempts: [retired, completed.intent, closed],
      },
    );
    if (current.kind !== 'written') throw new Error(`replacement seed was ${current.kind}`);

    await expect(resolveAt(runtime, 'startup-1')).resolves.toMatchObject({
      kind: 'hold',
      hold: { kind: 'grant-controller-unavailable', attemptId: 'recovery-attempt' },
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { attemptId: 'recovery-attempt', supersededAttempts: [] },
    });
  });

  it('lets the waiter-launched target start while its waiter is alive', async () => {
    const base = runtimeFixture();
    const attemptId = 'waiter-attempt';
    const written = await compareAndSwapUpgradeIntent(base.paths.coral.coordinator.runDir, null, {
      requestId: 'waiter-request',
      incumbent: {
        instanceId: 'old',
        pid: process.pid,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId,
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);

    await expect(resolveAt(base, 'other-startup')).resolves.toMatchObject({
      kind: 'hold',
      hold: { kind: 'deaths-unproven' },
    });
    const runtime = {
      ...base,
      env: {
        ...base.env,
        get: (name: string) => (name === 'CORAL_STARTUP_ATTEMPT_ID' ? attemptId : base.env.get(name)),
      },
    };
    await expect(
      resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild: build,
        startupId: 'waiter-child',
        prepareRecoveryGrantHandoff: () => null,
      }),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('should retire a waiter attempt whose owner and child are gone before serving', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedIncarnation();
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'waiter-request',
      incumbent: {
        instanceId: 'old',
        pid: dead.pid,
        incarnation: dead.incarnation,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'dead-waiter',
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', ...dead },
      attemptChild: { attemptId: 'dead-waiter', ...dead },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);

    await expect(resolveAt(runtime, 'restart')).resolves.toEqual({ kind: 'retire', attemptId: 'dead-waiter' });
  });

  it('should release an attempt after a crash following the exhausted patience write', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    const subject = 'recovery-attempt';
    const path = join(
      runtime.paths.coral.coordinator.runDir,
      'succession-startup-patience.v1',
      `${runtime.ids.sha256(subject)}.json`,
    );
    runtime.storage.mkdirSync(join(runtime.paths.coral.coordinator.runDir, 'succession-startup-patience.v1'), {
      recursive: true,
    });
    writeFileSync(
      path,
      JSON.stringify({ version: 'v1', attemptId: subject, startupId: 'crashed', startups: 3, countedAt: Date.now() }),
    );

    await expect(resolveAt(runtime, 'restart')).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { attemptId: null, recoveryAttemptId: null },
    });
  });

  it('should hold an unsupported active intent before ordinary startup', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    const path = upgradeIntentPath(runtime.paths.coral.coordinator.runDir);
    const intent = JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...intent, disposition: 'transferring' }));
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('unsupported');

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toMatchObject({ kind: 'unsupported-intent' });
  });

  it('holds a corrupt active intent until its recorded startup patience expires', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    writeFileSync(upgradeIntentPath(runtime.paths.coral.coordinator.runDir), '{"version":');
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('corrupt');

    const hold = await holdOf(resolveAt(runtime, 'startup-1'));
    expect(hold).toMatchObject({ kind: 'unreadable-intent', source: 'corrupt' });
    if (hold.kind !== 'unreadable-intent') throw new Error('Expected an unreadable intent hold.');
    const subject = `${hold.kind}:${hold.fingerprint}`;
    const patience = join(
      runtime.paths.coral.coordinator.runDir,
      'succession-startup-patience.v1',
      `${runtime.ids.sha256(subject)}.json`,
    );
    expect(JSON.parse(runtime.storage.readFileSync(patience, 'utf-8'))).toMatchObject({
      attemptId: subject,
      startups: 1,
    });
    expect(await holdOf(resolveAt(runtime, 'startup-2'))).toMatchObject({
      kind: 'unreadable-intent',
      source: 'corrupt',
    });
    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
    await expect(resolveAt(runtime, 'startup-4')).resolves.toEqual({ kind: 'none' });
  });

  it('holds an unreadable active intent under the same bounded startup patience', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    const path = upgradeIntentPath(runtime.paths.coral.coordinator.runDir);
    rmSync(path);
    runtime.storage.mkdirSync(path);
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('unreadable');

    expect(await holdOf(resolveAt(runtime, 'startup-1'))).toMatchObject({
      kind: 'unreadable-intent',
      source: 'unreadable',
    });
    expect(await holdOf(resolveAt(runtime, 'startup-2'))).toMatchObject({ kind: 'unreadable-intent' });
    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
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

  it('recovers a superseded dead attempt without clearing the replacement waiter intent', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedPid();
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'old-request',
      incumbent: {
        instanceId: 'old-incumbent',
        pid: dead,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'old-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: 'old-incumbent', pid: dead, incarnation: null },
      attemptChild: null,
      disposition: 'pending',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation('old-attempt'),
    });
    if (written.kind !== 'written') throw new Error('old attempt was not recorded');
    const replaced = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      written.intent.revision,
      {
        ...written.intent,
        requestId: 'new-request',
        attemptId: 'new-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
        disposition: 'attempting',
        attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
        supersededAttempts: [written.intent],
      },
    );
    if (replaced.kind !== 'written') throw new Error('replacement waiter was not recorded');

    await expect(resolveAt(runtime, 'startup-1')).resolves.toMatchObject({
      kind: 'hold',
      hold: { kind: 'deaths-unproven', attemptId: 'new-attempt' },
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        requestId: 'new-request',
        attemptId: 'new-attempt',
        attemptOwner: { kind: 'waiter' },
        supersededAttempts: [],
      },
    });
  });

  it('keeps a superseded recovery hold visible on the replacement intent', async () => {
    const runtime = runtimeFixture();
    const dead = await exitedPid();
    const childIncarnation = 'recorded-child-incarnation';
    if (!isProcessIncarnation(childIncarnation)) throw new Error('child incarnation is not well-formed');
    const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'old-request',
      incumbent: {
        instanceId: 'old-incumbent',
        pid: dead,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'old-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: 'old-incumbent', pid: dead, incarnation: null },
      attemptChild: { attemptId: 'old-attempt', pid: dead, incarnation: childIncarnation },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: preparation('old-attempt', [
        {
          owner: 'durable-cli',
          generation: 1,
          attemptId: 'old-attempt',
          receiptId: 'durable-cli:old-attempt',
          recoveryGrantId: 'grant-1',
          payload: null,
        },
      ]),
    });
    if (written.kind !== 'written') throw new Error('old attempt was not recorded');
    const replaced = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      written.intent.revision,
      {
        ...written.intent,
        requestId: 'new-request',
        attemptId: null,
        attemptOwner: null,
        attemptChild: null,
        disposition: 'pending',
        supersededAttempts: [written.intent],
      },
    );
    if (replaced.kind !== 'written') throw new Error('replacement was not recorded');

    await expect(holdOf(resolveAt(runtime, 'startup-1'))).resolves.toMatchObject({
      kind: 'recovery-grants-unverified',
      attemptId: 'old-attempt',
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        requestId: 'new-request',
        supersededAttempts: [{ attemptId: 'old-attempt' }],
        blockers: [{ owner: 'succession-startup', reason: expect.stringContaining('recovery grants') }],
      },
    });
    await expect(holdOf(resolveAt(runtime, 'startup-2'))).resolves.toMatchObject({
      kind: 'recovery-grants-unverified',
    });
    await expect(resolveAt(runtime, 'startup-3')).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        requestId: 'new-request',
        supersededAttempts: [],
        abandonedSupersededAttempts: [{ attemptId: 'old-attempt' }],
        blockers: [{ owner: 'succession-startup', reason: expect.stringContaining('abandoned after 3 startups') }],
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

  it('should release exhausted committed recovery to the ordinary path in this startup', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: await exitedPid(), incarnation: null });
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('intent seed is unreadable');
    const recovery = {
      intent: {
        ...observed.intent,
        completionReceipt: {
          kind: 'serving' as const,
          attemptId: 'recovery-attempt',
          successor: { instanceId: 'successor', pid: process.pid, incarnation: null, build },
          epochKey: 'epoch-key',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date().toISOString(),
        },
      },
    };
    for (const startupId of ['startup-1', 'startup-2']) {
      atStartup(runtime, startupId);
      await expect(
        holdFailedCommittedRecovery(runtime, startupId, recovery, new Error('failed')),
      ).rejects.toBeInstanceOf(SuccessionAttemptStartupHoldError);
    }
    atStartup(runtime, 'startup-3');
    await expect(holdFailedCommittedRecovery(runtime, 'startup-3', recovery, new Error('failed'))).resolves.toBe(
      'abandoned',
    );
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
    await expect(openAt('startup-4')).resolves.toBeNull();
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
    return { runtime, complete, store: settled.store, revision: written.intent.revision };
  }

  it('advances past an earlier serving generation when the retired incumbent is gone', async () => {
    const { runtime, complete, store } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('intent disappeared');
    const retired = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      observed.intent.revision,
      {
        ...observed.intent,
        incumbent: { ...observed.intent.incumbent, pid: await exitedPid() },
      },
    );
    if (retired.kind !== 'written') throw new Error('retired incumbent was not recorded');
    const generation = writerGeneration.observeSuccessionWriterGeneration(runtime);
    if (generation === null) throw new Error('writer generation disappeared');
    const writer = joinSuccessionWriterGeneration(runtime, store);
    const oldServing = writerGeneration.recordSuccessionServing(runtime, generation, {
      attemptId: 'earlier-attempt',
      epochKey: encodeResolvedStoreEpoch(runtime, store),
      successorInstanceId: 'earlier-successor',
      controlGeneration: generation.generation,
      recordedAt: '2026-09-24T00:00:00.000Z',
    });

    await complete();

    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'completed', completionReceipt: { attemptId: 'waiter-attempt' } },
    });
    expect(writerGeneration.observePriorSuccessionServing(runtime, 'earlier-attempt')).toEqual(oldServing);
    expect(writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt')?.controlGeneration).toBe(
      generation.generation + 1,
    );
    expect(() => writer.assertCurrent()).not.toThrow();
  });

  it('holds an earlier serving generation while the recorded incumbent is alive', async () => {
    const { runtime, complete, store } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('intent disappeared');
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('this process has no incarnation');
    await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, observed.intent.revision, {
      ...observed.intent,
      incumbent: { ...observed.intent.incumbent, pid: process.pid, incarnation },
    });
    const generation = writerGeneration.observeSuccessionWriterGeneration(runtime);
    if (generation === null) throw new Error('writer generation disappeared');
    writerGeneration.recordSuccessionServing(runtime, generation, {
      attemptId: 'earlier-attempt',
      epochKey: encodeResolvedStoreEpoch(runtime, store),
      successorInstanceId: 'earlier-successor',
      controlGeneration: generation.generation,
      recordedAt: '2026-09-24T00:00:00.000Z',
    });

    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
    expect(writerGeneration.observeSuccessionWriterGeneration(runtime)).toEqual(generation);
  });

  it('should leave an attempt whose deadline passed to its waiter instead of failing the serving target', async () => {
    const { runtime, complete, revision } = await waiterAttempt('2026-09-24T23:59:30.000Z');

    await expect(complete()).resolves.toBeUndefined();
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { revision, disposition: 'attempting', completionReceipt: null },
    });
    expect(writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt')).toBeNull();
  });

  it('should hold a recorded child whose serving publication missed the deadline', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('intent disappeared');
    const deadline = new Date(runtime.time.now() + 1).toISOString();
    const changed = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      observed.intent.revision,
      {
        ...observed.intent,
        attemptDeadline: deadline,
      },
    );
    if (changed.kind !== 'written') throw new Error(`deadline update was ${changed.kind}`);

    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
    expect(writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt')).toBeNull();
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'attempting', attemptChild: { attemptId: 'waiter-attempt' } },
    });
  });

  it('should complete an attempt whose intent changed while its serving record was being written', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    let racedRevision: number | null = null;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      const served = record(...args);
      if (racedRevision === null) {
        const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
        if (observed.kind !== 'readable') throw new Error('intent disappeared');
        racedRevision = observed.intent.revision + 1;
        writeFileSync(
          upgradeIntentPath(runtime.paths.coral.coordinator.runDir),
          JSON.stringify({
            ...observed.intent,
            revision: racedRevision,
            blockers: [{ owner: 'waiter', reason: 'renewed' }],
          }),
        );
        expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
          kind: 'readable',
          intent: { revision: racedRevision, blockers: [{ owner: 'waiter', reason: 'renewed' }] },
        });
      }
      return served;
    });

    await complete();

    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'completed', completionReceipt: { attemptId: 'waiter-attempt' } },
    });
    expect(racedRevision).not.toBeNull();
  });

  it('should complete a recorded child after its waiter expires during the serving write', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    let expired = false;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      const served = record(...args);
      if (expired) return served;
      expired = true;
      const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      writeFileSync(
        upgradeIntentPath(runtime.paths.coral.coordinator.runDir),
        JSON.stringify({
          ...observed.intent,
          revision: observed.intent.revision + 1,
          disposition: 'deferred',
          blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
          retryCondition: {
            kind: 'incumbent-retirement',
            evidence: 'legacy incumbent retired; successor attempt expired',
          },
        }),
      );
      return served;
    });

    await complete();
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        completionReceipt: { attemptId: 'waiter-attempt' },
      },
    });
  });

  it('should recover a serving receipt after expiry interrupts its completion write', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      record(...args);
      const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      writeFileSync(
        upgradeIntentPath(runtime.paths.coral.coordinator.runDir),
        JSON.stringify({
          ...observed.intent,
          revision: observed.intent.revision + 1,
          disposition: 'deferred',
          blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
          retryCondition: {
            kind: 'incumbent-retirement',
            evidence: 'legacy incumbent retired; successor attempt expired',
          },
        }),
      );
      throw new Error('simulated crash after serving write');
    });
    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
    vi.restoreAllMocks();

    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    await prepareCommittedSuccessorRecovery(
      runtime,
      { pluginRoot: '/plugin', instanceId: 'restart' },
      format,
      current,
      () => false,
    );
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        completionReceipt: { attemptId: 'waiter-attempt' },
      },
    });
  });

  it('should hold when its serving record cannot receive a completion receipt', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      const served = record(...args);
      const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      writeFileSync(
        upgradeIntentPath(runtime.paths.coral.coordinator.runDir),
        JSON.stringify({
          ...observed.intent,
          revision: observed.intent.revision + 1,
          disposition: 'closed',
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
        }),
      );
      return served;
    });

    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
  });

  it('should recover a waiter receipt after its serving write survives a crash', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      record(...args);
      throw new Error('simulated crash after serving write');
    });
    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'attempting', attemptChild: { attemptId: 'waiter-attempt' }, completionReceipt: null },
    });
    vi.restoreAllMocks();

    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('waiter intent is unreadable');
    const legacy = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, observed.intent.revision, {
      ...observed.intent,
      attemptChild: null,
    });
    if (legacy.kind !== 'written') throw new Error(`legacy intent seed was ${legacy.kind}`);
    writeBackendInfo(
      {
        pid: process.pid,
        port: 4000,
        host: '127.0.0.1',
        socketPath: runtime.paths.coral.coordinator.socketPath,
        bundleHash: current.bundleHash,
        flavor: current.flavor,
        namespace: 'test',
        startedAt: runtime.time.now(),
        token: 'token',
        bootToken: 'boot-token',
        instanceId: 'target',
        version: current.version,
      },
      runtime,
    );
    await prepareCommittedSuccessorRecovery(
      runtime,
      { pluginRoot: '/plugin', instanceId: 'restart' },
      format,
      current,
      () => false,
    );
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'completed', completionReceipt: { attemptId: 'waiter-attempt' } },
    });
  });

  it('should release an unattributable legacy waiter serving record after patience', async () => {
    const { runtime, complete } = await waiterAttempt('2026-09-25T00:00:30.000Z');
    const record = writerGeneration.recordSuccessionServing;
    vi.spyOn(writerGeneration, 'recordSuccessionServing').mockImplementation((...args) => {
      record(...args);
      throw new Error('simulated crash after serving write');
    });
    await expect(complete()).rejects.toThrow('waiter serving record has no completion receipt');
    vi.restoreAllMocks();
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('waiter intent is unreadable');
    const legacy = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, observed.intent.revision, {
      ...observed.intent,
      attemptChild: null,
    });
    if (legacy.kind !== 'written') throw new Error(`legacy intent seed was ${legacy.kind}`);
    const patienceDir = join(runtime.paths.coral.coordinator.runDir, 'succession-startup-patience.v1');
    runtime.storage.mkdirSync(patienceDir, { recursive: true });
    writeFileSync(
      join(patienceDir, `${runtime.ids.sha256('waiter-attempt')}.json`),
      JSON.stringify({
        version: 'v1',
        attemptId: 'waiter-attempt',
        startupId: 'earlier',
        startups: 2,
        countedAt: 0,
      }),
    );
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const previousServing = writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt');
    if (previousServing === null) throw new Error('waiter serving record is unavailable');

    await prepareCommittedSuccessorRecovery(
      runtime,
      { pluginRoot: '/plugin', instanceId: 'restart' },
      format,
      current,
      () => false,
    );
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({ intent: { attemptId: null } });
    expect(writerGeneration.observeSuccessionServing(runtime, 'waiter-attempt')).toBeNull();
    const generation = writerGeneration.observeSuccessionWriterGeneration(runtime);
    if (generation === null) throw new Error('writer generation is unavailable');
    expect(() =>
      writerGeneration.recordSuccessionServing(runtime, generation, {
        attemptId: 'next-waiter-attempt',
        epochKey: previousServing.epochKey,
        successorInstanceId: 'next-target',
        controlGeneration: generation.generation,
        recordedAt: new Date().toISOString(),
      }),
    ).not.toThrow();
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

describe('served attempt reconciliation', () => {
  it('does not charge a newer attempt for a serving receipt it lost a race to reconcile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-red-r5-reconciliation-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const format = currentCoralStoreFormat();
    const build = {
      version: format.productVersion,
      buildSetId: '00000000-0000-4000-8000-000000000001',
      flavor: 'prod' as const,
      storeFormatFingerprint: format.fingerprint,
      bundleHash: '0123456789abcdef',
      cliBundleHash: '0123456789abcdef',
      claudeAppserverBundleHash: '0123456789abcdef',
      durableWrapperBundleHash: '0123456789abcdef',
    };
    const store = settleStoreEpoch(runtime, {
      storeFormat: format,
      build,
      authorizeMint: authorizeFixtureStoreMint,
    });
    store.db.close();
    const writer = writerGeneration.joinSuccessionWriterGeneration(runtime, store.store);
    const epochKey = encodeResolvedStoreEpoch(runtime, store.store);
    const oldAttemptId = 'served-attempt';
    const target = { build, pluginRootLabel: '/installed/target' };
    const seeded = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'old-request',
      incumbent: {
        instanceId: 'legacy',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target,
      attemptId: oldAttemptId,
      attemptOwner: { kind: 'waiter', instanceId: 'old-waiter', pid: 2222, incarnation: null },
      attemptChild: { attemptId: oldAttemptId, pid: 3333, incarnation: testIncarnation('old-target') },
      disposition: 'deferred',
      blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'legacy incumbent retired; successor attempt expired' },
      attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
      completionReceipt: null,
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);
    writerGeneration.recordSuccessionServing(runtime, writer.generation, {
      attemptId: oldAttemptId,
      epochKey,
      successorInstanceId: 'old-target',
      controlGeneration: writer.generation.generation,
      recordedAt: new Date().toISOString(),
    });

    const observeServing = writerGeneration.observeSuccessionServing;
    let observations = 0;
    vi.spyOn(writerGeneration, 'observeSuccessionServing').mockImplementation((...args) => {
      const serving = observeServing(...args);
      if (++observations === 2) {
        const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
        if (observed.kind !== 'readable') throw new Error('old intent disappeared');
        writeFileSync(
          upgradeIntentPath(runtime.paths.coral.coordinator.runDir),
          JSON.stringify({
            ...observed.intent,
            revision: observed.intent.revision + 1,
            requestId: 'new-request',
            attemptId: 'new-attempt',
            attemptOwner: { kind: 'incumbent', instanceId: 'new-incumbent', pid: 4444, incarnation: null },
            attemptChild: null,
            disposition: 'attempting',
            blockers: [],
            retryCondition: null,
            completionReceipt: null,
          }),
        );
      }
      return serving;
    });

    await expect(
      prepareCommittedSuccessorRecovery(
        runtime,
        { pluginRoot: '/installed/target', instanceId: 'restart' },
        format,
        build,
        () => false,
      ),
    ).resolves.toEqual({ kind: 'none' });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: { requestId: 'new-request', attemptId: 'new-attempt', blockers: [] },
    });
  });
});

describe('served intent clean exit', () => {
  it('closes a served intent while preserving newer additive fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-red-r5-clean-exit-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
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
    const seeded = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
      requestId: 'request-1',
      incumbent: {
        instanceId: 'old-incumbent',
        pid: 1111,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'served-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: 2222, incarnation: null },
      attemptChild: null,
      disposition: 'completed',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: {
        kind: 'serving',
        attemptId: 'served-attempt',
        successor: { instanceId: 'serving-instance', pid: 3333, incarnation: null, build },
        epochKey: 'epoch-1:lineage-1',
        controlGeneration: 1,
        acceptedObligations: [],
        recordedAt: '2026-09-25T00:00:00.000Z',
      },
      newerWriterStatus: { generation: 2, retained: true },
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);

    await closeServedIntentAtCleanExit(runtime, 'serving-instance', {
      instanceId: 'serving-instance',
      pid: 3333,
      incarnation: null,
      version: build.version,
      bundleHash: build.bundleHash,
      flavor: build.flavor,
    });

    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'closed',
        incumbent: { instanceId: 'serving-instance' },
        attemptId: null,
        attemptOwner: null,
        attemptChild: null,
        attemptDeadline: null,
        completionReceipt: null,
        blockers: [],
        retryCondition: null,
        newerWriterStatus: { generation: 2, retained: true },
      },
    });
  });
});
