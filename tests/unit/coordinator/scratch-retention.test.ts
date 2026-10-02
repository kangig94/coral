import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createRetentionFixture, RETENTION_NOW } from '#tests/helpers/storage-retention.js';
import { cleanupStaleJobs } from '#src/coordinator/lifecycle.js';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import type { RetentionRunStatus } from '#src/store/retention-outcome.js';
import type { TimerHandle } from '#src/infra/port-types.js';

vi.mock('#src/infra/backend-log.js', () => ({ backendLog: { warn: vi.fn() } }));

vi.mock('#src/store/active-store-selection.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readActiveStoreSelectionForCoordination: () => ({ kind: 'valid' }),
}));

function fixture() {
  const f = createRetentionFixture();
  f.runtime.env.tmpdir = () => f.baseDir;
  return f;
}

function expiredJobs(f: ReturnType<typeof createRetentionFixture>, ids: string[]) {
  f.setNow(1);
  for (const id of ids) {
    initTestJob(f.store, {
      jobId: id,
      sessionId: `session-${id}`,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test-ns',
    });
    commitJobTerminal(f.store, id, `session-${id}`, {
      content: 'result',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    mkdirSync(f.store.jobDir(id), { recursive: true });
    writeFileSync(join(f.store.jobDir(id), 'result.md'), 'result');
  }
  f.setNow(RETENTION_NOW);
}

function runner(f: ReturnType<typeof createRetentionFixture>) {
  let scheduled: () => void;
  let finished: (status: RetentionRunStatus) => void;
  let nextRunAt = 0n;
  let mono = 0n;
  const runtime = {
    ...f.runtime,
    time: {
      ...f.runtime.time,
      monotonicNow: () => mono,
      setTimeout: (cb: () => void, ms: number) => {
        if (ms !== 5000) {
          scheduled = cb;
          nextRunAt = mono + BigInt(ms);
        }
        return { unref() {} } as TimerHandle;
      },
      clearTimeout: () => {},
    },
  };
  const scheduler = createStorageRetentionScheduler({
    runtime,
    getProgressStore: () => f.store,
    openEpoch: () => ({
      storeRoot: runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: join(runtime.paths.coral.store.dbDir, 'epoch-1/store.db'),
    }),
    activeEpochKey: () => null,
    jobLocations: new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot),
    log: () => {},
    cleanupScratch: (signal, budget) =>
      cleanupStaleJobs(
        f.store,
        'test-bundle',
        () => {},
        runtime.storage,
        runtime.time.now(),
        14 * 86_400_000,
        signal,
        budget,
      ),
    publish: (status) => {
      if (status.finishedAt !== null) finished(structuredClone(status));
    },
  });
  return {
    run: async () => {
      scheduler.start();
      f.setNow(runtime.time.now() + Number(nextRunAt - mono));
      mono = nextRunAt;
      const result = new Promise<RetentionRunStatus>((resolve) => {
        finished = resolve;
      });
      scheduled!();
      const status = await result;
      await setImmediate();
      return status;
    },
    advance: (ms: number) => {
      mono += BigInt(ms);
      f.setNow(runtime.time.now() + ms);
    },
    stop: scheduler.stop,
  };
}

it('retries failed scratch subjects before the saved cursor on every daily cycle', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const ids = ['skip-a', 'skip-b', 'skip-c'];
  expiredJobs(f, ids);
  const s = runner(f);
  const rm = f.runtime.storage.rmSync;
  const calls: string[] = [];
  let failing = true;
  f.runtime.storage.rmSync = (path, options) => {
    const id = ids.find((id) => f.store.jobDir(id) === String(path))!;
    calls.push(id);
    if (id === ids[0] && failing) {
      s.advance(1000);
      throw Object.assign(new Error('persistent scratch EACCES'), { code: 'EACCES' });
    }
    if (id === ids[1]) s.advance(4000);
    return rm(path, options);
  };
  try {
    expect(await s.run()).toMatchObject({ phase: 'partial', failed: 1 });
    expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.scratch.v1')).toEqual({
      value: ids[1],
    });
    const second = await s.run();
    expect(second.phase).toBe('partial');
    expect(second.outcomes).toContainEqual(
      expect.objectContaining({
        kind: 'kept',
        subject: ids[0],
        reason: expect.stringContaining('scratch-cleanup-pending'),
      }),
    );
    expect(calls).toEqual([ids[0], ids[1], ids[0], ids[2]]);
    failing = false;
    const third = await s.run();
    expect(third.phase).toBe('completed');
    expect(existsSync(f.store.jobDir(ids[0]))).toBe(false);
    expect(third.deleted).toBe(1);
  } finally {
    f.runtime.storage.rmSync = rm;
    await s.stop();
    f.close();
  }
});

it('counts actual scratch removals and distinguishes already absent artifacts', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const ids = ['count-a', 'count-b'];
  expiredJobs(f, ids);
  const s = runner(f);
  try {
    const first = await s.run();
    expect(first).toMatchObject({ phase: 'completed', deleted: 2 });
    for (const id of ids)
      expect(first.outcomes).toContainEqual({ kind: 'deleted', subject: f.store.jobDir(id), count: 1 });
    const second = await s.run();
    expect(second).toMatchObject({ phase: 'completed', deleted: 0 });
    for (const id of ids)
      expect(second.outcomes).toContainEqual({
        kind: 'kept',
        subject: f.store.jobDir(id),
        reason: 'scratch-already-absent',
        pending: false,
      });
  } finally {
    await s.stop();
    f.close();
  }
});

it('bounds pending scratch failures and retains the cursor at overflow until failures clear', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const ids = Array.from({ length: 101 }, (_, i) => `overflow-${String(i).padStart(3, '0')}`);
  expiredJobs(f, ids);
  const s = runner(f);
  const rm = f.runtime.storage.rmSync;
  f.runtime.storage.rmSync = () => {
    throw new Error('scratch EACCES');
  };
  try {
    const first = await s.run();
    expect(first.phase).toBe('partial');
    expect(first.outcomes).toContainEqual(expect.objectContaining({ reason: 'scratch-pending-overflow' }));
    const saved = f.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('storage-retention.scratch.pending.v1');
    expect(JSON.parse(saved!.value).subjects).toHaveLength(100);
    expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.scratch.v1')).toEqual({
      value: ids[99],
    });
    f.runtime.storage.rmSync = rm;
    const second = await s.run();
    expect(second).toMatchObject({ phase: 'completed', deleted: 101 });
    expect(ids.some((id) => existsSync(f.store.jobDir(id)))).toBe(false);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.scratch.pending.v1'),
    ).toBeUndefined();
  } finally {
    f.runtime.storage.rmSync = rm;
    await s.stop();
    f.close();
  }
});
