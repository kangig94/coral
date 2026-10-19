import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorServer } from '#src/coordinator/index.js';
import * as lifecycle from '#src/coordinator/lifecycle.js';
import * as startup from '#src/coordinator/succession/startup.js';
import * as storeRouting from '#src/store/startup-store-routing.js';
import * as jobsStartup from '#src/jobs/startup.js';
import * as reactorModule from '#src/sessions/lifecycle-reactor.js';
import * as phaseObservation from '#src/recovery/phase-observation.js';
import { SessionManager } from '#src/sessions/shell.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeResolvedStoreEpoch, resolveCurrentStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const roots: string[] = [];
const coordinators: ReturnType<typeof createCoordinatorServer>[] = [];

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    await coordinator.shutdown('test-teardown');
    await coordinator.waitForShutdown();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Partial<lifecycle.LifecycleDeps> = {}, backlog = 0) {
  const home = mkdtempSync(join(tmpdir(), 'coral-phase-observation-'));
  roots.push(home);
  const pluginRoot = join(home, 'plugin');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }),
  );
  vi.stubEnv('HOME', home);
  let now = 0n;
  const real = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const runtime = { ...real, time: { ...real.time, monotonicNow: () => now } };
  const order: string[] = [];
  const transitions = vi.fn();
  const writeBackendInfo = vi.fn(() => true);
  let runtimeState: lifecycle.LifecycleDeps['runtimeState'];
  let reactor: reactorModule.LifecycleReactor;
  let startupOptions: jobsStartup.JobsStartupContext;
  const createReactor = reactorModule.createLifecycleReactor;
  vi.spyOn(reactorModule, 'createLifecycleReactor').mockImplementation((options) => {
    reactor = createReactor(options);
    const admit = reactor.admitRetention.bind(reactor);
    vi.spyOn(reactor, 'admitRetention').mockImplementation(() => {
      const admitted = reactor.isRetentionAdmitted();
      admit();
      if (!admitted && reactor.isRetentionAdmitted()) {
        transitions({
          lifecycle: runtimeState.getLifecycle(),
          launchFenceActive: runtimeState.getLaunchFenceActive(),
          discoveryPublished: writeBackendInfo.mock.calls.length > 0,
        });
        order.push('admitted');
      }
    });
    const observe = reactor.observe;
    vi.spyOn(reactor, 'observe').mockImplementation((events) => {
      for (const event of events) {
        if (event.type === 'session.retention.discard.requested') order.push('discard-requested');
      }
      observe(events);
    });
    return reactor;
  });
  const createPhases = phaseObservation.createStartupPhaseObserver;
  vi.spyOn(phaseObservation, 'createStartupPhaseObserver').mockImplementation((options) => {
    const phases = createPhases(options);
    return {
      ...phases,
      options: (phase) => {
        const observation = phases.options(phase);
        return {
          ...observation,
          completed: (result: Parameters<NonNullable<typeof observation.completed>>[0]) => {
            observation.completed?.(result);
            if (phase === 'serving') order.push(`serving-${result.outcome}`);
          },
        };
      },
    };
  });
  const createJobsRunner = jobsStartup.createJobsStartupRunner;
  let backlogSeeded = false;
  vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockImplementation((recover) => {
    const run = createJobsRunner(recover);
    return async (options) => {
      startupOptions = options;
      const result = await run(options);
      if (backlogSeeded) return result;
      backlogSeeded = true;
      const sessions = SessionManager.forProduction(home, runtime, options.coordinatorCommit, () => {}, {
        db: options.progressStore.getDb(),
      });
      for (let index = 0; index < backlog; index += 1) {
        const session = sessions.open({
          binding: TEST_CODEX_BINDING,
          name: `backlog-${index}`,
          cwd: home,
          projectRoot: home,
          backendNamespace: options.namespace,
          retention: 'discard_provider_artifacts_on_terminal',
        });
        const jobId = `backlog-${index}`;
        sessions.claimForJobSync(session.sessionId, jobId);
        initTestJob(options.progressStore, {
          jobId,
          sessionId: session.sessionId,
          provider: 'codex',
          projectRoot: home,
          backendNamespace: options.namespace,
          initialPhase: 'running',
        });
        commitJobTerminal(options.progressStore, jobId, session.sessionId, {
          content: 'done',
          outcome: { kind: 'completed' },
          durationMs: 1,
        });
        sessions.releaseJob(session.sessionId, jobId);
      }
      return result;
    };
  });
  const createLifecycle = lifecycle.createLifecycle;
  let lifecycleOverrides = overrides;
  vi.spyOn(lifecycle, 'createLifecycle').mockImplementation((deps, recover) => {
    runtimeState = deps.runtimeState;
    return createLifecycle({ ...deps, ...lifecycleOverrides }, recover);
  });
  const logs: string[] = [];
  function createCoordinator() {
    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      onFatalShutdownError: vi.fn(),
      bootSnapshot: { log: (line) => logs.push(line) },
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      writeBackendInfoFn: writeBackendInfo,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });
    coordinators.push(coordinator);
    return coordinator;
  }
  const coordinator = createCoordinator();
  const open = () => {
    const db = openSettledTestStoreDb(runtime);
    const epoch = resolveCurrentStoreEpoch(runtime.storage, runtime.paths.coral.store.dbDir);
    if (epoch === null) throw new Error('fixture store has no selected epoch');
    return { db, store: resolvedStoreEpoch(runtime.paths.coral.store.dbDir, epoch) };
  };
  const openCommitted = (): Awaited<ReturnType<typeof startup.openCommittedRecoveryStore>> => {
    const opened = open();
    return {
      ...opened,
      preparation: {
        version: 'v1',
        requestId: 'request',
        attemptId: 'recovery',
        incumbentInstanceId: 'prior',
        incumbentPid: 1,
        incumbentKey: 'prior-key',
        targetKey: 'target',
        capabilitiesKey: 'capabilities',
        epochKey: encodeResolvedStoreEpoch(runtime, opened.store),
        admissionRevision: 0,
        accepts: [],
        receipts: [],
        stage: 'prepared',
        ready: null,
      },
      generation: { generation: 1, storeRoot: opened.store.storeRoot, epoch: opened.store.epoch },
      incarnation: testIncarnation(process.pid),
    };
  };
  return {
    coordinator,
    successor: () => {
      lifecycleOverrides = {};
      return createCoordinator();
    },
    runtime,
    logs,
    open,
    openCommitted,
    order,
    transitions,
    reactor: () => reactor,
    retentionEvents: () =>
      startupOptions.progressStore
        .getDb()
        .prepare<[], { type: string }>("SELECT type FROM events WHERE type LIKE 'session.retention.discard.%'")
        .all()
        .map(({ type }) => type),
    advance: (ms: number) => {
      now += BigInt(ms);
    },
  };
}

