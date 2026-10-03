import { afterEach, expect, it, vi } from 'vitest';

import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRetentionFixture } from '#tests/helpers/storage-retention.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

it.each(['deadline', 'stop', 'on-time'] as const)(
  'handles a %s filesystem completion without late retention mutation',
  async (completion) => {
    vi.useFakeTimers();
    const fixture = createRetentionFixture();
    fixtures.push(fixture);
    let monotonic = 0n;
    fixture.runtime.time.monotonicNow = () => monotonic;

    const root = fixture.runtime.paths.coral.exports.jobsRoot;
    fixture.runtime.storage.mkdirSync(root, { recursive: true });
    let releaseRead!: () => void;
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readdir = fixture.runtime.storage.readdir.bind(fixture.runtime.storage);
    let readStarted = false;
    let readReleased = false;
    fixture.runtime.storage.readdir = async (path) => {
      if (path === root) {
        readStarted = true;
        await blockedRead;
        readReleased = true;
      }
      return readdir(path);
    };

    const statuses: string[] = [];
    const scheduler = createStorageRetentionScheduler({
      runtime: fixture.runtime,
      getProgressStore: () => fixture.store,
      openEpoch: () => ({
        storeRoot: fixture.runtime.paths.coral.store.dbDir,
        epoch: '1',
        path: '/tmp/red-retention/epoch-1/store.db',
      }),
      activeEpochKey: () => 'active',
      jobLocations: new JobLocationIndex(fixture.runtime, fixture.runtime.paths.coral.generation.dataRoot),
      log: () => undefined,
      publish: (status) => statuses.push(status.phase),
      cleanupScratch: () => undefined,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(readStarted).toBe(true));

    if (completion === 'deadline') {
      monotonic = 30_000n;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(statuses.at(-1)).toBe('partial'));
    }
    if (completion !== 'on-time') await scheduler.stop();

    fixture.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run('storage-retention.exports.eligibility.v1', 'written-after-owner-finished');

    releaseRead();
    await vi.waitFor(() => expect(readReleased).toBe(true));
    for (let iteration = 0; iteration < 20; iteration += 1) await Promise.resolve();

    expect(
      fixture.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.eligibility.v1'),
    ).toEqual(completion === 'on-time' ? undefined : { value: 'written-after-owner-finished' });
    await scheduler.stop();
  },
);
