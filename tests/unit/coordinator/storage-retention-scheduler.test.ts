import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { RetentionOutcome, RetentionRunBudget, RetentionRunStatus } from '#src/store/retention-outcome.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';
import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';

const owners = vi.hoisted(() => ({
  exports: vi.fn(async (_input?: { budget: RetentionRunBudget }) => ''),
  progress: vi.fn(async (_input: { budget: RetentionRunBudget }) => 0),
  vacuum: vi.fn(
    async (): Promise<RetentionOutcome> => ({
      kind: 'kept',
      subject: 'vacuum',
      reason: 'no-free-pages',
      pending: false,
    }),
  ),
  holders: vi.fn(async (_runtime: unknown, _budget: RetentionRunBudget) => ''),
  reconciliation: vi.fn(async (_input: { budget: RetentionRunBudget }) => ''),
  custody: vi.fn(async (_input: { budget: RetentionRunBudget }) => ''),
  scratch: vi.fn(async (_signal: AbortSignal, _budget: RetentionRunBudget) => {}),
  parked: false,
}));
vi.mock('#src/jobs/export-retention.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneJobExports: owners.exports,
}));
vi.mock('#src/jobs/progress-retention.js', () => ({ pruneJobProgress: owners.progress }));
vi.mock('#src/store/retention-vacuum.js', () => ({ vacuumRetainedJournal: owners.vacuum }));
vi.mock('#src/store/epoch/holder.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneStoreEpochHolders: owners.holders,
}));
vi.mock('#src/coordinator/services/recovery/custody-reconciliation.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reconcileFinishedCustody: owners.reconciliation,
}));
vi.mock('#src/store/custody-ledger.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneCustodyLedger: owners.custody,
}));
vi.mock('#src/store/succession-writer-generation.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  joinSuccessionWriterGeneration: () => ({
    assertCurrent: () => {
      if (owners.parked) throw new Error('parked');
    },
    beginWriteTurn: () => () => {},
    withWriteTurn: <T>(operation: () => T) => {
      if (owners.parked) throw new Error('parked');
      return operation();
    },
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(f = createRetentionFixture(), getProgressStore = () => f.store) {
  if (!fixtures.includes(f)) fixtures.push(f);
  const fixedWall = f.runtime.time.now;
  const originalMonotonic = f.runtime.time.monotonicNow;
  const start = originalMonotonic();
  f.runtime.time.now = () =>
    fixedWall() + (f.runtime.time.monotonicNow === originalMonotonic ? Number(originalMonotonic() - start) : 0);
  const statuses: RetentionRunStatus[] = [];
  const scheduler = createStorageRetentionScheduler({
    runtime: f.runtime,
    getProgressStore,
    openEpoch: () => ({
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: '/tmp/fixture/epoch-1/store.db',
    }),
    activeEpochKey: () => 'active',
    jobLocations: new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot),
    log: vi.fn(),
    publish: (status) => statuses.push({ ...status, outcomes: [...status.outcomes] }),
    cleanupScratch: owners.scratch,
  });
  stops.push(scheduler.stop);
  return { f, scheduler, statuses };
}

