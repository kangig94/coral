import { expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
  const rm = f.runtime.storage.rmdirSync;
  const calls: string[] = [];
  let failing = true;
  f.runtime.storage.rmdirSync = (path) => {
    const id = ids.find((id) => f.store.jobDir(id) === String(path))!;
    calls.push(id);
    if (id === ids[0] && failing) {
      s.advance(1000);
      throw Object.assign(new Error('persistent scratch EACCES'), { code: 'EACCES' });
    }
    if (id === ids[1] && existsSync(path)) s.advance(4000);
    return rm(path);
  };
  try {
    expect(await s.run()).toMatchObject({ phase: 'partial', failed: 1 });
    expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.scratch.v1')).toEqual({
      value: ids[0],
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
    f.runtime.storage.rmdirSync = rm;
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
  const rm = f.runtime.storage.rmdirSync;
  f.runtime.storage.rmdirSync = () => {
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
    f.runtime.storage.rmdirSync = rm;
    const second = await s.run();
    expect(second).toMatchObject({ phase: 'completed', deleted: 101 });
    expect(ids.some((id) => existsSync(f.store.jobDir(id)))).toBe(false);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.scratch.pending.v1'),
    ).toBeUndefined();
  } finally {
    f.runtime.storage.rmdirSync = rm;
    await s.stop();
    f.close();
  }
});

it.each([5, 10])('rotates %i slow scratch failures while discovering unrelated expired artifacts', async (count) => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const bad = Array.from({ length: count }, (_, i) => `fairness-a-${i}`);
  const good = 'fairness-z-good';
  expiredJobs(f, [...bad, good]);
  f.db
    .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
    .run('storage-retention.scratch.pending.v1', JSON.stringify({ subjects: bad, overflow: false }));
  const s = runner(f);
  const rm = f.runtime.storage.rmdirSync;
  const calls: string[] = [];
  f.runtime.storage.rmdirSync = (path) => {
    const id = [...bad, good].find((id) => f.store.jobDir(id) === String(path))!;
    calls.push(id);
    if (bad.includes(id)) {
      s.advance(1000);
      throw new Error('persistent EACCES');
    }
    return rm(path);
  };
  try {
    for (let cycle = 0; cycle < Math.ceil(count / 3); cycle += 1) {
      const start = calls.length;
      const status = await s.run();
      expect(status.phase).toBe('partial');
      expect(calls.slice(start).filter((id) => bad.includes(id)).length).toBeLessThanOrEqual(3);
      expect(existsSync(f.store.jobDir(good))).toBe(false);
    }
    expect(bad.every((id) => calls.includes(id))).toBe(true);
    f.runtime.storage.rmdirSync = rm;
    expect(await s.run()).toMatchObject({ phase: 'completed', deleted: count });
  } finally {
    f.runtime.storage.rmdirSync = rm;
    await s.stop();
    f.close();
  }
});

it('keeps export failures visible beyond the main cursor and retries until cleared', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const ids = ['export-a', 'export-b', 'export-c'];
  expiredJobs(f, ids);
  for (const id of ids) {
    const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old result');
    utimesSync(join(path, 'result.md'), 1, 1);
  }
  const s = runner(f);
  const unlink = f.runtime.storage.unlinkSync;
  let failing = true;
  f.runtime.storage.unlinkSync = (path) => {
    if (String(path).includes(`/.retiring-${ids[0]}-`) && failing) {
      s.advance(1000);
      throw new Error('persistent export EACCES');
    }
    if (String(path).includes(`/.retiring-${ids[1]}-`)) s.advance(4000);
    return unlink(path);
  };
  try {
    expect((await s.run()).phase).toBe('partial');
    const second = await s.run();
    expect(second.phase).toBe('partial');
    expect(second.outcomes).toContainEqual(
      expect.objectContaining({
        reason: 'export-cleanup-pending',
        subject: expect.stringMatching(/^\.retiring-export-a-/),
      }),
    );
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, ids[2]))).toBe(false);
    failing = false;
    const final = await s.run();
    expect(final.phase).toBe('completed');
    expect(ids.some((id) => existsSync(join(f.runtime.paths.coral.exports.jobsRoot, id)))).toBe(false);
  } finally {
    f.runtime.storage.unlinkSync = unlink;
    await s.stop();
    f.close();
  }
});

