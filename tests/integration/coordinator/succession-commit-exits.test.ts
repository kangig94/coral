import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import {
  createSuccessionCommitter,
  type IncumbentWriterPorts,
  type SuccessionCommitPorts,
  type SuccessionCommitter,
} from '#src/coordinator/succession/commit.js';
import { successionTargetKey } from '#src/coordinator/succession/protocol.js';
import { dischargeDeadSuccessionAttempt } from '#src/coordinator/succession/startup.js';
import type { SuccessionInterpositionPoint } from '#src/coordinator/succession/interposition.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import type { SuccessionDecision, SuccessionReconciler } from '#src/coordinator/succession/reconciler.js';
import { createDisabledKbDaemonSupervisor } from '#src/coordinator/live/kb-daemon-supervisor.js';
import type { SuccessionRelease } from '#src/coordinator/shutdown.js';
import { isProcessIncarnation, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import type { IpcListener } from '#src/transport/ipc/server.js';
import { encodeResolvedStoreEpoch, settleStoreEpoch } from '#src/store/epoch.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';
import { terminateChildProcess } from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
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
  await Promise.all(children.splice(0).map((child) => terminateChildProcess(child, 'SIGKILL')));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type AttemptBehavior = Readonly<{
  /** Record an identity the reaper cannot verify, so the failed child's absence stays unproven. */
  unprovenIdentity?: boolean;
  /** The successor neither serves nor holds, so the attempt ends only at its commit deadline. */
  silent?: boolean;
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
    forwardConnections: () => () => undefined,
    drainIncumbentConnections: async () => undefined,
    setDeadline: async () => undefined,
    // Unless silent, the successor's committed open fails: it reports a hold instead of serving.
    allowCommittedOpen: async () => {
      if (behavior.silent === true) return;
      for (const callback of acknowledgments) callback({ kind: 'hold', reason: 'injected committed-open failure' });
    },
    abort: async () => undefined,
    onAcknowledgment: (callback) => {
      acknowledgments.add(callback);
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

function reconcilerStub(readiness?: SuccessionDecision): SuccessionReconciler {
  const deferred: SuccessionDecision = { kind: 'deferred', reason: 'test reconciler' };
  return {
    incumbent: incumbentIdentity,
    request: async () => deferred,
    prepare: async () => deferred,
    reportReady: async (report) =>
      readiness ?? { kind: 'ready', preparation: preparationFor(report.epochKey, report.attemptId) },
    commit: async () => deferred,
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
  releases: readonly SuccessionRelease[];
  adoptedAdmissions: number;
  launchFence: readonly boolean[];
  startedRecoveries: number;
  retryNotifications: number;
  committer: SuccessionCommitter;
  launch(): Promise<void>;
}>;

async function harness(
  options: Readonly<{
    failingPoints: (point: SuccessionInterpositionPoint, recovery: boolean) => boolean;
    recoveryLaunch: 'fails' | 'starts';
    attempt?: AttemptBehavior;
    pauseMs?: number;
    /** What the reconciler answers when the successor reports readiness. */
    readiness?: SuccessionDecision;
    /** A target store format other than the incumbent's makes the commit a format-changing retirement. */
    targetFingerprint?: string;
    certifyCustody?: SuccessionCommitPorts['retiringEpoch']['certifyCustody'];
    /** Transient failures this target has already spent. */
    priorTransientFailures?: number;
  }>,
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-exits-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
  const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
  const preparation = preparationFor(epochKey, runtime.ids.uuid());
  const attempt = await fakeAttempt(preparation.attemptId, epochKey, options.attempt ?? {});
  const state = {
    releases: [] as SuccessionRelease[],
    adoptedAdmissions: 0,
    launchFence: [] as boolean[],
    startedRecoveries: 0,
    retryNotifications: 0,
  };
  const writers: IncumbentWriterPorts = {
    parkProviderOperationMutations: async () => undefined,
    adoptProviderOperationAdmission: () => {
      state.adoptedAdmissions += 1;
    },
    protectRetiringStore: () => ({ kind: 'protected' }),
    reopenRetiringStore: () => undefined,
    releaseAuthority: (release) => {
      state.releases.push(release);
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
      ...reconcilerStub(options.readiness),
      notifyObligationChange: () => {
        state.retryNotifications += 1;
      },
    }),
    writers: () => writers,
    kbDaemon: createDisabledKbDaemonSupervisor('test'),
    launchCoordinator: {
      admissionRevision: () => 0,
      beginSuccessionCommitWindow: (attemptId) => ({
        kind: 'paused',
        attemptId,
        deadlineAtMs: runtime.time.now() + (options.pauseMs ?? 10_000),
      }),
      endSuccessionCommitWindow: () => true,
    },
    childPrincipals: { fenceAuthentication: () => undefined, reclaimAuthentication: () => true },
    providerHosts: {
      transfersHosts: () => false,
      releaseForTransfer: async () => undefined,
      reclaimTransferred: () => undefined,
    },
    setLaunchFenceActive: (active) => state.launchFence.push(active),
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
    storeDb: () => settled.db,
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
  });
  if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
  return {
    runtime,
    db: settled.db,
    epochKey,
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
    launch: () => committer.launchPrepared(written.intent, preparation),
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

  it('should reclaim in place after a same-build recovery child fails to start', async () => {
    const test = await harness({
      failingPoints: (point, recovery) => point === 'incumbent-reclaim' && !recovery,
      recoveryLaunch: 'fails',
    });
    await test.launch();

    await waitForCondition(() => test.adoptedAdmissions === 1, 15_000);
    expect(test.startedRecoveries).toBe(1);
    expect(test.releases).toEqual([]);
    expect(test.launchFence).toEqual([true, false]);
    expect(blockers(test.runtime)[0]?.reason).toContain('incumbent reclaimed after same-build recovery launch failed');
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
    expect(retryCondition(test.runtime)?.kind).toBe('attempt-expiry');
    expect(blockers(test.runtime)[0]?.reason).toContain('outdated by an admission or epoch change');
  });

  it('should move the target to the decisive hold once its transient retries are exhausted', async () => {
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

    await test.committer.publishServing(granted.intent.attemptId, true);
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
});