describe('storage retention schedule', () => {
  it('coalesces repeated hints for one failed job while preserving automatic backoff', async () => {
    const { f, scheduler } = fixture();
    const repair = vi.spyOn(f.store.getResultExportOwner(), 'repairPass').mockImplementation(async (_ids, budget) => {
      budget.record({ kind: 'failed', subject: 'job-pending', reason: 'ENOSPC' });
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 40; i++) {
      f.store.getResultExportOwner().hintRepair('job-pending');
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(repair).toHaveBeenCalledTimes(2);
    expect(owners.exports).toHaveBeenCalledTimes(1);
  });
  it('uses the wall-clock cutoff across idle restarts without a boot anchor', async () => {
    const first = fixture();
    first.f.setNow(first.f.runtime.time.now() + 30 * 86_400_000);
    first.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cutoff: first.f.runtime.time.now() - 14 * 86_400_000 - 60_000,
      }),
    );
    await first.scheduler.stop();
    first.f.setNow(first.f.runtime.time.now() + 86_400_000);
    first.f.runtime.time = { ...first.f.runtime.time };
    const second = fixture(first.f);
    second.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cutoff: first.f.runtime.time.now() - 14 * 86_400_000 - 60_000,
      }),
    );
  });

  it.each(['terminal-not-expired-or-unknown', 'terminal-clock-regression', 'residue-recent-or-unobservable'])(
    'reports %s as a visible pending hold',
    async (reason) => {
      owners.progress.mockImplementationOnce(async ({ budget }) => {
        budget.record({ kind: 'kept', subject: 'held-job', reason });
        return 0;
      });
      const { scheduler, statuses } = fixture();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(statuses.at(-1)?.phase).toBe('partial');
      expect(statuses.at(-1)?.outcomes).toContainEqual({ kind: 'kept', subject: 'held-job', reason });
    },
  );

  it('keeps distinct pending reasons visible when the outcome list fills with age holds', async () => {
    owners.progress.mockImplementationOnce(async ({ budget }) => {
      for (let i = 0; i < 110; i += 1)
        budget.record({ kind: 'kept', subject: `age-${i}`, reason: 'terminal-not-expired-or-unknown' });
      budget.record({ kind: 'kept', subject: 'regression', reason: 'terminal-clock-regression' });
      budget.record({ kind: 'kept', subject: 'residue', reason: 'residue-recent-or-unobservable' });
      return 0;
    });
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.phase).toBe('partial');
    for (const reason of [
      'terminal-not-expired-or-unknown',
      'terminal-clock-regression',
      'residue-recent-or-unobservable',
    ])
      expect(statuses.at(-1)?.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', reason }));
  });

  it('persists the export continuation across scheduler instances', async () => {
    owners.exports.mockResolvedValueOnce('next-export');
    const first = fixture();
    first.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await first.scheduler.stop();
    first.f.runtime.time = { ...first.f.runtime.time };
    const second = fixture(first.f);
    second.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(owners.exports).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: 'next-export' }));
  });
  it('skips deletion after a forward wall-clock jump with no corresponding elapsed time', async () => {
    const { f, scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(86_400_000 - 1);
    trustedJobRetentionCutoff(f.runtime);
    owners.exports.mockClear();
    owners.progress.mockClear();
    f.setNow(f.runtime.time.now() + 15 * 86_400_000);
    await vi.advanceTimersByTimeAsync(1);
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

  it('reports a new unknown reason as partial without registering its text', async () => {
    owners.progress.mockImplementationOnce(async ({ budget }) => {
      budget.record({ kind: 'kept', subject: 'future-owner', reason: 'future-evidence-refusal' });
      return 0;
    });
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.phase).toBe('partial');
    expect(statuses.at(-1)?.outcomes).toContainEqual({
      kind: 'kept',
      subject: 'future-owner',
      reason: 'future-evidence-refusal',
    });
  });

  it('reports completed when an owner proves a kept subject has no eligible work', async () => {
    owners.progress.mockImplementationOnce(async ({ budget }) => {
      budget.record({
        kind: 'kept',
        subject: 'protected-evidence',
        reason: 'future-protected-evidence',
        pending: false,
      });
      return 0;
    });
    const { scheduler, statuses } = fixture();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)?.phase).toBe('completed');
  });
});

it('keeps at most one unsettled run per owner and retries after that run finishes', async () => {
  let finish!: (value: string) => void;
  owners.exports.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const { f, scheduler, statuses } = fixture();
  const initialWall = f.runtime.time.now();
  let monotonic = 0n;
  f.runtime.time.monotonicNow = () => monotonic;
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  monotonic = 5000n;
  await vi.advanceTimersByTimeAsync(5000);
  expect(statuses.at(-1)?.phase).toBe('partial');
  for (let day = 1; day <= 3; day++) {
    monotonic = BigInt(day * 86_400_000);
    f.setNow(initialWall + day * 86_400_000);
    await vi.advanceTimersByTimeAsync(day === 1 ? 86_395_000 : 86_400_000);
    expect(owners.exports).toHaveBeenCalledOnce();
    expect(statuses.at(-1)?.outcomes).toContainEqual({
      kind: 'kept',
      subject: 'exports',
      reason: 'previous-owner-still-running',
    });
  }
  finish('late-cursor');
  await vi.advanceTimersByTimeAsync(0);
  monotonic = BigInt(4 * 86_400_000);
  f.setNow(initialWall + 4 * 86_400_000);
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(owners.exports).toHaveBeenCalledTimes(2);
  expect(owners.exports).toHaveBeenLastCalledWith(expect.objectContaining({ afterId: '' }));
  expect(statuses.at(-1)?.phase).toBe('completed');
});