function phaseLines(logs: string[], phase: string) {
  return logs.filter((line) => line.includes(` kind=startup phase=${phase} event=finish `));
}

describe('startup phase observations through lifecycle fallbacks', () => {
  it.each([1, 5])('serves after component scanning with %s deferred retention subjects', async (backlog) => {
    const f = fixture({}, backlog);
    const settle = reactorModule.LifecycleReactor.prototype.enforceRetention;
    const held = createDeferred();
    const settlement = vi
      .spyOn(reactorModule.LifecycleReactor.prototype, 'enforceRetention')
      .mockImplementation(async function (this: reactorModule.LifecycleReactor, work) {
        await held.promise;
        f.advance(1_000);
        return settle.call(this, work);
      });
    const scan = reactorModule.LifecycleReactor.prototype.scanStartup;
    vi.spyOn(reactorModule.LifecycleReactor.prototype, 'scanStartup').mockImplementation(async function (
      this: reactorModule.LifecycleReactor,
      signal,
      observation,
    ) {
      await scan.call(this, signal, observation);
      expect(settlement).not.toHaveBeenCalled();
      expect(f.retentionEvents()).toEqual([]);
      f.advance(7);
    });
    try {
      await f.coordinator.start();
      expect(f.order.slice(0, 2)).toEqual(['serving-complete', 'admitted']);
      expect(f.transitions).toHaveBeenCalledOnce();
      const scanLine = phaseLines(f.logs, 'reactor-scan')[0];
      expect(scanLine).toContain('duration_ms=7.000');
      expect(scanLine).toContain(`"session-retention-work":{"subjects":${backlog},"reads":0}`);
      expect(phaseLines(f.logs, 'recovery-and-serve')[0]).toContain('duration_ms=7.000');
      expect(f.retentionEvents()).toEqual([]);
    } finally {
      held.resolve();
      await f.reactor().waitForIdle();
    }
    expect(settlement).toHaveBeenCalledTimes(backlog);
    expect(f.order.indexOf('discard-requested')).toBeGreaterThan(f.order.indexOf('admitted'));
    expect(f.retentionEvents().filter((type) => type.endsWith('.completed'))).toHaveLength(backlog);
    const background = f.logs.filter((line) => line.includes('kind=background phase=reactor-recovery event=finish'));
    expect(
      background.some((line) => line.includes(`"session-retention-work":{"subjects":${backlog},"reads":0}`)),
    ).toBe(true);
    const passes = f.logs.filter((line) => line.includes('kind=background phase=reactor-recovery event=start')).length;
    f.reactor().admitRetention();
    f.reactor().admitRetention();
    await f.reactor().waitForIdle();
    expect(f.transitions).toHaveBeenCalledOnce();
    expect(f.logs.filter((line) => line.includes('kind=background phase=reactor-recovery event=start'))).toHaveLength(
      passes,
    );
  });

  it('settles after serving while dead-attempt discharge still holds the start result', async () => {
    const f = fixture({}, 2);
    const seeded = f.open();
    const epochKey = encodeResolvedStoreEpoch(f.runtime, seeded.store);
    seeded.db.close();
    vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({
      kind: 'recover',
      preferredEpochKey: epochKey,
      attempt: { attemptId: 'dead', epochKey, force: false },
    } as Awaited<ReturnType<typeof startup.resolveIncompleteSuccessionAtStartup>>);
    vi.spyOn(startup, 'handBackDeadAttemptGeneration').mockResolvedValue('settled');
    vi.spyOn(startup, 'openPreferredStoreEpoch').mockImplementation(async () => f.open());
    const discharge = createDeferred();
    const entered = createDeferred();
    vi.spyOn(startup, 'dischargeDeadSuccessionAttempt').mockImplementation(async () => {
      entered.resolve();
      await discharge.promise;
    });
    let returned = false;
    const start = f.coordinator.start().then((info) => {
      returned = true;
      return info;
    });
    try {
      await entered.promise;
      await f.reactor().waitForIdle();
      expect(returned).toBe(false);
      expect(f.order.slice(0, 2)).toEqual(['serving-complete', 'admitted']);
      expect(f.retentionEvents().filter((type) => type.endsWith('.completed'))).toHaveLength(2);
      expect(f.logs.some((line) => line.includes('kind=background phase=reactor-recovery event=finish'))).toBe(true);
      expect(f.logs.some((line) => line.includes('Running on'))).toBe(false);
    } finally {
      discharge.resolve();
      await start;
    }
  });

  it('keeps an aborted boot deferred and settles its backlog when a successor serves', async () => {
    const entered = createDeferred<AbortSignal>();
    const release = createDeferred();
    const f = fixture(
      {
        startStorageRetentionFn: undefined,
        cleanupStaleJobsFn: async (_bundleHash, signal) => {
          entered.resolve(signal);
          await release.promise;
          signal.throwIfAborted();
        },
      },
      2,
    );
    const start = expect(f.coordinator.start()).rejects.toMatchObject({ name: 'AbortError' });
    const signal = await entered.promise;
    const abortedReactor = f.reactor();
    try {
      expect(abortedReactor.isRetentionAdmitted()).toBe(false);
      expect(f.transitions).not.toHaveBeenCalled();
      expect(f.retentionEvents()).toEqual([]);
    } finally {
      const shutdown = f.coordinator.shutdown('test-teardown');
      release.resolve();
      await start;
      await shutdown;
      await f.coordinator.waitForShutdown();
    }
    expect(signal.aborted).toBe(true);
    expect(abortedReactor.isRetentionAdmitted()).toBe(false);
    expect(f.transitions).not.toHaveBeenCalled();
    expect(f.order).toEqual([]);
    const persisted = f.open();
    expect(
      persisted.db.prepare("SELECT type FROM events WHERE type LIKE 'session.retention.discard.%'").all(),
    ).toEqual([]);
    persisted.db.close();
    const successor = f.successor();
    await successor.start();
    await f.reactor().waitForIdle();
    expect(f.order.slice(0, 2)).toEqual(['serving-complete', 'admitted']);
    expect(f.transitions).toHaveBeenCalledOnce();
    expect(f.retentionEvents().filter((type) => type.endsWith('.completed'))).toHaveLength(2);
  });

  it('completes every runner phase once when receipt adoption reruns recovery', async () => {
    const adopt = vi.fn(() => {
      throw new Error('adoption failed');
    });
    const f = fixture({ verifySuccessionReceipts: () => [], adoptSuccessionReceipts: adopt });
    vi.spyOn(startup, 'prepareCommittedSuccessorRecovery').mockResolvedValue({
      kind: 'recover',
      intent: { completionReceipt: { successor: { instanceId: 'prior' } } },
    } as Awaited<ReturnType<typeof startup.prepareCommittedSuccessorRecovery>>);
    vi.spyOn(startup, 'holdFailedCommittedRecovery').mockResolvedValue('abandoned');
    vi.spyOn(startup, 'openCommittedRecoveryStore').mockImplementation(async () => f.openCommitted());
    await f.coordinator.start();
    expect(adopt).toHaveBeenCalledOnce();
    for (const phase of [
      'job-locations',
      'journal-barrier',
      'jobs-startup',
      'discussion',
      'workflow',
      'reactor-scan',
    ]) {
      expect(phaseLines(f.logs, phase), phase).toHaveLength(1);
    }
    expect(phaseLines(f.logs, 'job-locations')[0]).toContain('"job-high-water":{"subjects":0,"reads":2}');
    expect(phaseLines(f.logs, 'boot')[0]).toContain('outcome=complete');
  });

  it('sums the committed open and receipt-verification fallback open', async () => {
    const f = fixture({
      verifySuccessionReceipts: () => {
        throw new Error('verification failed');
      },
    });
    vi.spyOn(startup, 'prepareCommittedSuccessorRecovery').mockResolvedValue({
      kind: 'recover',
      intent: { completionReceipt: { successor: { instanceId: 'prior' } } },
    } as Awaited<ReturnType<typeof startup.prepareCommittedSuccessorRecovery>>);
    vi.spyOn(startup, 'holdFailedCommittedRecovery').mockResolvedValue('abandoned');
    vi.spyOn(startup, 'openCommittedRecoveryStore').mockImplementation(async () => {
      const opened = f.openCommitted();
      f.advance(7);
      return opened;
    });
    const route = storeRouting.routeOrOpenBackendStoreAtStartup;
    vi.spyOn(storeRouting, 'routeOrOpenBackendStoreAtStartup').mockImplementation(async (input) => {
      const opened = await route(input);
      f.advance(11);
      return opened;
    });
    await f.coordinator.start();
    expect(phaseLines(f.logs, 'store-open')).toHaveLength(1);
    expect(phaseLines(f.logs, 'store-open')[0]).toContain('duration_ms=18.000 attempts=2\n');
    expect(phaseLines(f.logs, 'store-open')[0]).not.toMatch(/subjects=|reads=|sources=/);
  });

  it('includes a preferred epoch opened during authority preparation', async () => {
    const f = fixture();
    const seeded = f.open();
    const epochKey = encodeResolvedStoreEpoch(f.runtime, seeded.store);
    seeded.db.close();
    vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({
      kind: 'recover',
      preferredEpochKey: epochKey,
      attempt: { attemptId: 'dead', epochKey, force: false },
    } as Awaited<ReturnType<typeof startup.resolveIncompleteSuccessionAtStartup>>);
    vi.spyOn(startup, 'handBackDeadAttemptGeneration').mockResolvedValue('settled');
    vi.spyOn(startup, 'dischargeDeadSuccessionAttempt').mockResolvedValue(undefined);
    vi.spyOn(startup, 'openPreferredStoreEpoch').mockImplementation(async () => {
      const opened = f.open();
      f.advance(17);
      return opened;
    });
    await f.coordinator.start();
    expect(phaseLines(f.logs, 'store-open')).toHaveLength(1);
    expect(phaseLines(f.logs, 'store-open')[0]).toContain('duration_ms=17.000 attempts=1\n');
  });

  it('reports a completed boot when legacy serving settlement retains its listeners', async () => {
    const f = fixture(
      {
        scheduleStoreEpochSweepFn: () => {
          throw new Error('after legacy serving');
        },
      },
      2,
    );
    vi.spyOn(startup, 'recordSupervisorLegacyChild').mockResolvedValue(true);
    vi.spyOn(startup, 'completeSupervisorLegacyUpgrade').mockResolvedValue({ kind: 'completed' });
    await expect(f.coordinator.start()).resolves.toMatchObject({ instanceId: expect.any(String) });
    expect(phaseLines(f.logs, 'boot')).toHaveLength(1);
    expect(phaseLines(f.logs, 'boot')[0]).toContain('outcome=complete');
    await f.reactor().waitForIdle();
    expect(phaseLines(f.logs, 'serving')[0]).toContain('outcome=failed');
    expect(f.order.slice(0, 2)).toEqual(['serving-failed', 'admitted']);
    expect(f.transitions).toHaveBeenCalledOnce();
    expect(f.transitions).toHaveBeenCalledWith({
      lifecycle: 'running',
      launchFenceActive: false,
      discoveryPublished: true,
    });
    expect(f.retentionEvents().filter((type) => type.endsWith('.completed'))).toHaveLength(2);
    f.reactor().admitRetention();
    await f.reactor().waitForIdle();
    expect(f.transitions).toHaveBeenCalledOnce();
  });
});
