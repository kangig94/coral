import { superviseActiveChild } from '#src/coordinator-launch/active-child.js';
import { watchChild } from '#src/coordinator-launch/child-watch.js';
import { pendingIntent } from '#src/coordinator-launch/pending-upgrade.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';
import * as epochObservation from '#src/store/epoch/observation.js';
import type * as MockedNodeProcessModule from '#src/infra/node-process.js';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completeSupervisorLegacyUpgrade,
  closeServedIntentAtCleanExit,
  heldUnservedMint,
  prepareCommittedSuccessorRecovery,
  openPreferredStoreEpoch,
  publishAttemptServing,
  resolveIncompleteSuccessionAtStartup,
  retryRecordedMintDiscard,
  createStartupHandoffObserver,
  startupHandoffAbandoned,
  abandonedStartupHandoffRecoveryHold,
  type IncompleteSuccessionResolution,
  type SuccessionStartupHold,
} from '#src/coordinator/succession/startup.js';
import { recordControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { prepareDurableCliRecoveryGrant } from '#src/coordinator/services/durable-cli-transfer.js';
import { successionTargetKey, type SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { isProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import {
  compareAndSwapUpgradeIntent,
  hasQuarantinedUpgradeIntent,
  readUpgradeIntent,
  visibleUpgradeIntent,
  type UpgradeIntentChange,
} from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
import { launchAdmissionPath } from '#src/infra/launch-admission-record.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import {
  discardCurrentStoreEpoch,
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

vi.mock('#src/coordinator-launch/child-watch.js', () => ({ watchChild: vi.fn() }));

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

function olderExitingBuild(): {
  target: ValidatedHandoffTarget;
  backend: string;
  manifest: typeof build;
  pluginRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-exiting-build-'));
  roots.push(root);
  mkdirSync(join(root, 'bridge'));
  const bundleDir = realpathSync(join(root, 'bridge'));
  const source = 'process.exit(0);';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const manifest = {
    ...build,
    version: '0.10.27',
    buildSetId: '00000000-0000-4000-8000-000000000027',
    bundleHash: hash,
    cliBundleHash: hash,
    claudeAppserverBundleHash: hash,
    durableWrapperBundleHash: hash,
  };
  for (const file of ['coral-backend.cjs', 'coral-cli', 'coral-claude-appserver.cjs', 'coral-durable-wrapper.cjs'])
    writeFileSync(join(bundleDir, file), source);
  writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest));
  const validated = createForeignTargetValidator()(bundleDir, manifest);
  if (validated.kind !== 'validated') throw new Error(`fixture validation: ${validated.kind}`);
  return { target: validated.target, backend: join(bundleDir, 'coral-backend.cjs'), manifest, pluginRoot: root };
}

describe('startup handoff patience', () => {
  it('should abandon and discharge a recovery handoff after target patience is exhausted', async () => {
    const runtime = runtimeFixture();
    const older = olderExitingBuild();
    const dead = await exitedIncarnation();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    const priorWriter = joinSuccessionWriterGeneration(runtime, settled.store);
    writerGeneration.recordSuccessionServing(runtime, priorWriter.generation, {
      attemptId: 'incumbent-prior',
      epochKey,
      successorInstanceId: 'incumbent',
      controlGeneration: priorWriter.generation.generation,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    });
    advanceSuccessionWriterGeneration(runtime, priorWriter.generation, settled.store);
    const receipt = {
      owner: 'durable-cli',
      generation: 1,
      attemptId: 'recovery-attempt',
      receiptId: 'receipt',
      recoveryGrantId: 'grant',
      payload: null,
    };
    await seedRecoveryGrant(runtime, dead, { ...preparation('recovery-attempt', [receipt]), epochKey });
    const resolve = (startupId: string) => {
      atStartup(runtime, startupId);
      return resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild: current,
        storeFormat: format,
        startupId,
        prepareRecoveryGrantHandoff: () => older.target,
      });
    };
    for (const startupId of ['boot-1', 'boot-2', 'boot-3']) {
      const resolution = await resolve(startupId);
      expect(resolution.kind).toBe('handoff');
      if (resolution.kind !== 'handoff') throw new Error('expected recovery handoff');
      await createStartupHandoffObserver(runtime, startupId, resolution.target, resolution.subject)('not-serving');
    }
    await expect(resolve('boot-4')).resolves.toEqual({ kind: 'ordinary', epochKey });
    const intent = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    expect(intent).toMatchObject({
      intent: {
        attemptId: null,
        recoveryAttemptId: null,
        blockers: expect.arrayContaining([
          expect.objectContaining({ owner: 'succession-startup', reason: expect.stringContaining('abandoned:') }),
        ]),
      },
    });
    await expect(resolve('boot-5')).resolves.toEqual({ kind: 'none' });
  });

  it('should recover directly when the failed attempt never advanced the incumbent serving generation', async () => {
    const runtime = runtimeFixture();
    const older = olderExitingBuild();
    const format = currentCoralStoreFormat();
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint },
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const writer = joinSuccessionWriterGeneration(runtime, settled.store);
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    writerGeneration.recordSuccessionServing(runtime, writer.generation, {
      attemptId: 'incumbent-serving',
      epochKey,
      successorInstanceId: 'incumbent',
      controlGeneration: writer.generation.generation,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    });
    await seedRecoveryGrant(runtime, await exitedIncarnation(), {
      ...preparation('recovery-attempt', [
        {
          owner: 'durable-cli',
          generation: 1,
          attemptId: 'recovery-attempt',
          receiptId: 'receipt',
          recoveryGrantId: 'grant',
          payload: null,
        },
      ]),
      epochKey,
    });
    await expect(
      resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild: { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint },
        storeFormat: format,
        startupId: 'boot',
        prepareRecoveryGrantHandoff: () => older.target,
      }),
    ).resolves.toEqual({ kind: 'ordinary', epochKey });
    expect(observeSuccessionServing(runtime, 'incumbent-serving')?.controlGeneration).toBe(
      writer.generation.generation,
    );
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({ intent: { attemptId: null } });
  });

  it('should retain the discard owner when an exhausted unserved attempt has an unreadable retirement disposition', async () => {
    const runtime = runtimeFixture();
    const older = olderExitingBuild();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const writer = joinSuccessionWriterGeneration(runtime, settled.store);
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    writerGeneration.recordSuccessionServing(runtime, writer.generation, {
      attemptId: 'incumbent-serving',
      epochKey,
      successorInstanceId: 'incumbent',
      controlGeneration: writer.generation.generation,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    });
    const dead = await exitedIncarnation();
    await seedRecoveryGrant(runtime, dead, { ...preparation('recovery-attempt'), epochKey });
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('missing attempt');
    const written = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      observed.intent.revision,
      {
        ...observed.intent,
        recoveryAttemptId: null,
        disposition: 'attempting',
        attemptChild: { attemptId: 'recovery-attempt', ...dead },
      },
    );
    if (written.kind !== 'written') throw new Error('fixture intent refused');
    const directory = join(runtime.paths.coral.coordinator.runDir, 'retirement-dispositions.v1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'recovery-attempt.json'), '{');
    for (let boot = 1; boot <= 3; boot += 1) {
      atStartup(runtime, `boot-${boot}`);
      await createStartupHandoffObserver(runtime, `boot-${boot}`, older.target, {
        purpose: 'unserved-attempt',
        identity: 'recovery-attempt',
      })('not-serving');
    }
    await expect(
      resolveIncompleteSuccessionAtStartup({
        runtime,
        currentBuild: current,
        storeFormat: format,
        startupId: 'boot-4',
        prepareRecoveryGrantHandoff: () => older.target,
      }),
    ).resolves.toEqual({
      kind: 'recover',
      preferredEpochKey: epochKey,
      attempt: { attemptId: 'recovery-attempt', epochKey, discardAttemptId: 'recovery-attempt', force: false },
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { attemptId: 'recovery-attempt' },
    });
  });

  it.each(['alive', 'unknown'] as const)(
    'should hold an unchanged incumbent generation while a later controller is %s',
    async (evidence) => {
      const runtime = runtimeFixture();
      const older = olderExitingBuild();
      const format = currentCoralStoreFormat();
      const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
      const settled = settleStoreEpoch(runtime, {
        storeFormat: format,
        build: current,
        authorizeMint: authorizeFixtureStoreMint,
      });
      settled.db.close();
      const writer = joinSuccessionWriterGeneration(runtime, settled.store);
      const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
      writerGeneration.recordSuccessionServing(runtime, writer.generation, {
        attemptId: 'incumbent-serving',
        epochKey,
        successorInstanceId: 'incumbent',
        controlGeneration: writer.generation.generation,
        recordedAt: new Date(runtime.time.now()).toISOString(),
      });
      await seedRecoveryGrant(runtime, await exitedIncarnation(), { ...preparation('recovery-attempt'), epochKey });
      recordControllerOpen(
        runtime,
        epochKey,
        'later-controller',
        null,
        older.pluginRoot,
        current,
        writer.generation.generation,
        { pid: process.pid, incarnation: evidence === 'alive' ? testIncarnation(process.pid) : null },
      );
      for (let boot = 4; boot <= 6; boot += 1) {
        atStartup(runtime, `boot-${boot}`);
        const options = {
          runtime,
          currentBuild: current,
          storeFormat: format,
          startupId: `boot-${boot}`,
          prepareRecoveryGrantHandoff: () => older.target,
        };
        await expect(resolveIncompleteSuccessionAtStartup(options)).resolves.toMatchObject({
          kind: 'hold',
          hold: { kind: 'deaths-unproven', alive: evidence === 'alive' },
        });
        expect(abandonedStartupHandoffRecoveryHold(runtime, epochKey, format, current)).toMatchObject({
          kind: 'deaths-unproven',
          alive: evidence === 'alive',
        });
      }
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        intent: { attemptId: 'recovery-attempt' },
      });
    },
  );

  it('should retain an archived recovery while another recorded writer remains live', async () => {
    const runtime = runtimeFixture();
    const target = olderExitingBuild().target;
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    const priorWriter = joinSuccessionWriterGeneration(runtime, settled.store);
    writerGeneration.recordSuccessionServing(runtime, priorWriter.generation, {
      attemptId: 'incumbent-prior',
      epochKey,
      successorInstanceId: 'incumbent',
      controlGeneration: priorWriter.generation.generation,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    });
    advanceSuccessionWriterGeneration(runtime, priorWriter.generation, settled.store);
    await seedRecoveryGrant(runtime, await exitedIncarnation(), { ...preparation('recovery-attempt'), epochKey });
    const archived = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (archived.kind !== 'readable') throw new Error('missing archived fixture');
    const written = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      archived.intent.revision,
      {
        ...archived.intent,
        attemptId: 'current-attempt',
        recoveryAttemptId: 'current-attempt',
        attemptOwner: {
          kind: 'incumbent',
          instanceId: 'live-current',
          pid: process.pid,
          incarnation: testIncarnation(process.pid),
        },
        successionPreparation: preparation('current-attempt'),
        supersededAttempts: [archived.intent],
      },
    );
    if (written.kind !== 'written') throw new Error('could not seed current attempt');
    const subject = { purpose: 'recovery-grant', identity: 'recovery-attempt' };
    for (const id of ['boot-1', 'boot-2', 'boot-3']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, target, subject)('not-serving');
    }
    const resolved = await resolveIncompleteSuccessionAtStartup({
      runtime,
      currentBuild: current,
      storeFormat: format,
      startupId: 'boot-4',
      prepareRecoveryGrantHandoff: () => target,
    });
    expect(resolved).toMatchObject({
      kind: 'hold',
      hold: { kind: 'deaths-unproven', attemptId: 'recovery-attempt', alive: true },
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        attemptId: 'current-attempt',
        supersededAttempts: [expect.objectContaining({ attemptId: 'recovery-attempt' })],
      },
    });
  });

  it.each(['proven', 'unknown'] as const)(
    'should recover an exhausted unserved transfer beyond boot four only with %s deaths',
    async (deaths) => {
      const runtime = runtimeFixture();
      const older = olderExitingBuild();
      const format = currentCoralStoreFormat();
      const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
      const settled = settleStoreEpoch(runtime, {
        storeFormat: format,
        build: current,
        authorizeMint: authorizeFixtureStoreMint,
      });
      settled.db.close();
      const writer = joinSuccessionWriterGeneration(runtime, settled.store);
      const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
      writerGeneration.recordSuccessionServing(runtime, writer.generation, {
        attemptId: 'incumbent-serving',
        epochKey,
        successorInstanceId: 'incumbent',
        controlGeneration: writer.generation.generation,
        recordedAt: new Date(runtime.time.now()).toISOString(),
      });
      advanceSuccessionWriterGeneration(runtime, writer.generation, settled.store);
      const attemptId = '00000000-0000-4000-8000-000000000003';
      const transfer = { epochPath: settled.store.path, jobs: [] };
      const grantId = prepareDurableCliRecoveryGrant(runtime, runtime.paths.coral.coordinator.runDir, {
        version: 'v1',
        attemptId,
        epochKey,
        incumbentInstanceId: 'incumbent',
        incumbentBuildSetId: older.manifest.buildSetId,
        transfer,
      });
      const owner = deaths === 'unknown' ? { pid: process.pid, incarnation: null } : await exitedIncarnation();
      await seedRecoveryGrant(runtime, owner);
      const seeded = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (seeded.kind !== 'readable') throw new Error('missing fixture');
      const written = await compareAndSwapUpgradeIntent(
        runtime.paths.coral.coordinator.runDir,
        seeded.intent.revision,
        {
          ...seeded.intent,
          attemptId,
          recoveryAttemptId: null,
          disposition: 'attempting',
          attemptChild: { attemptId, ...(await exitedIncarnation()) },
          successionPreparation: {
            ...preparation(attemptId, [
              {
                owner: 'durable-cli',
                generation: 1,
                attemptId,
                receiptId: 'receipt',
                recoveryGrantId: grantId,
                payload: transfer,
              },
            ]),
            epochKey,
          },
        },
      );
      if (written.kind !== 'written') throw new Error('fixture change failed');
      const subject = { purpose: 'unserved-attempt', identity: attemptId };
      for (let boot = 1; boot <= 3; boot += 1) {
        atStartup(runtime, `boot-${boot}`);
        await createStartupHandoffObserver(runtime, `boot-${boot}`, older.target, subject)('not-serving');
      }
      for (let boot = 4; boot <= 6; boot += 1) {
        atStartup(runtime, `boot-${boot}`);
        const resolution = await resolveIncompleteSuccessionAtStartup({
          runtime,
          currentBuild: current,
          storeFormat: format,
          startupId: `boot-${boot}`,
          prepareRecoveryGrantHandoff: () => older.target,
        });
        if (deaths === 'unknown') {
          expect(resolution).toMatchObject({ kind: 'hold', hold: { kind: 'deaths-unproven' } });
          expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({ intent: { attemptId } });
        } else {
          expect(['ordinary', 'none']).toContain(resolution.kind);
          const opened = await openPreferredStoreEpoch(
            { runtime, storeFormat: format, currentBuild: current, busyTimeoutMs: 750 },
            `boot-${boot}`,
            epochKey,
            null,
          );
          expect(opened).not.toBeNull();
          if (opened === null) throw new Error('ordinary recovery did not open');
          expect(opened.db.prepare('SELECT 1 AS ready').get()).toEqual({ ready: 1 });
          opened.db.close();
        }
      }
    },
  );

  it.each(['proven', 'unknown'] as const)(
    'should recover exhausted committed work beyond boot four only with %s deaths',
    async (deaths) => {
      const runtime = runtimeFixture();
      const older = olderExitingBuild();
      const format = currentCoralStoreFormat();
      const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
      const settled = settleStoreEpoch(runtime, {
        storeFormat: format,
        build: current,
        authorizeMint: authorizeFixtureStoreMint,
      });
      settled.db.close();
      const writer = joinSuccessionWriterGeneration(runtime, settled.store);
      const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
      const recordedAt = new Date(runtime.time.now()).toISOString();
      writerGeneration.recordSuccessionServing(runtime, writer.generation, {
        attemptId: 'committed-attempt',
        epochKey,
        successorInstanceId: 'successor',
        controlGeneration: writer.generation.generation,
        recordedAt,
      });
      const dead = await exitedIncarnation();
      await seedRecoveryGrant(runtime, dead);
      const seeded = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (seeded.kind !== 'readable') throw new Error('missing fixture');
      const successor = deaths === 'unknown' ? { pid: process.pid, incarnation: null } : dead;
      const written = await compareAndSwapUpgradeIntent(
        runtime.paths.coral.coordinator.runDir,
        seeded.intent.revision,
        {
          ...seeded.intent,
          attemptId: 'committed-attempt',
          recoveryAttemptId: null,
          disposition: 'completed',
          target: { build: older.manifest, pluginRootLabel: older.pluginRoot },
          completionReceipt: {
            kind: 'serving',
            attemptId: 'committed-attempt',
            successor: { instanceId: 'successor', ...successor, build: older.manifest },
            epochKey,
            controlGeneration: writer.generation.generation,
            acceptedObligations: [],
            recordedAt,
          },
        },
      );
      if (written.kind !== 'written') throw new Error('fixture change failed');
      const subject = { purpose: 'committed-recovery', identity: 'committed-attempt' };
      for (let boot = 1; boot <= 3; boot += 1) {
        atStartup(runtime, `boot-${boot}`);
        await createStartupHandoffObserver(runtime, `boot-${boot}`, older.target, subject)('not-serving');
      }
      for (let boot = 4; boot <= 6; boot += 1) {
        atStartup(runtime, `boot-${boot}`);
        const resolved = await prepareCommittedSuccessorRecovery(
          runtime,
          { pluginRoot: '/current', instanceId: `boot-${boot}` },
          format,
          current,
          () => true,
        );
        if (deaths === 'unknown') {
          expect(resolved).toMatchObject({ kind: 'hold', hold: { kind: 'deaths-unproven' } });
        } else {
          expect(resolved).toMatchObject({ kind: 'ordinary', epochKey });
          const opened = await openPreferredStoreEpoch(
            { runtime, storeFormat: format, currentBuild: current, busyTimeoutMs: 750 },
            `boot-${boot}`,
            epochKey,
            null,
          );
          expect(opened).not.toBeNull();
          if (opened === null) throw new Error('ordinary recovery did not open');
          expect(opened.db.prepare('SELECT 1 AS ready').get()).toEqual({ ready: 1 });
          opened.db.close();
        }
      }
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        intent: { disposition: 'completed', completionReceipt: { attemptId: 'committed-attempt' } },
      });
    },
  );

  it('should clear only the matching handoff blocker when a target serves', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, await exitedIncarnation());
    const first = olderExitingBuild();
    const second = olderExitingBuild();
    const subject = { purpose: 'recovery-grant', identity: 'recovery-attempt' };
    await createStartupHandoffObserver(runtime, 'boot-1', first.target, subject)('not-serving');
    await createStartupHandoffObserver(runtime, 'boot-1', second.target, subject)('not-serving');
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        blockers: [
          expect.objectContaining({ reason: expect.stringContaining(dirname(first.backend)) }),
          expect.objectContaining({ reason: expect.stringContaining(dirname(second.backend)) }),
        ],
      },
    });
    await createStartupHandoffObserver(runtime, 'boot-1', first.target, subject)('serving');
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { blockers: [expect.objectContaining({ reason: expect.stringContaining(dirname(second.backend)) })] },
    });
  });

  it('should give a replacement manifest in the same directory its own handoff patience', async () => {
    const runtime = runtimeFixture();
    const original = olderExitingBuild();
    const subject = { purpose: 'recovery-grant', identity: 'attempt-1' };
    for (const id of ['boot-1', 'boot-2', 'boot-3']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, original.target, subject)('not-serving');
    }
    expect(startupHandoffAbandoned(runtime, original.target, subject)).toBe(true);
    const replacementManifest = { ...original.manifest, buildSetId: '00000000-0000-4000-8000-000000000028' };
    const bundleDir = dirname(original.backend);
    writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(replacementManifest));
    const replacement = createForeignTargetValidator()(bundleDir, replacementManifest);
    if (replacement.kind !== 'validated') throw new Error(`fixture validation: ${replacement.kind}`);
    expect(startupHandoffAbandoned(runtime, replacement.target, subject)).toBe(false);
    for (const id of ['boot-4', 'boot-5']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, replacement.target, subject)('not-serving');
      expect(startupHandoffAbandoned(runtime, replacement.target, subject)).toBe(false);
    }
    atStartup(runtime, 'boot-6');
    await createStartupHandoffObserver(runtime, 'boot-6', replacement.target, subject)('not-serving');
    expect(startupHandoffAbandoned(runtime, replacement.target, subject)).toBe(true);
  });

  it('should give a different handoff purpose its own patience for the same target and identity', async () => {
    const runtime = runtimeFixture();
    const target = olderExitingBuild().target;
    const recovery = { purpose: 'recovery-grant', identity: 'attempt-1' };
    const unserved = { ...recovery, purpose: 'unserved-attempt' };
    for (const id of ['boot-1', 'boot-2', 'boot-3']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, target, recovery)('not-serving');
    }
    expect(startupHandoffAbandoned(runtime, target, recovery)).toBe(true);
    expect(startupHandoffAbandoned(runtime, target, unserved)).toBe(false);
    for (const id of ['boot-4', 'boot-5']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, target, unserved)('not-serving');
      expect(startupHandoffAbandoned(runtime, target, unserved)).toBe(false);
    }
    atStartup(runtime, 'boot-6');
    await createStartupHandoffObserver(runtime, 'boot-6', target, unserved)('not-serving');
    expect(startupHandoffAbandoned(runtime, target, unserved)).toBe(true);
  });

  it('should count distinct handoff failures only at least thirty seconds apart', async () => {
    const runtime = runtimeFixture();
    const target = olderExitingBuild().target;
    const subject = { purpose: 'recovery-grant', identity: 'attempt-1' };
    const origin = runtime.time.now();
    const now = vi.spyOn(runtime.time, 'now');
    for (const elapsed of [0, 1, 29_999, 30_000, 30_001, 59_999]) {
      now.mockReturnValue(origin + elapsed);
      await createStartupHandoffObserver(runtime, `boot-${elapsed}`, target, subject)('not-serving');
      expect(startupHandoffAbandoned(runtime, target, subject)).toBe(false);
    }
    now.mockReturnValue(origin + 60_000);
    await createStartupHandoffObserver(runtime, 'boot-60000', target, subject)('not-serving');
    expect(startupHandoffAbandoned(runtime, target, subject)).toBe(true);
  });

  it('should reset patience on serving and isolate each target and subject', async () => {
    const runtime = runtimeFixture();
    const first = olderExitingBuild().target;
    const second = olderExitingBuild().target;
    const subject = { purpose: 'recovery-grant', identity: 'attempt-1' };
    for (const id of ['boot-1', 'boot-2']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, first, subject)('not-serving');
    }
    await createStartupHandoffObserver(runtime, 'boot-2', first, subject)('serving');
    for (const id of ['boot-3', 'boot-4']) {
      atStartup(runtime, id);
      await createStartupHandoffObserver(runtime, id, first, subject)('not-serving');
      expect(startupHandoffAbandoned(runtime, first, subject)).toBe(false);
    }
    atStartup(runtime, 'boot-5');
    await createStartupHandoffObserver(runtime, 'boot-5', first, subject)('not-serving');
    expect(startupHandoffAbandoned(runtime, first, subject)).toBe(true);
    const patienceDir = join(runtime.paths.coral.coordinator.runDir, 'succession-startup-patience.v1');
    const auditFiles = readdirSync(patienceDir);
    expect(auditFiles).toHaveLength(1);
    const audit: unknown = JSON.parse(readFileSync(join(patienceDir, auditFiles[0]), 'utf8'));
    expect(audit).toMatchObject({
      observation: 'handoff-target-did-not-serve',
      disposition: 'abandoned',
      startups: 3,
    });
    expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir).kind).toBe('absent');
    expect(startupHandoffAbandoned(runtime, second, subject)).toBe(false);
    expect(startupHandoffAbandoned(runtime, first, { ...subject, identity: 'attempt-2' })).toBe(false);
  });
});

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

  it('should keep holding an attempt whose deaths remain unknown beyond boot four', async () => {
    const runtime = runtimeFixture();
    await seedRecoveryGrant(runtime, { pid: process.pid, incarnation: null });
    for (let boot = 1; boot <= 6; boot += 1) {
      expect(await holdOf(resolveAt(runtime, `startup-${boot}`))).toMatchObject({
        kind: 'deaths-unproven',
        alive: false,
      });
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        intent: { attemptId: 'recovery-attempt' },
      });
    }
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
    'holds an unattributable committed successor until its writer evidence becomes readable, unreadable identity=%s',
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
      if (unreadableIdentity)
        vi.spyOn(epochObservation, 'observeResolvedStoreEpochKey').mockReturnValue({ kind: 'unreadable' });
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
            ? 'awaiting readable current epoch identity; startup re-observes it'
            : 'awaiting attributable committed successor generation; startup re-observes the writer record',
        },
      });
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        intent: { disposition: 'completed' },
      });
      for (const startupId of ['startup-2', 'startup-3', 'startup-4', 'startup-5', 'startup-6']) {
        await expect(recoverAt(startupId)).resolves.toMatchObject({ kind: 'hold' });
      }
      expect(readUpgradeIntent(runtime.paths.coral.coordinator.runDir)).toMatchObject({
        intent: { disposition: 'completed', completionReceipt: { attemptId: 'attempt-1' } },
      });
    },
  );

  it.each([
    ['an operator discard', true],
    ['an operator discard', false],
    ['a store wipe that restarts numbering', true],
  ] as const)(
    'should not hold a committed successor whose epoch %s superseded before the new epoch served, receipt lineage=%s',
    async (supersession, withLineage) => {
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
          epochKey: withLineage ? encodeResolvedStoreEpoch(runtime, settled.store) : JSON.stringify(settled.store),
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date().toISOString(),
        },
      });
      if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
      if (supersession === 'an operator discard') {
        discardCurrentStoreEpoch(runtime, { storeFormat: format, build: current }).db.close();
      } else {
        rmSync(runtime.paths.coral.store.dbDir, { recursive: true, force: true });
        settleStoreEpoch(runtime, {
          storeFormat: format,
          build: current,
          authorizeMint: authorizeFixtureStoreMint,
        }).db.close();
      }

      atStartup(runtime, 'startup-1');
      await expect(
        prepareCommittedSuccessorRecovery(
          runtime,
          { pluginRoot: '/plugin', instanceId: 'startup-1' },
          format,
          current,
          () => false,
        ),
      ).resolves.toEqual({ kind: 'none' });
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
      deadline: null,
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

