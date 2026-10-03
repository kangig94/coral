import { afterEach, expect, it, vi } from 'vitest';

import {
  retentionRunStatusSchema,
  type RetentionRunBudget,
  type RetentionRunStatus,
} from '#src/store/retention-outcome.js';

const owners = vi.hoisted(() => ({
  progress: vi.fn(async ({ budget }: { budget: RetentionRunBudget }) => {
    for (let index = 0; index < 100; index += 1)
      budget.record({ kind: 'kept', subject: `pending-${index}`, reason: `pending-reason-${index}` });
    return 0;
  }),
}));

vi.mock('#src/jobs/export-retention.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneJobExports: async () => '',
}));
vi.mock('#src/jobs/progress-retention.js', () => ({ pruneJobProgress: owners.progress }));
vi.mock('#src/store/retention-vacuum.js', () => ({
  vacuumRetainedJournal: async () => ({ kind: 'kept', subject: 'journal-vacuum', reason: 'pending-vacuum' }),
}));

vi.mock('#src/store/succession-writer-generation.js', () => ({
  joinSuccessionWriterGeneration: () => ({
    assertCurrent: () => {},
    withWriteTurn: <T>(operation: () => T) => operation(),
  }),
}));
vi.mock('#src/store/epoch/holder.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  pruneStoreEpochHolders: async () => {},
}));

import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

it.each([true, false])('reports owner failures after holds fill the report (failure=%s)', async (fails) => {
  vi.useFakeTimers();
  owners.progress.mockImplementation(async ({ budget }) => {
    for (let index = 0; index < 100; index++)
      budget.record({ kind: 'kept', subject: `pending-${index}`, reason: `pending-reason-${index}` });
    return 0;
  });
  const fixture = createRetentionFixture();
  fixtures.push(fixture);
  const statuses: RetentionRunStatus[] = [];
  const scheduler = createStorageRetentionScheduler({
    runtime: fixture.runtime,
    getProgressStore: () => fixture.store,
    openEpoch: () => ({ storeRoot: fixture.runtime.paths.coral.store.dbDir, epoch: '1', path: '/tmp/red/store.db' }),
    activeEpochKey: () => 'active',
    jobLocations: new JobLocationIndex(fixture.runtime, fixture.runtime.paths.coral.generation.dataRoot),
    log: () => undefined,
    publish: (status) => statuses.push({ ...status, outcomes: [...status.outcomes] }),
    cleanupScratch: () => {
      if (fails) throw new Error('scratch purge failed');
    },
  });

  scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  await scheduler.stop();

  expect(retentionRunStatusSchema.safeParse(statuses.at(-1)).success).toBe(true);
  expect(statuses.at(-1)?.failed).toBe(fails ? 1 : 0);
  expect(statuses.at(-1)?.kept).toBeGreaterThanOrEqual(100);
  for (const kind of ['deleted', 'kept', 'failed'])
    expect(statuses.at(-1)?.outcomes.filter((outcome) => outcome.kind === kind).length).toBeLessThanOrEqual(100);
  if (!fails) return;
  expect(statuses.at(-1)?.outcomes).toContainEqual({
    kind: 'failed',
    subject: 'scratch-jobs',
    reason: 'scratch purge failed',
  });
});
