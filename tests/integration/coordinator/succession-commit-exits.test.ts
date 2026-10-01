import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { attachProviderOperation } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import { controlExchangeForTest, ControlClientError } from '#src/provider-proxy/control-client.js';
import { insertProviderOperation, providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';

import type { SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import {
  createSuccessionCommitter,
  type IncumbentWriterPorts,
  type SuccessionCommitPorts,
  type SuccessionCommitter,
} from '#src/coordinator/succession/commit/index.js';
import { successionTargetKey } from '#src/coordinator/succession/protocol.js';
import { recordRetirementDisposition } from '#src/coordinator/succession/retirement-disposition.js';
import { dischargeDeadSuccessionAttempt } from '#src/coordinator/succession/startup.js';
import type { SuccessionInterpositionPoint } from '#src/coordinator/succession/interposition.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import {
  createSuccessionReconciler,
  type SuccessionDecision,
  type SuccessionLaunch,
  type SuccessionReconciler,
} from '#src/coordinator/succession/reconciler/index.js';
import { createDisabledKbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import type { SuccessionRelease } from '#src/coordinator/shutdown.js';
import { isProcessIncarnation, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import { encodeResolvedStoreEpoch, epochDirectory, settleStoreEpoch } from '#src/store/epoch.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import type { RetiringCustodyCertificate } from '#src/coordinator/services/recovery/epoch-closure.js';
import {
  advanceSuccessionWriterGeneration,
  observeSuccessionServing,
  observeSuccessionWriterGeneration,
  recordSuccessionServing,
} from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';
import { terminateChildProcess } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
/** What the incumbent did to its attempt and its own admission, in order. */
const commitEvents: string[] = [];
const format = currentCoralStoreFormat();
const build = {
  version: format.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod' as const,
  storeFormatFingerprint: format.fingerprint,
};

afterEach(async () => {
  commitEvents.splice(0);
  await Promise.all(children.splice(0).map((child) => terminateChildProcess(child, 'SIGKILL')));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type AttemptBehavior = Readonly<{
  /** Record an identity the reaper cannot verify, so the failed child's absence stays unproven. */
  unprovenIdentity?: boolean;
  /** The successor neither serves nor holds, so the attempt ends only at its commit deadline. */
  silent?: boolean;
  exitsBeforeServing?: boolean;
  exitsBeforeReadiness?: boolean;
  servesOnCommittedOpen?: Readonly<{ runtime: Runtime; epochKey: string }>;
  /**
   * The successor takes the writer generation at committed open and its serving record lands only after the
   * incumbent's last serving check, just before the failed window is closed.
   */
  servesAfterIncumbentCheck?: Readonly<{ runtime: Runtime; epochKey: string }>;
  /**
   * The successor has not yet taken the writer generation when its incumbent fails the window for another reason,
   * and takes it and records serving before it processes the incumbent's abort.
   */
  servesBeforeAbort?: Readonly<{ runtime: Runtime; epochKey: string; refusals: unknown[] }>;
  /** Runs as the incumbent aborts the attempt, before it reaps the child. */
  onAbort?: () => void;
}>;

function spawnIdleChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function fakeAttempt(attemptId: string, epochKey: string, behavior: AttemptBehavior): Promise<SuccessionAttempt> {
  const child = spawnIdleChild();
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('attempt child has no pid');
  await waitForCondition(() => probeProcessIncarnation(pid) !== null, 5_000);
  const incarnation = probeProcessIncarnation(pid);
  if (incarnation === null) throw new Error('attempt child incarnation is unavailable');
  const forged = `${incarnation}-unproven`;
  if (!isProcessIncarnation(forged)) throw new Error('forged incarnation is not well-formed');
  const recorded: ProcessIncarnation = behavior.unprovenIdentity === true ? forged : incarnation;
  const acknowledgments = new Set<Parameters<SuccessionAttempt['onAcknowledgment']>[0]>();
  return {
    attemptId,
    child,
    childIdentity: { pid, incarnation: recorded },
    transferListeners: async () => undefined,
    forwardConnections: () => () => {
      commitEvents.push('stop-forwarding');
      const late = behavior.servesAfterIncumbentCheck;
      const generation = late === undefined ? null : observeSuccessionWriterGeneration(late.runtime);
      if (late === undefined || generation === null) return;
      recordSuccessionServing(late.runtime, generation, {
        attemptId,
        epochKey: late.epochKey,
        successorInstanceId: 'successor',
        controlGeneration: generation.generation,
        recordedAt: new Date(late.runtime.time.now()).toISOString(),
      });
    },
    drainIncumbentConnections: async () => undefined,
    setDeadline: async () => undefined,
    // Unless silent, the successor's committed open fails: it reports a hold instead of serving.
    allowCommittedOpen: async () => {
      if (behavior.exitsBeforeServing === true) {
        child.kill('SIGTERM');
        return;
      }
      if (behavior.servesOnCommittedOpen !== undefined) {
        const { runtime, epochKey } = behavior.servesOnCommittedOpen;
        const parked = observeSuccessionWriterGeneration(runtime);
        if (parked === null) throw new Error('the incumbent parked no writer generation');
        const generation = advanceSuccessionWriterGeneration(runtime, parked, parked, attemptId);
        recordSuccessionServing(runtime, generation, {
          attemptId,
          epochKey,
          successorInstanceId: 'successor',
          controlGeneration: generation.generation,
          recordedAt: new Date(runtime.time.now()).toISOString(),
        });
        return;
      }
      const late = behavior.servesAfterIncumbentCheck;
      if (late !== undefined) {
        const parked = observeSuccessionWriterGeneration(late.runtime);
        if (parked === null) throw new Error('the incumbent parked no writer generation');
        advanceSuccessionWriterGeneration(late.runtime, parked, parked);
        return;
      }
      if (behavior.silent === true) return;
      for (const callback of acknowledgments) callback({ kind: 'hold', reason: 'injected committed-open failure' });
    },
    abort: async () => {
      commitEvents.push('abort');
      behavior.onAbort?.();
      const racing = behavior.servesBeforeAbort;
      if (racing === undefined) return;
      try {
        const parked = observeSuccessionWriterGeneration(racing.runtime);
        if (parked === null) throw new Error('the incumbent parked no writer generation');
        const generation = advanceSuccessionWriterGeneration(racing.runtime, parked, parked, attemptId);
        recordSuccessionServing(racing.runtime, generation, {
          attemptId,
          epochKey: racing.epochKey,
          successorInstanceId: 'successor',
          controlGeneration: generation.generation,
          recordedAt: new Date(racing.runtime.time.now()).toISOString(),
        });
      } catch (error: unknown) {
        racing.refusals.push(error);
      }
    },
    onAcknowledgment: (callback) => {
      acknowledgments.add(callback);
      if (behavior.exitsBeforeReadiness === true) {
        child.kill('SIGTERM');
        return () => acknowledgments.delete(callback);
      }
      callback({ kind: 'ready', epochKey, receiptIds: [] });
      return () => acknowledgments.delete(callback);
    },
  };
}

function incumbentIdentity(): UpgradeIntent['incumbent'] {
  return {
    instanceId: 'incumbent',
    pid: process.pid,
    incarnation: probeProcessIncarnation(process.pid),
    version: build.version,
    bundleHash: build.bundleHash,
    flavor: build.flavor,
  };
}

function reconcilerStub(readiness?: SuccessionDecision, recertification?: SuccessionDecision): SuccessionReconciler {
  const deferred: SuccessionDecision = { kind: 'deferred', reason: 'test reconciler' };
  return {
    incumbent: incumbentIdentity,
    request: async () => deferred,
    repairSupervision: async () => deferred,
    prepare: async () => deferred,
    reportReady: async (report) =>
      readiness ?? { kind: 'ready', preparation: preparationFor(report.epochKey, report.attemptId) },
    commit: async () => deferred,
    recertify: async (attemptId) =>
      recertification ?? { kind: 'prepared', preparation: preparationFor('epoch-key', attemptId) },
    abort: async () => deferred,
    status: () => ({ kind: 'absent' }),
    reconcile: async () => deferred,
    notifyObligationChange: () => undefined,
    dispose: () => undefined,
  };
}

function preparationFor(epochKey: string, attemptId: string): SuccessionPreparation {
  return {
    version: 'v1',
    requestId: 'request-1',
    attemptId,
    incumbentInstanceId: 'incumbent',
    incumbentPid: process.pid,
    incumbentKey: 'incumbent-key',
    targetKey: 'target-key',
    capabilitiesKey: 'capabilities-key',
    epochKey,
    admissionRevision: 0,
    accepts: [],
    receipts: [],
    stage: 'prepared',
    ready: null,
  };
}

type Harness = Readonly<{
  runtime: Runtime;
  db: Database;
  epochKey: string;
  attemptId: string;
  releases: readonly SuccessionRelease[];
  servingRefusals: readonly unknown[];
  adoptedAdmissions: number;
  launchFence: readonly boolean[];
  startedRecoveries: number;
  retryNotifications: number;
  committer: SuccessionCommitter;
  releaseKbWriter(): void;
  launch(): Promise<SuccessionLaunch>;
  launchNextServing(): Promise<SuccessionLaunch>;
}>;

async function harness(
  options: Readonly<{
    failingPoints: (point: SuccessionInterpositionPoint, recovery: boolean) => boolean;
    recoveryLaunch: 'fails' | 'starts';
    attempt?:
      | Omit<AttemptBehavior, 'servesAfterIncumbentCheck' | 'servesBeforeAbort'>
      | 'serves-after-incumbent-check'
      | 'serves-before-abort';
    pauseMs?: number;
    /** Provider hosts the preparation hands over, in place of a commit that transfers none. */
    providerHosts?: SuccessionCommitPorts['providerHosts'];
    /** What the reconciler answers when the successor reports readiness. */
    readiness?: SuccessionDecision;
    /** What the reconciler answers when the window re-certifies obligations before writers park. */
    recertification?: SuccessionDecision;
    /** The KB daemon refuses to park its writer turn with this error. */
    kbParkRefusal?: string;
    kbParkRefusalDelayMs?: number;
    kbReclaimDelayMs?: number;
    /** A target store format other than the incumbent's makes the commit a format-changing retirement. */
    targetFingerprint?: string;
    certifyCustody?: SuccessionCommitPorts['retiringEpoch']['certifyCustody'];
    /** Transient failures this target has already spent. */
    priorTransientFailures?: number;
    priorObligationChanges?: number;
    releaseAuthorityThrowsOnce?: boolean;
    refusalWriteFailures?: number;
    serveAfterRefusalWriteFailure?: boolean;
    operationProbe?: ReturnType<typeof createProviderOperationReconcilerHarness>;
    onWriterPark?: () => void;
  }>,
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-exits-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
  const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
  const preparation = preparationFor(epochKey, runtime.ids.uuid());
  const servingRefusals: unknown[] = [];
  let attempt = await fakeAttempt(
    preparation.attemptId,
    epochKey,
    options.attempt === 'serves-after-incumbent-check'
      ? { servesAfterIncumbentCheck: { runtime, epochKey } }
      : options.attempt === 'serves-before-abort'
        ? { servesBeforeAbort: { runtime, epochKey, refusals: servingRefusals } }
        : (options.attempt ?? {}),
  );
  const refusalWriteFailures = options.refusalWriteFailures;
  if (refusalWriteFailures !== undefined) {
    const durableWrite = runtime.storage.writeAtomicDurableSync;
    let failures = 0;
    runtime.storage.writeAtomicDurableSync = (path, data, writeOptions) => {
      if (
        failures < refusalWriteFailures &&
        commitEvents.includes('stop-forwarding') &&
        path.endsWith('succession-writer-generation.v1.json')
      ) {
        failures += 1;
        commitEvents.push('refusal-write-failed');
        if (options.serveAfterRefusalWriteFailure === true) {
          queueMicrotask(() => {
            try {
              const parked = observeSuccessionWriterGeneration(runtime);
              if (parked === null) throw new Error('the incumbent parked no writer generation');
              const generation = advanceSuccessionWriterGeneration(runtime, parked, parked, preparation.attemptId);
              recordSuccessionServing(runtime, generation, {
                attemptId: preparation.attemptId,
                epochKey,
                successorInstanceId: 'successor',
                controlGeneration: generation.generation,
                recordedAt: new Date(runtime.time.now()).toISOString(),
              });
            } catch (error: unknown) {
              servingRefusals.push(error);
            }
          });
        }
        return false;
      }
      if (failures > 0 && path.endsWith('succession-writer-generation.v1.json'))
        commitEvents.push('refusal-write-durable');
      return durableWrite(path, data, writeOptions);
    };
  }
  const state = {
    releases: [] as SuccessionRelease[],
    adoptedAdmissions: 0,
    launchFence: [] as boolean[],
    startedRecoveries: 0,
    retryNotifications: 0,
  };
  let kbWriterBusy = options.kbParkRefusal !== undefined;
  const writers: IncumbentWriterPorts = {
    parkProviderOperationMutations: async () => {
      commitEvents.push('park');
      if (options.operationProbe !== undefined) {
        expect(providerOperationMutationAdmission(options.operationProbe.db).close().kind).toBe('drained');
        options.onWriterPark?.();
      }
    },
    adoptProviderOperationAdmission: () => {
      state.adoptedAdmissions += 1;
    },
    protectRetiringStore: () => ({ kind: 'protected' }),
    reopenRetiringStore: () => undefined,
    releaseAuthority: (release) => {
      state.releases.push(release);
      if (options.releaseAuthorityThrowsOnce === true && state.releases.length === 1) {
        return Promise.reject(new Error('injected authority release failure'));
      }
      return new Promise<never>(() => undefined);
    },
  };
  const listener: IpcListener = { server: createServer(), sockets: new Set<Socket>(), socketPath: null };
  const ports: SuccessionCommitPorts = {
    runtime,
    log: () => undefined,
    listener: () => listener,
    incumbent: {
      instanceId: 'incumbent',
      pluginRoot: root,
      storeFormatFingerprint: format.fingerprint,
      build: { manifest: build, bundleDir: join(root, 'bridge') },
    },
    reconciler: () => ({
      ...reconcilerStub(options.readiness, options.recertification),
      recertify: async (attemptId) => {
        commitEvents.push('recertify');
        return options.recertification ?? { kind: 'prepared', preparation: preparationFor(epochKey, attemptId) };
      },
      notifyObligationChange: () => {
        state.retryNotifications += 1;
      },
    }),
    writers: () => writers,
    kbDaemon: {
      ...createDisabledKbDaemonSupervisor('test'),
      ...(options.kbReclaimDelayMs === undefined
        ? {}
        : {
            reclaimWriterTurn: async () => {
              await runtime.time.sleep(options.kbReclaimDelayMs ?? 0);
            },
          }),
      ...(options.kbParkRefusal === undefined
        ? {}
        : {
            parkWriterTurn: async () => {
              if (options.kbParkRefusalDelayMs !== undefined) await runtime.time.sleep(options.kbParkRefusalDelayMs);
              if (kbWriterBusy) throw new Error(options.kbParkRefusal);
            },
          }),
    },
    launchCoordinator: {
      admissionRevision: () => 0,
      beginSuccessionWriterPark: () => {
        commitEvents.push('begin-writer-park');
      },
      beginSuccessionCommitWindow: (attemptId) => ({
        kind: 'paused',
        attemptId,
        deadlineAtMs: runtime.time.now() + (options.pauseMs ?? 10_000),
      }),
      endSuccessionCommitWindow: () => true,
    },
    providerHosts: options.providerHosts ?? {
      transfersHosts: () => false,
      releaseForTransfer: async () => undefined,
      reclaimTransferred: () => undefined,
    },
    setLaunchFenceActive: (active) => {
      commitEvents.push(`fence:${active}`);
      state.launchFence.push(active);
    },
    waitHandover: { abort: () => undefined, renew: () => undefined },
    liveJobIds: () => [],
    retiringEpoch: {
      certificate: () => null,
      resultsReleased: () => false,
      recoverLocations: () => {
        throw new Error('a same-format commit never recovers historical job locations');
      },
      certifyCustody: options.certifyCustody ?? (async () => null),
      confirmCustody: async () => false,
    },
    storeDb: () => options.operationProbe?.db ?? settled.db,
    startAttempt: async (input) => {
      if (input.recoveryBundleDir === undefined) return attempt;
      state.startedRecoveries += 1;
      if (options.recoveryLaunch === 'fails') throw new Error('recovery child could not start');
      return fakeAttempt(input.preparation.attemptId, epochKey, {});
    },
    interposition: {
      at: (point, context) => {
        if (options.failingPoints(point, context.recovery)) throw new Error(`injected ${point} failure`);
      },
    },
  };
  const committer = createSuccessionCommitter(ports);
  const targetFingerprint = options.targetFingerprint ?? format.fingerprint;
  const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
    requestId: 'request-1',
    incumbent: incumbentIdentity(),
    target: { build: { ...build, storeFormatFingerprint: targetFingerprint }, pluginRootLabel: root },
    attemptId: preparation.attemptId,
    attemptOwner: {
      kind: 'incumbent',
      instanceId: 'incumbent',
      pid: process.pid,
      incarnation: probeProcessIncarnation(process.pid),
    },
    attemptChild: { attemptId: attempt.attemptId, ...attempt.childIdentity },
    disposition: 'pending',
    blockers: [],
    retryCondition: null,
    attemptDeadline: null,
    completionReceipt: null,
    successionPreparation: preparation,
    ...(options.priorTransientFailures === undefined
      ? {}
      : {
          transientRetry: {
            targetKey: successionTargetKey({
              build: { ...build, storeFormatFingerprint: targetFingerprint },
              pluginRootLabel: root,
            }),
            failures: options.priorTransientFailures,
            retryAfter: new Date(runtime.time.now()).toISOString(),
          },
        }),
    ...(options.priorObligationChanges === undefined
      ? {}
      : {
          obligationRetry: {
            targetKey: successionTargetKey({
              build: { ...build, storeFormatFingerprint: targetFingerprint },
              pluginRootLabel: root,
            }),
            changes: options.priorObligationChanges,
            retryAfter: new Date(runtime.time.now()).toISOString(),
          },
        }),
  });
  if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
  return {
    runtime,
    db: settled.db,
    epochKey,
    attemptId: preparation.attemptId,
    servingRefusals,
    get releases() {
      return state.releases;
    },
    get adoptedAdmissions() {
      return state.adoptedAdmissions;
    },
    get launchFence() {
      return state.launchFence;
    },
    get startedRecoveries() {
      return state.startedRecoveries;
    },
    get retryNotifications() {
      return state.retryNotifications;
    },
    committer,
    releaseKbWriter: () => {
      kbWriterBusy = false;
    },
    launch: () => committer.launchPrepared(written.intent, preparation),
    launchNextServing: async () => {
      const nextPreparation = preparationFor(epochKey, runtime.ids.uuid());
      attempt = await fakeAttempt(nextPreparation.attemptId, epochKey, {
        servesOnCommittedOpen: { runtime, epochKey },
      });
      const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
      if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
      const next = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, observed.intent.revision, {
        ...observed.intent,
        disposition: 'pending',
        attemptId: nextPreparation.attemptId,
        attemptOwner: observed.intent.attemptOwner ?? {
          kind: 'incumbent',
          instanceId: 'incumbent',
          pid: process.pid,
          incarnation: probeProcessIncarnation(process.pid),
        },
        attemptChild: null,
        successionPreparation: nextPreparation,
        blockers: [],
        retryCondition: null,
      });
      if (next.kind !== 'written') throw new Error(`next intent is ${next.kind}`);
      return createSuccessionCommitter(ports).launchPrepared(next.intent, nextPreparation);
    },
  };
}

function retryCondition(runtime: Runtime): UpgradeIntent['retryCondition'] {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  return observed.kind === 'readable' ? observed.intent.retryCondition : null;
}

function blockers(runtime: Runtime): readonly { owner: string; reason: string }[] {
  const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
  return observed.kind === 'readable' ? observed.intent.blockers : [];
}

describe('succession commit failure exits', () => {
  it('should not settle a serving attempt when its first authority release throws', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: 'serves-after-incumbent-check',
      releaseAuthorityThrowsOnce: true,
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 2, 15_000);
    expect(test.releases.map((release) => release.kind)).toEqual(['successor', 'successor']);
  });

  it('should reclaim the incumbent writer even when the failed successor cannot be proven absent', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { unprovenIdentity: true },
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(test.releases).toEqual([]);
    expect(blockers(test.runtime).map(({ owner }) => owner)).toEqual(['succession-commit', 'succession-attempt-child']);
    expect(blockers(test.runtime)[0]?.reason).toContain('incumbent reclaimed');
    expect(retryCondition(test.runtime)?.kind).toBe('target-change');
    expect(test.retryNotifications).toBe(0);
    test.db.exec('CREATE TABLE served_after_reclaim (value TEXT)');
  });

  it('should keep the attempt attempting until the write that clears it, while its release still runs', async () => {
    const observedAtReclaim: (UpgradeIntent | null)[] = [];
    let runDir = '';
    const test = await harness({
      failingPoints: (point) => {
        if (point === 'incumbent-reclaim') {
          const observed = readUpgradeIntent(runDir);
          observedAtReclaim.push(observed.kind === 'readable' ? observed.intent : null);
        }
        return false;
      },
      recoveryLaunch: 'fails',
    });
    runDir = test.runtime.paths.coral.coordinator.runDir;
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(observedAtReclaim).toHaveLength(1);
    expect(observedAtReclaim[0]).toMatchObject({
      disposition: 'attempting',
      attemptId: expect.any(String) as unknown,
      blockers: [{ owner: 'succession-commit' }],
    });
    expect(readUpgradeIntent(runDir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'deferred', attemptId: null },
    });
  });

  it('should retry the same target after its successor misses the commit deadline', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { silent: true },
      pauseMs: 3_000,
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    expect(test.adoptedAdmissions).toBe(1);
    expect(test.releases).toEqual([]);
    expect(blockers(test.runtime)[0]?.reason).toContain('Successor missed its serving deadline');
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
  });

  it('retries a target after its first child exits before serving, and the next attempt serves', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { exitsBeforeServing: true },
    });
    const first = await test.launch();
    await first.settled;

    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { transientRetry: { failures: 1 } },
    });
    await test.launchNextServing();
    await waitForCondition(() => test.releases.some((release) => release.kind === 'successor'), 15_000);
    expect(observeSuccessionServing(test.runtime, test.attemptId)).toBeNull();
  });

  it('counts a child exit before readiness as a transient attempt failure', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { exitsBeforeReadiness: true },
    });
    const first = await test.launch();
    await first.settled;

    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { transientRetry: { failures: 1 } },
    });
    expect(test.adoptedAdmissions).toBe(0);
  });

  it('should release to a successor whose serving record lands after the missed deadline, without reaping it', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: 'serves-after-incumbent-check',
      pauseMs: 3_000,
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 1, 15_000);
    expect(test.releases[0]).toMatchObject({ kind: 'successor' });
    const successor = children.at(-1);
    expect([successor?.exitCode, successor?.signalCode]).toEqual([null, null]);
    expect(test.adoptedAdmissions).toBe(0);
  });

  it('should refuse a successor that serves after its incumbent failed the window for another reason', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: 'serves-before-abort',
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(test.releases).toEqual([]);
    expect(test.servingRefusals).toHaveLength(1);
    expect(observeSuccessionServing(test.runtime, test.attemptId)).toBeNull();
    expect(blockers(test.runtime)[0]?.reason).toContain('injected committed-open failure');
  });

  it('retries a failed refusal write before aborting the successor', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: 'serves-before-abort',
      refusalWriteFailures: 1,
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(commitEvents).toContain('refusal-write-failed');
    expect(commitEvents.indexOf('refusal-write-durable')).toBeGreaterThan(commitEvents.indexOf('refusal-write-failed'));
    expect(commitEvents.indexOf('abort')).toBeGreaterThan(commitEvents.indexOf('refusal-write-durable'));
    expect(test.servingRefusals).toHaveLength(1);
    expect(observeSuccessionServing(test.runtime, test.attemptId)).toBeNull();
  });

  it('leaves an unrefused live successor unresolved after the refusal deadline', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      pauseMs: 3_000,
      refusalWriteFailures: Infinity,
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 1, 15_000);
    expect(test.releases[0]).toMatchObject({ kind: 'restart' });
    expect(commitEvents).toContain('refusal-write-failed');
    expect(commitEvents).not.toContain('abort');
    expect(test.adoptedAdmissions).toBe(0);
    expect(test.launchFence.at(-1)).toBe(true);
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { attemptId: test.attemptId, retryCondition: { kind: 'attempt-expiry' } },
    });
  });

  it('releases a successor that serves after a failed refusal write', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      refusalWriteFailures: 1,
      serveAfterRefusalWriteFailure: true,
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 1, 15_000);
    expect(test.releases[0]).toMatchObject({ kind: 'successor' });
    expect(commitEvents).not.toContain('abort');
    expect(test.servingRefusals).toEqual([]);
    expect(observeSuccessionServing(test.runtime, test.attemptId)).not.toBeNull();
  });

  it('should recognize a retirement its disposition recorded after the historical certificate moves on', async () => {
    const test = await harness({ failingPoints: () => false, recoveryLaunch: 'fails' });
    recordRetirementDisposition(test.runtime, {
      version: 'v1',
      attemptId: test.attemptId,
      incumbentEpochKey: test.epochKey,
      incumbentFingerprint: format.fingerprint,
      successorFingerprint: format.fingerprint,
      certificateRevision: 3,
      certificateJobIds: ['job-1'],
      custodySettled: true,
    });

    expect(test.committer.retirementServes(test.attemptId, test.epochKey)).toBe(true);
    expect(test.committer.retirementServes(test.runtime.ids.uuid(), test.epochKey)).toBe(false);
    expect(test.committer.retirementServes(test.attemptId, 'other-epoch')).toBe(false);
  });

  it('should fence launches while a reclaim outlives the admission pause', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { silent: true },
      pauseMs: 3_000,
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(test.launchFence).toEqual([true, false]);
  });

  it('does not reclaim beyond the admission pause deadline', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      pauseMs: 100,
      kbReclaimDelayMs: 500,
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 1, 5_000);
    expect(test.adoptedAdmissions).toBe(0);
    expect(test.launchFence).not.toContain(false);
  });

  it('should retry, not block, the target when the KB writer turn refuses to park', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      kbParkRefusal: 'KB daemon writer turn cannot park while 1 KB job(s) run.',
      priorTransientFailures: 6,
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    expect(test.adoptedAdmissions).toBe(1);
    expect(retryCondition(test.runtime)?.kind).toBe('obligation-change');
    const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    expect(observed.intent.transientRetry?.failures).toBe(6);
    expect(blockers(test.runtime)[0]?.reason).toContain('cannot park while 1 KB job(s) run');
  });

  it('should preserve obligation churn when a KB park refusal arrives after the commit deadline', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      pauseMs: 3_000,
      kbParkRefusal: 'KB writer turn remains busy',
      kbParkRefusalDelayMs: 600,
      priorTransientFailures: 6,
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    expect(observed.intent.retryCondition?.kind).toBe('obligation-change');
    expect(observed.intent.transientRetry?.failures).toBe(6);
  });

  it('retries an exhausted obligation retry target after the writer releases', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      kbParkRefusal: 'KB writer turn remains busy',
      priorObligationChanges: 6,
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    expect(observed.intent.retryCondition?.kind).toBe('obligation-change');
    expect(observed.intent.obligationRetry?.changes).toBe(7);
    expect(observed.intent.disposition).toBe('deferred');
    expect(test.adoptedAdmissions).toBe(1);
    test.releaseKbWriter();
    await test.launchNextServing();
    await waitForCondition(() => test.releases.some((release) => release.kind === 'successor'), 15_000);
    const retried = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (retried.kind !== 'readable' || retried.intent.attemptId === null) throw new Error('retry was not recorded');
    expect(observeSuccessionServing(test.runtime, retried.intent.attemptId)).not.toBeNull();
  });

  it('re-certifies an obligation after the ancillary writers park and retries the target', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      recertification: {
        kind: 'deferred',
        reason: 'succession obligations began after preparation',
        blockers: [{ owner: 'discuss', reason: 'live discuss session retains coordinator-local state' }],
      },
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    expect(test.adoptedAdmissions).toBe(1);
    expect(test.releases).toEqual([]);
    expect(retryCondition(test.runtime)?.kind).toBe('obligation-change');
    expect(blockers(test.runtime)[0]?.reason).toContain(
      'discuss: live discuss session retains coordinator-local state',
    );
    expect(commitEvents).toContain('park');
    expect(commitEvents.indexOf('begin-writer-park')).toBeLessThan(commitEvents.indexOf('recertify'));
    expect(commitEvents.indexOf('park')).toBeLessThan(commitEvents.indexOf('recertify'));
  });

  it('restarts when a failed same-build recovery launch leaves no admission pause to reclaim in', async () => {
    const test = await harness({
      failingPoints: (point, recovery) => point === 'incumbent-reclaim' && !recovery,
      recoveryLaunch: 'fails',
    });
    await test.launch();

    await waitForCondition(() => test.releases.length === 1, 15_000);
    expect(test.startedRecoveries).toBe(2);
    expect(test.releases[0]).toMatchObject({ kind: 'restart' });
    expect(test.adoptedAdmissions).toBe(0);
    expect(test.launchFence.at(-1)).toBe(true);
    expect(test.launchFence).not.toContain(false);
  });

  it.each(['fails', 'starts'] as const)(
    'should exit for a same-build restart when every reclaim fails and the recovery child %s',
    async (recoveryLaunch) => {
      const test = await harness({
        failingPoints: (point) => point === 'incumbent-reclaim',
        recoveryLaunch,
      });
      await test.launch();

      await waitForCondition(() => test.releases.length === 1, 30_000);
      expect(test.releases[0]).toMatchObject({ kind: 'restart' });
      expect(test.adoptedAdmissions).toBe(0);
      expect(test.startedRecoveries).toBe(2);
      expect(test.launchFence.at(-1)).toBe(true);
      const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
      if (observed.kind !== 'readable') throw new Error('restart grant is unreadable');
      expect(observed.intent.attemptId).toBe(observed.intent.recoveryAttemptId);
      expect(observed.intent.attemptOwner).toMatchObject({ kind: 'incumbent', pid: process.pid });
      expect(observed.intent.successionPreparation).toMatchObject({ stage: 'prepared', epochKey: test.epochKey });
    },
  );

  it('should retry, not block, the target when a launch outdates the preparation during readiness', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      readiness: { kind: 'stale', reason: 'preparation is stale', cause: 'obligation-change' },
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    expect(retryCondition(test.runtime)?.kind).toBe('obligation-change');
    expect(blockers(test.runtime)[0]?.reason).toContain('outdated by an admission or epoch change');
  });

  it('closes an exhausted transient retry target automatically', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { silent: true },
      pauseMs: 3_000,
      priorTransientFailures: 6,
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(retryCondition(test.runtime)).toMatchObject({
      kind: 'target-change',
      evidence: expect.stringContaining('exhausted'),
    });
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { disposition: 'closed', transientRetry: { failures: 7 } },
    });
    expect(blockers(test.runtime)[0]?.owner).toBe('succession-commit');
    expect(test.retryNotifications).toBe(1);
  });

  it('should let shutdown end a custody certification that has not settled', async () => {
    const certifying: AbortSignal[] = [];
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      targetFingerprint: `sha256:${'f'.repeat(64)}`,
      certifyCustody: (_epochKey, signal) => {
        certifying.push(signal);
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)));
      },
    });
    await test.launch();
    await waitForCondition(() => certifying.length === 1, 15_000);

    await test.committer.shutdown.settleUncommittedAttempt();
    expect(certifying[0]?.aborted).toBe(true);
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
  });

  it('should keep the target retryable when incumbent shutdown aborts the commit window', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { silent: true },
    });
    await test.launch();
    await waitForCondition(() => {
      const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
      return observed.kind === 'readable' && observed.intent.disposition === 'attempting';
    }, 15_000);

    await test.committer.shutdown.settleUncommittedAttempt();
    expect(test.adoptedAdmissions).toBe(1);
    expect(blockers(test.runtime)[0]?.reason).toContain('Incumbent shutdown aborted the uncommitted attempt');
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
  });

  it('should restore a transient failure kind when a same-build restart grant is served', async () => {
    const test = await harness({
      failingPoints: (point) => point === 'incumbent-reclaim',
      recoveryLaunch: 'fails',
      attempt: { silent: true },
      pauseMs: 3_000,
    });
    await test.launch();
    await waitForCondition(() => test.releases.length === 1, 30_000);
    const granted = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (granted.kind !== 'readable' || granted.intent.attemptId === null)
      throw new Error('restart grant is unreadable');
    expect(granted.intent.recoveryRetry).toMatchObject({ kind: 'transient' });

    const attemptId = granted.intent.attemptId;
    const reconciler = createSuccessionReconciler({
      runtime: test.runtime,
      runDir: test.runtime.paths.coral.coordinator.runDir,
      incumbent: incumbentIdentity,
      owners: [],
      epochKey: () => test.epochKey,
      admissionRevision: () => 0,
      observeServing: (served) =>
        served === attemptId
          ? {
              epochKey: test.epochKey,
              controlGeneration: 2,
              successorInstanceId: incumbentIdentity().instanceId,
              recordedAt: new Date(test.runtime.time.now()).toISOString(),
            }
          : null,
    });
    try {
      expect(await reconciler.commit(attemptId)).toMatchObject({ kind: 'registered' });
    } finally {
      reconciler.dispose();
    }
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
  });

  it('should discharge a restart grant consumed at startup and keep its transient failure kind', async () => {
    const test = await harness({
      failingPoints: (point) => point === 'incumbent-reclaim',
      recoveryLaunch: 'fails',
      attempt: { silent: true },
      pauseMs: 3_000,
    });
    await test.launch();
    await waitForCondition(() => test.releases.length === 1, 30_000);
    const granted = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (granted.kind !== 'readable' || granted.intent.attemptId === null)
      throw new Error('restart grant is unreadable');
    const restarted = {
      instanceId: 'restarted',
      pid: process.pid,
      incarnation: probeProcessIncarnation(process.pid),
      version: build.version,
      bundleHash: build.bundleHash,
      flavor: build.flavor,
    };

    await dischargeDeadSuccessionAttempt(test.runtime, granted.intent.attemptId, restarted);
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      kind: 'readable',
      intent: {
        incumbent: restarted,
        attemptId: null,
        attemptOwner: null,
        recoveryAttemptId: null,
        successionPreparation: null,
        disposition: 'deferred',
        retryCondition: { kind: 'attempt-expiry' },
        transientRetry: { failures: 1 },
      },
    });
  });

  it('should record an unserved retirement mint whose discard a reader holds, so a later pass retries it', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      targetFingerprint: `sha256:${'f'.repeat(64)}`,
      certifyCustody: async () => ({}) as unknown as RetiringCustodyCertificate,
    });
    const dbDir = realpathSync(test.runtime.paths.coral.store.dbDir);
    const mint = epochDirectory(dbDir, '2');
    cpSync(epochDirectory(dbDir, '1'), mint, { recursive: true });
    writeFileSync(
      join(mint, '.retirement-attempt.v1.json'),
      `${JSON.stringify({ version: 'v1', attemptId: test.attemptId })}\n`,
    );
    const reader = createSharedFileLockSync(join(mint, '.lock'));
    try {
      await test.launch();
      await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    } finally {
      reader();
    }

    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: {
        attemptId: null,
        unservedMintDiscard: { attemptId: test.attemptId, incumbentEpochKey: test.epochKey },
      },
    });
  });

  it('should fence launches before it waits on the failed successor, since the pause may end during that wait', async () => {
    const test = await harness({ failingPoints: () => false, recoveryLaunch: 'fails' });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(commitEvents).toContain('fence:true');
    expect(commitEvents.indexOf('fence:true')).toBeLessThan(commitEvents.indexOf('abort'));
    expect(test.launchFence.at(-1)).toBe(false);
  });

  it('should hand the clearing write it could not land to the reconciler once the incumbent reclaimed', async () => {
    let intentPath = '';
    const test = await harness({
      failingPoints: (point) => {
        if (point === 'incumbent-reclaim') chmodSync(intentPath, 0o000);
        return false;
      },
      recoveryLaunch: 'fails',
    });
    const runDir = test.runtime.paths.coral.coordinator.runDir;
    intentPath = upgradeIntentPath(runDir);
    const launched = await test.launch();
    let settlement: Awaited<SuccessionLaunch['settled']>;
    try {
      settlement = await launched.settled;
    } finally {
      chmodSync(intentPath, 0o600);
    }

    expect(test.adoptedAdmissions).toBe(1);
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { disposition: 'attempting' } });
    if (settlement.kind !== 'clear-owed') throw new Error(`settlement was ${settlement.kind}`);
    expect(settlement.attemptId).toBe(test.attemptId);
    const observed = readUpgradeIntent(runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    const cleared = settlement.clear(observed.intent);
    expect(cleared).toMatchObject({ disposition: 'deferred', attemptId: null, attemptOwner: null });
    expect(cleared.blockers[0]?.reason).toContain('incumbent reclaimed after');
    expect(cleared.blockers[0]?.reason).toContain('injected committed-open failure');
  });

  it('should keep an unserved retirement mint on record when the write that would record it alone fails', async () => {
    let intentPath = '';
    const test = await harness({
      failingPoints: (point) => {
        if (point === 'incumbent-reclaim') chmodSync(intentPath, 0o600);
        return false;
      },
      recoveryLaunch: 'fails',
      targetFingerprint: `sha256:${'f'.repeat(64)}`,
      certifyCustody: async () => ({}) as unknown as RetiringCustodyCertificate,
      attempt: { onAbort: () => chmodSync(intentPath, 0o000) },
    });
    intentPath = upgradeIntentPath(test.runtime.paths.coral.coordinator.runDir);
    const dbDir = realpathSync(test.runtime.paths.coral.store.dbDir);
    const mint = epochDirectory(dbDir, '2');
    cpSync(epochDirectory(dbDir, '1'), mint, { recursive: true });
    writeFileSync(
      join(mint, '.retirement-attempt.v1.json'),
      `${JSON.stringify({ version: 'v1', attemptId: test.attemptId })}\n`,
    );
    const reader = createSharedFileLockSync(join(mint, '.lock'));
    try {
      await test.launch();
      await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    } finally {
      reader();
      chmodSync(intentPath, 0o600);
    }

    await waitForCondition(() => {
      const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
      return observed.kind === 'readable' && observed.intent.attemptId === null;
    }, 15_000);
    expect(readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir)).toMatchObject({
      intent: { unservedMintDiscard: { attemptId: test.attemptId, incumbentEpochKey: test.epochKey } },
    });
  });

  it("should not spend the target's transient retries on a preparation an obligation change outdated", async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      readiness: { kind: 'stale', reason: 'preparation is stale', cause: 'obligation-change' },
      priorTransientFailures: 6,
    });
    await test.launch();

    await waitForCondition(() => test.retryNotifications === 1, 15_000);
    const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error(`intent is ${observed.kind}`);
    expect(observed.intent.retryCondition?.kind).toBe('obligation-change');
    expect(observed.intent.transientRetry?.failures).toBe(6);
  });

  it("should bound the provider hosts' re-authorization at release by the commit deadline", async () => {
    const releases: AbortSignal[] = [];
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      pauseMs: 3_000,
      providerHosts: {
        transfersHosts: () => true,
        releaseForTransfer: (_attemptId: string, signal: AbortSignal) => {
          releases.push(signal);
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('host re-authorization was cut off')));
          });
        },
        reclaimTransferred: () => undefined,
      },
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(releases).toHaveLength(1);
    expect(test.releases).toEqual([]);
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
    expect(blockers(test.runtime)[0]?.reason).toContain('host re-authorization was cut off');
  });

  it('should stop forwarding connections before incumbent shutdown aborts the attempt', async () => {
    const test = await harness({
      failingPoints: () => false,
      recoveryLaunch: 'fails',
      attempt: { silent: true },
    });
    await test.launch();
    await waitForCondition(() => {
      const observed = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
      return observed.kind === 'readable' && observed.intent.disposition === 'attempting';
    }, 15_000);

    await test.committer.shutdown.settleUncommittedAttempt();
    expect(commitEvents).toContain('stop-forwarding');
    expect(commitEvents.indexOf('stop-forwarding')).toBeLessThan(commitEvents.indexOf('abort'));
  });
});

