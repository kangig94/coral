import { testConversationFacet } from '#tests/helpers/session.js';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { createCustodyReconciliationScheduler } from '#src/coordinator/composition/custody-reconciliation-scheduler.js';
import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler/index.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { recordCustodyIntent } from '#src/store/custody-ledger.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { compareAndSwapUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { encodeResolvedStoreEpoch, resolveCurrentStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

afterEach(() => vi.useRealTimers());

it('reports real retention owners, custody passes and repeated epoch sweeps with storage counters', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = createRetentionFixture();
  let monotonic = 0n;
  const runtime = { ...f.runtime, time: { ...f.runtime.time, monotonicNow: () => monotonic } };
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const db = openSettledTestStoreDb(runtime);
  db.close();
  const selected = resolveCurrentStoreEpoch(runtime.storage, runtime.paths.coral.store.dbDir);
  if (selected === null) throw new Error('fixture has no store epoch');
  const epoch = resolvedStoreEpoch(runtime.paths.coral.store.dbDir, selected);
  const epochKey = encodeResolvedStoreEpoch(runtime, epoch);
  const index = new JobLocationIndex(
    runtime,
    runtime.paths.coral.generation.dataRoot,
    undefined,
    currentCoralStoreFormat().fingerprint,
  );
  initTestJob(f.store, {
    jobId: '93000000-0000-4000-8001-000000000001',
    projectRoot: '/workspace',
    backendNamespace: 'test-ns',
    conversation: testConversationFacet('codex', '/workspace'),
  });
  commitJobTerminal(f.store, '93000000-0000-4000-8001-000000000001', 1, {
    content: 'done',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
  recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
    effect: 'provider-operation-publication',
    epoch: dirname(epoch.path),
    owner: 'provider-operation',
    operationId: 'absent-publication',
    capsule: null,
    nowMs: runtime.time.now() - 4_000,
    bindWithinMs: 1_000,
  });
  const storeServicesRef = createStoreServicesRef();
  storeServicesRef.set({ storeDb: f.db, progressStore: f.store, consumerDriver: null });
  const custody = createCustodyReconciliationScheduler({
    runtime,
    bootId: 'background-boot',
    world: { storeServicesRef, log },
    selectedStoreEpochPath: () => dirname(epoch.path),
  });
  const retention = createStorageRetentionScheduler({
    runtime,
    bootId: 'background-boot',
    getProgressStore: () => f.store,
    openEpoch: () => epoch,
    activeEpochKey: () => epochKey,
    jobLocations: index,
    log,
    publish: () => {},
    cleanupScratch: () => {},
  });
  const sweep = createStoreEpochSweepScheduler({
    runtime,
    bootId: 'background-boot',
    world: { log },
    jobLocationIndex: index,
    selectedStoreEpochKey: () => epochKey,
    onOpen: () => {},
    closeProxySetForEpochClosure: vi.fn(),
  });
  const lines = (phase: string, event: string) =>
    logs.filter((line) => line.includes(`kind=background phase=${phase} event=${event}`));
  const exportsRoot = runtime.paths.coral.exports.jobsRoot;
  const exportSubjects = runtime.storage.existsSync(exportsRoot) ? runtime.storage.readdirSync(exportsRoot).length : 0;
  try {
    retention.start();
    sweep.schedule(epoch);
    custody.arm();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => {
      expect(lines('storage-retention', 'finish')).toHaveLength(1);
      expect(lines('store-epoch-sweep', 'finish')).toHaveLength(1);
    });
    for (const phase of ['storage-retention', 'custody-reconciliation', 'store-epoch-sweep']) {
      expect(lines(phase, 'start'), phase).toHaveLength(1);
      expect(lines(phase, 'finish')[0], phase).toMatch(/subjects=[1-9]\d* reads=[1-9]\d*/);
    }
    for (const owner of [
      'exports',
      'result-repair',
      'journal-progress',
      'journal-vacuum',
      'epoch-holders',
      'scratch-jobs',
      'job-locations',
      'custody-reconciliation',
      'custody',
    ]) {
      expect(lines(`storage-retention.${owner}`, 'start'), owner).toHaveLength(1);
      expect(lines(`storage-retention.${owner}`, 'finish'), owner).toHaveLength(1);
    }
    expect(lines('storage-retention.exports', 'finish')[0]).toContain(`subjects=${exportSubjects} `);
    expect(lines('storage-retention.journal-progress', 'finish')[0]).toContain('subjects=1 ');
    expect(lines('storage-retention.scratch-jobs', 'finish')[0]).toContain('subjects=0 ');
    expect(lines('storage-retention.result-repair', 'finish')[0]).toContain('subjects=0 ');
    expect(lines('storage-retention.epoch-holders', 'finish')[0]).toContain('subjects=0 ');
    expect(lines('storage-retention.job-locations', 'finish')[0]).toContain('subjects=0 ');
    expect(lines('storage-retention.custody', 'finish')[0]).toContain('subjects=1 ');
    custody.arm();
    monotonic += 5_000n;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(lines('store-epoch-sweep', 'finish')).toHaveLength(2));
    for (const phase of ['custody-reconciliation', 'store-epoch-sweep']) {
      expect(lines(phase, 'start')).toHaveLength(2);
      expect(lines(phase, 'finish')).toHaveLength(2);
    }
  } finally {
    await retention.stop();
    await sweep.stop();
    f.close();
  }
});

