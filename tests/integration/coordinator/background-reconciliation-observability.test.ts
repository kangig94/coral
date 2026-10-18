import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { createCustodyReconciliationScheduler } from '#src/coordinator/composition/custody-reconciliation-scheduler.js';
import { createStoreEpochSweepScheduler } from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { recordCustodyIntent } from '#src/store/custody-ledger.js';
import { encodeResolvedStoreEpoch, resolveCurrentStoreEpoch, resolvedStoreEpoch } from '#src/store/epoch/index.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';

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
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  initTestJob(f.store, {
    jobId: 'retained',
    sessionId: 'retained-session',
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test-ns',
  });
  commitJobTerminal(f.store, 'retained', 'retained-session', {
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