describe('fatal hunt: exhausted provider-transfer attempt drops the due poll', () => {
  it('resumes a pending provider attachment after actual commit failure and writer reclamation', async () => {
    const timers = new Set<{ callback: () => void; unref: () => void }>();
    let attachAttempts = 0;
    let controlFaults = 0;
    let retrySafeIncidents = 0;
    const operationProbe = createProviderOperationReconcilerHarness({
      time: {
        setTimeout: (callback) => {
          const timer = { callback, unref() {} };
          timers.add(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          timers.delete(timer as { callback: () => void; unref: () => void });
        },
      },
      attachOperation: async (operation, watermark) => {
        attachAttempts++;
        const client = {
          exchange: async () =>
            controlExchangeForTest({
              kind: 'no-response' as const,
              cause: 'timeout' as const,
              error: new ControlClientError('control_call_failed', 'temporary attachment response loss', 'timeout'),
            }),
        };
        return attachProviderOperation(
          {
            proxyClient: client,
            guardianClient: client,
            setIdentity: operationProbe.authority.setIdentity,
            mutationRpcTimeoutMs: 5_000,
            faultAuthority: () => {
              controlFaults++;
            },
            reportIncident: () => {
              retrySafeIncidents++;
            },
          },
          operation,
          watermark,
        );
      },
    });
    const fireDueTimer = () => {
      expect(timers.size).toBe(1);
      for (const timer of [...timers]) {
        timers.delete(timer);
        timer.callback();
      }
    };
    try {
      const record = providerOperationRecord('executing');
      insertProviderOperation(operationProbe.db, record);
      await operationProbe.reconciler.reconcile(record);
      expect(controlFaults).toBe(0);
      expect(retrySafeIncidents).toBe(1);
      expect(operationProbe.registry.attach).not.toHaveBeenCalled();
      operationProbe.reconciler.start();
      let releasedHostControl = false;
      const test = await harness({
        operationProbe,
        onWriterPark: fireDueTimer,
        failingPoints: () => false,
        recoveryLaunch: 'fails',
        pauseMs: 3_000,
        priorTransientFailures: 6,
        providerHosts: {
          transfersHosts: () => true,
          releaseForTransfer: (_attemptId, signal) =>
            new Promise<void>((_resolve, reject) => {
              // A controller-transfer reply misses the commit deadline. The production transfer authorizer
              // races the RPC against this signal without closing host control sockets.
              signal.addEventListener('abort', () => reject(new Error('controller-transfer reply delayed')));
            }),
          reclaimTransferred: () => {
            releasedHostControl = false;
          },
        },
      });
      await test.launch();
      await waitForCondition(() => test.adoptedAdmissions === 1, 5_000);
      const intent = readUpgradeIntent(test.runtime.paths.coral.coordinator.runDir);
      expect(intent.kind).toBe('readable');
      if (intent.kind !== 'readable') throw new Error('missing intent');
      expect(intent.intent.disposition).toBe('closed');
      expect(intent.intent.retryCondition?.kind).toBe('target-change');
      expect(test.launchFence).toContain(false);
      expect(test.releases).toHaveLength(0);
      expect(releasedHostControl).toBe(false);
      expect(providerOperationMutationAdmission(operationProbe.db).accepting).toBe(true);
      operationProbe.advance(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const scheduledAfterReclaim = timers.size;
      expect(scheduledAfterReclaim, 'reclaimed recovery retains an automatic timer').toBeGreaterThan(0);
      fireDueTimer();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(attachAttempts).toBe(2);
      expect(timers.size).toBeGreaterThan(0);
      expect(
        scheduledAfterReclaim,
        'live reclaimed coordinator has no automatic provider recovery turn',
      ).toBeGreaterThan(0);
    } finally {
      operationProbe.reconciler.stop();
      operationProbe.db.close();
    }
  });
});
