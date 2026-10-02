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
function fixture(f = createRetentionFixture()) {
  if (!fixtures.includes(f)) fixtures.push(f);
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
    hasNamespaceAuthority: () => true,
    jobLocations: new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot),
    log: vi.fn(),
    publish: (status) => statuses.push({ ...status, outcomes: [...status.outcomes] }),
    cleanupScratch: vi.fn(),
  });
  stops.push(scheduler.stop);
  return { f, scheduler, statuses };
}

describe('storage retention schedule', () => {
  it('requires pre-boot journal age when a clock correction happened before restart', async () => {
    const { f, scheduler } = fixture();
    f.db
      .prepare(
        "INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, 'job.progress.emitted', 'job', 'preboot', ?)",
      )
      .run(new Date(1).toISOString(), Buffer.from('{}'));
    f.runtime.time.monotonicNow = () => 0n;
    f.setNow(f.runtime.time.now() + 15 * 86_400_000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).toHaveBeenCalledWith(expect.objectContaining({ cutoff: 1 - 14 * 86_400_000 }));
    expect(owners.progress).toHaveBeenCalledWith(expect.objectContaining({ cutoff: 1 - 14 * 86_400_000 }));
  });

  it('persists the export continuation across scheduler instances', async () => {
    owners.exports.mockResolvedValueOnce('next-export');
    const first = fixture();
    first.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await first.scheduler.stop();
    const second = fixture(first.f);
    second.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: 'next-export' }));
  });
  it('skips deletion after a forward wall-clock jump with no corresponding elapsed time', async () => {
    const { f, scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    owners.exports.mockClear();
    owners.progress.mockClear();
    f.setNow(f.runtime.time.now() + 15 * 86_400_000);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(owners.exports).not.toHaveBeenCalled();
    expect(owners.progress).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.phase).toBe('partial');
  });

  it('reports an unfinished scan as partial with pending work', async () => {
    owners.progress.mockResolvedValueOnce(1002);
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.phase).toBe('partial');
    expect(statuses.at(-1)?.outcomes).toContainEqual(
      expect.objectContaining({ subject: 'journal-progress', reason: 'scan-pending' }),
    );
  });

  it('gives later owners their own turn after exports exhaust their slice', async () => {
    const { f, scheduler, statuses } = fixture();
    let monotonic = 0n;
    f.runtime.time.monotonicNow = () => monotonic;
    owners.exports.mockImplementationOnce(async () => {
      monotonic = 6000n;
      return 'prefix';
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.progress).toHaveBeenCalledOnce();
    expect(owners.vacuum).toHaveBeenCalledOnce();
    expect(owners.legacy).toHaveBeenCalledOnce();
    expect(owners.holders).toHaveBeenCalledOnce();
    expect(statuses.at(-1)?.phase).toBe('partial');
  });
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
    expect(owners.progress).toHaveBeenCalled();
    await scheduler.stop();
  });

  it('honors an injected monotonic deadline before scheduling any deletion', async () => {
    const { f, scheduler, statuses } = fixture();
    let calls = 0;
    f.runtime.time.monotonicNow = () => BigInt(++calls * 6000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.phase).toBe('partial');
  });
});