describe('supervised legacy upgrade completion', () => {
  it.each(['expired-deadline', 'quiescent-cutover'])('completes ordinary startup after %s', async (mode) => {
    const base = runtimeFixture();
    const format = currentCoralStoreFormat();
    const current = { ...build, version: format.productVersion, storeFormatFingerprint: format.fingerprint };
    const settled = settleStoreEpoch(base, {
      storeFormat: format,
      build: current,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    joinSuccessionWriterGeneration(base, settled.store);
    const runDir = base.paths.coral.coordinator.runDir;
    const dead = await exitedIncarnation();
    const written = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'request-1',
      legacyRetirement: true,
      incumbent: {
        instanceId: 'incumbent',
        ...dead,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      target: { build: current, pluginRootLabel: '/installed/coral/0.11.0' },
      attemptId: 'abandoned-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', ...dead },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(base.time.now() - 60_000).toISOString(),
      completionReceipt: null,
    });
    if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
    if (mode === 'quiescent-cutover') {
      let intent = written.intent;
      for (let i = 0; i < 2; i++) {
        const next = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          disposition: 'deferred',
          attemptId: null,
          attemptOwner: null,
          attemptDeadline: null,
          ...failedAttemptRetry(
            intent,
            { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
            'changed',
            base.time.now(),
          ),
        });
        if (next.kind !== 'written') throw new Error(next.kind);
        intent = next.intent;
      }
      expect(intent.blockers[0]?.owner).toBe('quiescent-cutover');
    }
    const launchId = base.ids.uuid();
    const self = { pid: process.pid, incarnation: testIncarnation(process.pid) };
    const admissionPath = launchAdmissionPath(runDir, launchId);
    mkdirSync(dirname(admissionPath), { recursive: true });
    writeFileSync(
      admissionPath,
      JSON.stringify({
        version: 1,
        launchId,
        child: self,
        parent: dead,
        admittedAt: base.time.now(),
        build: {
          version: current.version,
          buildSetId: current.buildSetId,
          bundleHash: current.bundleHash,
          flavor: current.flavor,
        },
        purpose: 'legacy-retirement',
      }),
    );
    const launchEnv: Record<string, string> = { CORAL_LAUNCH_PURPOSE: 'legacy-retirement', CORAL_LAUNCH_ID: launchId };
    const runtime: Runtime = { ...base, env: { ...base.env, get: (key) => launchEnv[key] ?? base.env.get(key) } };

    await expect(
      completeSupervisorLegacyUpgrade(runtime, current, settled.store, 'successor', self.pid, self.incarnation),
    ).resolves.toEqual({ kind: 'completed' });
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: {
        disposition: 'completed',
        attemptId: launchId,
        attemptDeadline: null,
        completionReceipt: { attemptId: launchId },
      },
    });
    if (mode === 'quiescent-cutover') {
      await closeServedIntentAtCleanExit(runtime, 'successor', {
        instanceId: 'successor',
        ...self,
        version: current.version,
        bundleHash: current.bundleHash,
        flavor: current.flavor,
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { disposition: 'closed', legacyRetirement: true } });
      expect(pendingIntent(runDir)).toBeNull();
      const closed = readUpgradeIntent(runDir);
      if (closed.kind !== 'readable') throw new Error(closed.kind);
      expect(visibleUpgradeIntent(closed.intent)).toBeNull();
      const release = vi.fn(() => true);
      vi.mocked(watchChild).mockResolvedValue({ served: true, exitCode: 0, signal: null, wedged: false });
      const supervision = {
        record: { release, childRetirement: vi.fn() },
        owner: {},
        initial: { child: {}, identity: self, manifest: current },
        reservation: {},
        runDir,
        timing: {},
        startupBudgetMs: 30_000,
      } as unknown as Parameters<typeof superviseActiveChild>[0];
      await expect(superviseActiveChild(supervision)).resolves.toEqual({ released: true, served: true });
      expect(release).toHaveBeenCalledOnce();
      expect(watchChild).toHaveBeenCalledOnce();
    }
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
