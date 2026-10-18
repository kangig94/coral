import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorServer } from '#src/coordinator/index.js';
import * as lifecycle from '#src/coordinator/lifecycle.js';
import * as startup from '#src/coordinator/succession/startup.js';
import * as storeRouting from '#src/store/startup-store-routing.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { encodeResolvedStoreEpoch, resolveCurrentStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
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

function fixture(overrides: Partial<lifecycle.LifecycleDeps> = {}) {
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
  const createLifecycle = lifecycle.createLifecycle;
  vi.spyOn(lifecycle, 'createLifecycle').mockImplementation((deps, recover) =>
    createLifecycle({ ...deps, ...overrides }, recover),
  );
  const logs: string[] = [];
  const coordinator = createCoordinatorServer({
    runtime,
    pluginRoot,
    onFatalShutdownError: vi.fn(),
    bootSnapshot: { log: (line) => logs.push(line) },
    kbDaemonSupervisor: createMockKbDaemonSupervisor(),
    writeBackendInfoFn: () => true,
    removeBackendInfoIfOwnerFn: () => {},
    createServerFn: (handler) => createServer(handler),
    listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
    closeServerFn: async () => {},
  });
  coordinators.push(coordinator);
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
    runtime,
    logs,
    open,
    openCommitted,
    advance: (ms: number) => {
      now += BigInt(ms);
    },
  };
}

function phaseLines(logs: string[], phase: string) {
  return logs.filter((line) => line.includes(` kind=startup phase=${phase} event=finish `));
}

describe('startup phase observations through lifecycle fallbacks', () => {
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
    expect(phaseLines(f.logs, 'store-open')[0]).toContain('duration_ms=18.000');
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
    expect(phaseLines(f.logs, 'store-open')[0]).toContain('duration_ms=17.000');
  });

  it('reports a completed boot when legacy serving settlement retains its listeners', async () => {
    const f = fixture({
      scheduleStoreEpochSweepFn: () => {
        throw new Error('after legacy serving');
      },
    });
    vi.spyOn(startup, 'recordSupervisorLegacyChild').mockResolvedValue(true);
    vi.spyOn(startup, 'completeSupervisorLegacyUpgrade').mockResolvedValue({ kind: 'completed' });
    await expect(f.coordinator.start()).resolves.toMatchObject({ instanceId: expect.any(String) });
    expect(phaseLines(f.logs, 'boot')).toHaveLength(1);
    expect(phaseLines(f.logs, 'boot')[0]).toContain('outcome=complete');
  });
});