it('reports initial and repeating succession and provider-operation passes, including empty passes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = createRetentionFixture();
  const logs: string[] = [];
  const observation = { bootId: 'reconciliation-boot', log: (line: string) => logs.push(line) };
  const provider = createProviderOperationReconcilerHarness({
    observation,
    time: f.runtime.time,
    authorityFor: () => null,
  });
  const incumbent = {
    instanceId: 'incumbent',
    pid: process.pid,
    incarnation: testIncarnation(process.pid),
    version: '0.10.20',
    bundleHash: '0123456789abcdef',
    flavor: 'prod' as const,
  };
  const succession = createSuccessionReconciler({
    runtime: f.runtime,
    runDir: f.runtime.paths.coral.coordinator.runDir,
    observation,
    incumbent: () => incumbent,
    owners: [],
    epochKey: () => null,
    admissionRevision: () => 0,
    retryIntervalMs: 2_000,
  });
  const lines = (phase: string, event: string) => logs.filter((line) => line.includes(`phase=${phase} event=${event}`));
  try {
    provider.reconciler.start();
    await vi.advanceTimersByTimeAsync(25);
    for (const phase of ['succession-reconciliation', 'provider-operation-reconciliation']) {
      expect(lines(phase, 'start')).toHaveLength(1);
      expect(lines(phase, 'finish')).toHaveLength(1);
      expect(lines(phase, 'finish')[0]).toContain('outcome=complete');
      expect(lines(phase, 'finish')[0]).toContain('subjects=0 reads=0');
    }
    await vi.advanceTimersByTimeAsync(2_000);
    for (const phase of ['succession-reconciliation', 'provider-operation-reconciliation']) {
      expect(lines(phase, 'start')).toHaveLength(2);
      expect(lines(phase, 'finish')).toHaveLength(2);
      expect(lines(phase, 'finish')[1]).toContain('boot=reconciliation-boot kind=background');
    }
    expect(
      (
        await compareAndSwapUpgradeIntent(f.runtime.paths.coral.coordinator.runDir, null, {
          requestId: 'observed-intent',
          incumbent,
          target: {
            pluginRootLabel: '/missing/target',
            build: {
              version: '0.10.21',
              buildSetId: '00000000-0000-4000-8000-000000000001',
              flavor: 'prod',
              storeFormatFingerprint: currentCoralStoreFormat().fingerprint,
              bundleHash: '0123456789abcdef',
              cliBundleHash: '0123456789abcdef',
              claudeAppserverBundleHash: '0123456789abcdef',
              durableWrapperBundleHash: '0123456789abcdef',
            },
          },
          attemptId: null,
          attemptOwner: null,
          disposition: 'closed',
          blockers: [],
          retryCondition: null,
          attemptDeadline: null,
          completionReceipt: null,
        })
      ).kind,
    ).toBe('written');
    insertProviderOperation(provider.db, provider.record);
    provider.reconciler.wake();
    await succession.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    for (const phase of ['succession-reconciliation', 'provider-operation-reconciliation']) {
      expect(lines(phase, 'start')).toHaveLength(3);
      expect(lines(phase, 'finish')).toHaveLength(3);
      expect(lines(phase, 'finish')[2]).toMatch(/subjects=1 reads=[1-9]\d*/);
    }
    expect(provider.fatalErrors).toEqual([]);
  } finally {
    succession.dispose();
    provider.reconciler.stop();
    provider.db.close();
    f.close();
  }
});
