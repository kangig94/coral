import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { RetentionRunStatus } from '#src/store/retention-outcome.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';

const owners = vi.hoisted(() => ({
  exports: vi.fn(async () => ''),
  progress: vi.fn(async () => 0),
  vacuum: vi.fn(async () => ({ kind: 'kept', subject: 'vacuum', reason: 'no-free-pages' })),
  legacy: vi.fn(() => ({ kind: 'kept', subject: 'legacy', reason: 'legacy-absent' })),
  holders: vi.fn(async () => {}),
  parked: false,
}));
vi.mock('#src/jobs/export-retention.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneJobExports: owners.exports,
}));
vi.mock('#src/jobs/progress-retention.js', () => ({ pruneJobProgress: owners.progress }));
vi.mock('#src/store/retention-vacuum.js', () => ({ vacuumRetainedJournal: owners.vacuum }));
vi.mock('#src/store/epoch/legacy-retention.js', () => ({ removeLegacyStore: owners.legacy }));
vi.mock('#src/store/epoch/holder.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneStoreEpochHolders: owners.holders,
}));
vi.mock('#src/store/succession-writer-generation.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  joinSuccessionWriterGeneration: () => ({
    assertCurrent: () => {
      if (owners.parked) throw new Error('parked');
    },
    beginWriteTurn: () => () => {},
    withWriteTurn: <T>(operation: () => T) => operation(),
  }),
}));

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
const stops: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  owners.parked = false;
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const f of fixtures.splice(0)) f.close();
  vi.useRealTimers();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  const statuses: RetentionRunStatus[] = [];
  const scheduler = createStorageRetentionScheduler({
    runtime: f.runtime,
    getProgressStore: () => f.store,
    openEpoch: () => ({
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: '/tmp/fixture/epoch-1/store.db',
    }),
    activeEpochKey: () => 'active',
    jobLocations: new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot),
    log: vi.fn(),
    publish: (status) => statuses.push({ ...status, outcomes: [...status.outcomes] }),
    cleanupScratch: vi.fn(),
  });
  stops.push(scheduler.stop);
  return { f, scheduler, statuses };
}

describe('storage retention schedule', () => {
  it('starts without waiting, runs once at startup and retries after exactly 24 hours', async () => {
    const { scheduler, statuses } = fixture();
    scheduler.start();
    scheduler.start();
    expect(owners.exports).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.phase).toBe('completed');
    await vi.advanceTimersByTimeAsync(86_399_999);
    expect(owners.exports).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(owners.exports).toHaveBeenCalledTimes(2);
  });
  it('reports a failed owner without crashing, continues independent owners and retries next cycle', async () => {
    owners.exports.mockRejectedValueOnce(new Error('injected export failure'));
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({ phase: 'failed', failed: 1 });
    expect(statuses.at(-1)?.outcomes).toContainEqual({
      kind: 'failed',
      subject: 'exports',
      reason: 'injected export failure',
    });
    expect(owners.progress).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(owners.exports).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)?.failed).toBe(0);
  });
  it('keeps every deletion owner parked and stops all future cycles on shutdown', async () => {
    owners.parked = true;
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).not.toHaveBeenCalled();
    expect(owners.progress).not.toHaveBeenCalled();
    expect(owners.vacuum).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.phase).toBe('partial');
    owners.parked = false;
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(owners.exports).toHaveBeenCalledOnce();
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(owners.exports).toHaveBeenCalledOnce();
  });
  it('bounds a stalled owner and cancels its successor work on shutdown without waiting for the owner', async () => {
    owners.exports.mockImplementationOnce(() => new Promise<string>(() => {}));
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.phase).toBe('running');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses.at(-1)?.phase).toBe('partial');
    expect(owners.progress).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('honors an injected monotonic deadline before scheduling any deletion', async () => {
    const { f, scheduler, statuses } = fixture();
    let calls = 0;
    f.runtime.time.monotonicNow = () => BigInt(++calls <= 2 ? 0 : 30_000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.phase).toBe('partial');
  });
});