it('rotates slow export failures while the main scan reaches unrelated exports', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const bad = Array.from({ length: 10 }, (_, i) => `export-fairness-${i}`);
  const good = 'z-export-good';
  expiredJobs(f, [...bad, good]);
  for (const id of [...bad, good]) {
    const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old result');
    utimesSync(join(path, 'result.md'), 1, 1);
  }
  f.db
    .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
    .run('storage-retention.exports.pending.v1', JSON.stringify({ subjects: bad, overflow: false }));
  const s = runner(f);
  const unlink = f.runtime.storage.unlinkSync;
  const calls: string[] = [];
  f.runtime.storage.unlinkSync = (path) => {
    const id = [...bad, good].find((id) => String(path).includes(`/.retiring-${id}-`));
    if (id) calls.push(id);
    if (id && bad.includes(id)) {
      s.advance(1000);
      throw new Error('persistent export EACCES');
    }
    return unlink(path);
  };
  try {
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const start = calls.length;
      const status = await s.run();
      expect(status.phase).toBe('partial');
      expect(calls.slice(start).filter((id) => bad.includes(id)).length).toBeLessThanOrEqual(3);
      expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, good))).toBe(false);
    }
    expect(bad.every((id) => calls.includes(id))).toBe(true);
    f.runtime.storage.unlinkSync = unlink;
    expect((await s.run()).phase).toBe('completed');
  } finally {
    f.runtime.storage.unlinkSync = unlink;
    await s.stop();
    f.close();
  }
});

it('reports export pending overflow even when failure details fill the status limit', async () => {
  const f = fixture();
  openSettledTestStoreDb(f.runtime).close();
  const ids = Array.from({ length: 101 }, (_, i) => `export-overflow-${String(i).padStart(3, '0')}`);
  expiredJobs(f, ids);
  for (const id of ids) {
    const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old result');
    utimesSync(join(path, 'result.md'), 1, 1);
  }
  const s = runner(f);
  const unlink = f.runtime.storage.unlinkSync;
  f.runtime.storage.unlinkSync = (path) => {
    throw new Error(`EACCES: ${String(path)}`);
  };
  try {
    const status = await s.run();
    expect(status.phase).toBe('partial');
    expect(status.outcomes.filter((outcome) => outcome.kind === 'failed')).toHaveLength(100);
    expect(status.outcomes).toContainEqual(expect.objectContaining({ reason: 'export-pending-overflow' }));
    f.runtime.storage.unlinkSync = unlink;
    expect((await s.run()).phase).toBe('completed');
  } finally {
    f.runtime.storage.unlinkSync = unlink;
    await s.stop();
    f.close();
  }
});

it('refuses a durable scratch job ID that escapes its root', async () => {
  const f = fixture();
  try {
    expiredJobs(f, ['safe-job']);
    const outside = join(f.store.jobDir('safe-job'), '..', '..', 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
    f.db.prepare('UPDATE projection_jobs SET job_id = ? WHERE job_id = ?').run('../outside', 'safe-job');
    f.db.prepare('UPDATE events SET stream_id = ? WHERE stream_id = ?').run('../outside', 'safe-job');
    f.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run(
        'storage-retention.scratch.pending.v1',
        JSON.stringify({ subjects: ['../outside'], overflow: false, rotation: 0 }),
      );
    await cleanupStaleJobs(
      f.store,
      'test-bundle',
      () => {},
      f.runtime.storage,
      RETENTION_NOW,
      14 * 86_400_000,
      new AbortController().signal,
      f.budget,
    );
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ subject: '../outside', reason: 'retention-subject-invalid' }),
    );
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining('hydration-quarantine') }),
    );
  } finally {
    f.close();
  }
});

it('keeps scratch evidence when a directory becomes a symlink during enumeration', async () => {
  const f = fixture();
  try {
    expiredJobs(f, ['safe-job']);
    const path = f.store.jobDir('safe-job');
    const nested = join(path, 'nested');
    const outside = join(f.baseDir, 'outside');
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
    const read = f.runtime.storage.readdirSync;
    let replaced = false;
    f.runtime.storage.readdirSync = ((directory: string) => {
      if (directory === nested && !replaced) {
        replaced = true;
        renameSync(nested, join(f.baseDir, 'saved-nested'));
        symlinkSync(outside, nested);
      }
      return read(directory);
    }) as typeof read;
    await cleanupStaleJobs(
      f.store,
      'test-bundle',
      () => {},
      f.runtime.storage,
      RETENTION_NOW,
      14 * 86_400_000,
      new AbortController().signal,
      f.budget,
    );
    expect(replaced).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(lstatSync(nested).isSymbolicLink()).toBe(true);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', reason: expect.stringContaining('identity changed') }),
    );
  } finally {
    f.close();
  }
});

it('does not treat a disappearing descendant as proof that the scratch root is absent', async () => {
  const f = fixture();
  try {
    expiredJobs(f, ['safe-job']);
    const path = f.store.jobDir('safe-job');
    const nested = join(path, 'nested');
    mkdirSync(nested);
    const read = f.runtime.storage.readdirSync;
    let moved = false;
    f.runtime.storage.readdirSync = ((directory: string) => {
      if (directory === nested && !moved) {
        moved = true;
        renameSync(nested, join(f.baseDir, 'saved-nested'));
      }
      return read(directory);
    }) as typeof read;
    await cleanupStaleJobs(
      f.store,
      'test-bundle',
      () => {},
      f.runtime.storage,
      RETENTION_NOW,
      14 * 86_400_000,
      new AbortController().signal,
      f.budget,
    );
    expect(moved).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'failed' }));
    expect(f.outcomes).not.toContainEqual(expect.objectContaining({ reason: 'scratch-already-absent' }));
  } finally {
    f.close();
  }
});