it('drops an already queued retention timer callback after stop', async () => {
  const f = createRetentionFixture();
  let queued!: () => void;
  const schedule = f.runtime.time.setTimeout;
  f.runtime.time.setTimeout = (callback, ms) => {
    queued = callback;
    return schedule(callback, ms);
  };
  const { scheduler, statuses } = fixture(f);
  scheduler.start();
  await scheduler.stop();
  queued();
  await Promise.resolve();
  expect(owners.exports).not.toHaveBeenCalled();
  expect(statuses).toEqual([]);
});

it('drains a budget backlog after five minutes then returns to the daily interval', async () => {
  owners.exports
    .mockImplementationOnce(async (input) => {
      input!.budget.record({ kind: 'deleted', subject: 'export', count: 1 });
      return 'pending';
    })
    .mockResolvedValue('');
  const { scheduler } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(owners.exports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(owners.exports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(owners.exports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(86_399_999);
  expect(owners.exports).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(owners.exports).toHaveBeenCalledTimes(3);
});

it('reports counts per deletion owner while preserving the aggregate count', async () => {
  owners.exports.mockImplementationOnce(async (input) => {
    (input as { budget: RetentionRunBudget }).budget.record({ kind: 'deleted', subject: 'export', count: 3 });
    return '';
  });
  owners.progress.mockImplementationOnce(async ({ budget }) => {
    budget.record({ kind: 'deleted', subject: 'progress', count: 17 });
    return 0;
  });
  owners.vacuum.mockResolvedValueOnce({ kind: 'deleted', subject: 'journal-vacuum', count: 5 });
  const { scheduler, statuses } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(statuses.at(-1)).toMatchObject({
    deleted: 25,
    deletedByOwner: { exports: 3, progressRows: 17, holderMarkers: 0, scratch: 0, custody: 0, vacuumPages: 5 },
  });
});

it.each(['exports', 'progress', 'vacuum', 'holders', 'locations', 'reconciliation', 'custody', 'scratch'] as const)(
  'returns a %s hold with no progress to daily cadence',
  async (owner) => {
    const { f, scheduler } = fixture();
    const held = (budget: RetentionRunBudget) =>
      budget.record({ kind: 'kept', subject: owner, reason: 'scan-pending' });
    if (owner === 'exports')
      owners.exports.mockImplementationOnce(async (input) => {
        held(input!.budget);
        return 'unchanged';
      });
    if (owner === 'progress')
      owners.progress.mockImplementationOnce(async (input) => {
        held(input.budget);
        return 1;
      });
    if (owner === 'vacuum')
      owners.vacuum.mockResolvedValueOnce({ kind: 'kept', subject: owner, reason: 'scan-pending' });
    if (owner === 'holders')
      owners.holders.mockImplementationOnce(async (_runtime, budget) => {
        held(budget);
        return 'unchanged';
      });
    if (owner === 'locations')
      vi.spyOn(JobLocationIndex.prototype, 'compactTerminalRecords').mockImplementationOnce(async (_after, budget) => {
        held(budget);
        return 'unchanged';
      });
    if (owner === 'reconciliation' || owner === 'custody')
      owners[owner].mockImplementationOnce(async (input) => {
        held(input.budget);
        return 'unchanged';
      });
    if (owner === 'scratch')
      owners.scratch.mockImplementationOnce(async (_signal, budget) => {
        held(budget);
      });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(owners.exports).toHaveBeenCalledTimes(1);
    f.setNow(f.runtime.time.now());
    await vi.advanceTimersByTimeAsync(86_100_000);
    expect(owners.exports).toHaveBeenCalledTimes(2);
  },
);

it.each(['exports', 'progress', 'vacuum', 'holders', 'locations', 'reconciliation', 'custody', 'scratch'] as const)(
  'holds %s to daily cadence while another owner progresses',
  async (owner) => {
    const hold = (budget: RetentionRunBudget) =>
      budget.record({ kind: 'kept', subject: owner, reason: 'scan-pending' });
    const { scheduler, statuses } = fixture();
    if (owner === 'exports')
      owners.exports.mockImplementationOnce(async (input) => {
        hold(input!.budget);
        return 'unchanged';
      });
    if (owner === 'progress')
      owners.progress.mockImplementationOnce(async ({ budget }) => {
        hold(budget);
        return 1;
      });
    if (owner === 'vacuum')
      owners.vacuum.mockImplementationOnce(async () => {
        return { kind: 'kept', subject: owner, reason: 'scan-pending' };
      });
    if (owner === 'holders')
      owners.holders.mockImplementationOnce(async (_runtime, budget) => {
        hold(budget);
        return 'unchanged';
      });
    const locations = vi.spyOn(JobLocationIndex.prototype, 'compactTerminalRecords');
    if (owner === 'locations')
      locations.mockImplementationOnce(async (_after, budget) => {
        hold(budget);
        return 'unchanged';
      });
    if (owner === 'reconciliation' || owner === 'custody')
      owners[owner].mockImplementationOnce(async ({ budget }) => {
        hold(budget);
        return 'unchanged';
      });
    if (owner === 'scratch')
      owners.scratch.mockImplementationOnce(async (_signal, budget) => {
        hold(budget);
      });
    const progressing = owner === 'exports' ? 'progress' : 'exports';
    if (progressing === 'progress')
      owners.progress.mockImplementationOnce(async ({ budget }) => {
        budget.record({ kind: 'deleted', subject: 'progress', count: 1 });
        return 10;
      });
    else
      owners.exports.mockImplementationOnce(async (input) => {
        input!.budget.record({ kind: 'deleted', subject: 'export', count: 1 });
        return 'more';
      });
    const heldMock = owner === 'locations' ? locations : owners[owner];
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(heldMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(owners[progressing]).toHaveBeenCalledTimes(2);
    expect(heldMock).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)?.phase).toBe('partial');
    expect(statuses.at(-1)?.outcomes).toContainEqual({ kind: 'kept', subject: owner, reason: 'scan-pending' });
    expect(statuses.at(-1)?.deleted).toBe(0);
    await vi.advanceTimersByTimeAsync(86_099_999);
    expect(heldMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(heldMock).toHaveBeenCalledTimes(2);
    expect(owners[progressing]).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(owners[progressing]).toHaveBeenCalledTimes(3);
    expect(heldMock).toHaveBeenCalledTimes(2);
  },
);
it('holds a failed export to daily cadence while journal pruning progresses', async () => {
  owners.exports.mockRejectedValueOnce(new Error('export failure'));
  owners.progress.mockImplementationOnce(async ({ budget }) => {
    budget.record({ kind: 'deleted', subject: 'progress', count: 1 });
    return 10;
  });
  const { scheduler, statuses } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(owners.progress).toHaveBeenCalledTimes(2);
  expect(owners.exports).toHaveBeenCalledTimes(1);
  expect(statuses.at(-1)).toMatchObject({ phase: 'failed', failed: 1, deleted: 0 });
  expect(statuses.at(-1)?.outcomes).toContainEqual({ kind: 'failed', subject: 'exports', reason: 'export failure' });
  await vi.advanceTimersByTimeAsync(86_100_000);
  expect(owners.exports).toHaveBeenCalledTimes(2);
  expect(owners.progress).toHaveBeenCalledTimes(2);
  expect(statuses.at(-1)?.failed).toBe(0);
});

it('keeps a skipped owner deletion outcome visible without recounting its deletions', async () => {
  owners.progress.mockImplementationOnce(async ({ budget }) => {
    budget.record({ kind: 'deleted', subject: 'old-progress', count: 17 });
    return 0;
  });
  owners.exports.mockImplementationOnce(async (input) => {
    input!.budget.record({ kind: 'deleted', subject: 'export', count: 1 });
    return 'pending';
  });
  const { scheduler, statuses } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(owners.progress).toHaveBeenCalledOnce();
  expect(statuses.at(-1)?.outcomes).toContainEqual({ kind: 'deleted', subject: 'old-progress', count: 17 });
  expect(statuses.at(-1)).toMatchObject({ deleted: 0, deletedByOwner: { exports: 0, progressRows: 0 } });
});

it('retries only the owner that stopped for budget without progress', async () => {
  owners.exports.mockImplementationOnce(async (input) => {
    for (let operation = 0; operation < 20_000; operation++) if (!input!.budget.canContinue()) break;
    return 'pending';
  });
  const { scheduler } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(owners.exports).toHaveBeenCalledTimes(2);
  expect(owners.progress).toHaveBeenCalledOnce();
  expect(owners.scratch).toHaveBeenCalledOnce();
});

it('runs a held owner at its daily deadline while another owner keeps draining', async () => {
  owners.exports.mockImplementation(async (input) => {
    input!.budget.record({ kind: 'deleted', subject: 'export', count: 1 });
    return 'pending';
  });
  owners.progress.mockImplementationOnce(async ({ budget }) => {
    budget.record({ kind: 'kept', subject: 'held-progress', reason: 'scan-pending' });
    return 1;
  });
  const { scheduler, statuses } = fixture();
  try {
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(86_399_999);
    expect(owners.progress).toHaveBeenCalledOnce();
    expect(owners.exports).toHaveBeenCalledTimes(288);
    expect(statuses.at(-1)?.outcomes).toContainEqual({
      kind: 'kept',
      subject: 'held-progress',
      reason: 'scan-pending',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(owners.progress).toHaveBeenCalledTimes(2);
    expect(owners.exports).toHaveBeenCalledTimes(289);
  } finally {
    owners.exports.mockResolvedValue('');
  }
});

it('backs off a parked writer instead of polling and logging every second', async () => {
  owners.parked = true;
  const { scheduler, statuses } = fixture();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  const completed = statuses.length;
  await vi.advanceTimersByTimeAsync(299_999);
  expect(statuses).toHaveLength(completed);
  await vi.advanceTimersByTimeAsync(1);
  expect(statuses.length).toBeGreaterThan(completed);
});

it('rebinds repair hints when lifecycle recovery starts with a replacement progress store', async () => {
  const first = createRetentionFixture();
  const second = createRetentionFixture();
  fixtures.push(second);
  let selected = first.store;
  const { scheduler } = fixture(first, () => selected);
  const oldOwner = first.store.getResultExportOwner();
  const newOwner = second.store.getResultExportOwner();
  const detach = vi.spyOn(oldOwner, 'onRepairHint');
  const repair = vi.spyOn(newOwner, 'repairPass').mockResolvedValue();
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  selected = second.store;
  scheduler.start();
  newOwner.hintRepair('replacement-job');
  await vi.advanceTimersByTimeAsync(1000);
  expect(detach).toHaveBeenLastCalledWith(null);
  expect(repair).toHaveBeenCalledOnce();
  await scheduler.stop();
  expect(detach).toHaveBeenLastCalledWith(null);
});

it('a new read hint expedites repair while the failed owner already has fastDue', async () => {
  const { f, scheduler } = fixture();
  const owner = f.store.getResultExportOwner();
  const repair = vi.spyOn(owner, 'repairPass').mockImplementation(async (_ids, budget) => {
    budget.record({ kind: 'failed', subject: 'failed-job', reason: 'ENOSPC' });
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(repair).toHaveBeenCalledTimes(1);
  owner.hintRepair('newly-read-job');
  await vi.advanceTimersByTimeAsync(1000);
  expect(repair).toHaveBeenCalledTimes(2);
  expect(owners.exports).toHaveBeenCalledTimes(1);
});

it('re-arms repair when a new hint arrives during an outstanding pass', async () => {
  const { f, scheduler } = fixture();
  const owner = f.store.getResultExportOwner();
  const passes: string[][] = [];
  let release: () => void = () => {};
  const hints = (owner as unknown as { hints: Set<string> }).hints;
  vi.spyOn(owner, 'repairPass').mockImplementation(async () => {
    const snapshot = [...hints];
    passes.push(snapshot);
    for (const id of snapshot) hints.delete(id);
    if (snapshot.includes('job-a'))
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  owner.hintRepair('job-a');
  await vi.advanceTimersByTimeAsync(1500);
  owner.hintRepair('job-b');
  release();
  await vi.advanceTimersByTimeAsync(2000);
  expect(passes.some((pass) => pass.includes('job-b'))).toBe(true);
});
