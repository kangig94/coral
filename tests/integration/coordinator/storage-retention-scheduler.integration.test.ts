import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { readExportJobState } from '#src/jobs/export-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { createRetentionFixture, RETENTION_NOW } from '#tests/helpers/storage-retention.js';
import type { RetentionRunStatus } from '#src/store/retention-outcome.js';
import { cleanupStaleJobs } from '#src/coordinator/lifecycle.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';

const DAY = 86_400_000;
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  openSettledTestStoreDb(f.runtime).close();
  return f;
}
function launch(f: ReturnType<typeof fixture>, id: string) {
  initTestJob(f.store, {
    jobId: id,
    sessionId: `session-${id}`,
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test-ns',
  });
  return f.store.appendProgress(id, `session-${id}`, 'evidence');
}
function finish(f: ReturnType<typeof fixture>, id: string) {
  commitJobTerminal(f.store, id, `session-${id}`, { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
  const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'result.md'), 'result');
  return path;
}
function scheduler(
  f: ReturnType<typeof fixture>,
  cleanupScratch: (signal: AbortSignal) => void | Promise<void> = () => {},
) {
  let monotonic = 0n;
  let scheduled: (() => void) | undefined;
  let finished: ((status: RetentionRunStatus) => void) | undefined;
  const runtime = {
    ...f.runtime,
    time: {
      ...f.runtime.time,
      monotonicNow: () => monotonic,
      setTimeout: (callback: () => void, ms: number) => {
        if (ms === 0 || ms === DAY) scheduled = callback;
        return { unref: () => {} } as ReturnType<typeof f.runtime.time.setTimeout>;
      },
      clearTimeout: () => {},
    },
  };
  const s = createStorageRetentionScheduler({
    runtime,
    getProgressStore: () => f.store,
    openEpoch: () => ({
      storeRoot: runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: join(runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
    }),
    activeEpochKey: () => 'active',
    jobLocations: new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot),
    log: () => {},
    cleanupScratch,
    publish: (status) => {
      if (status.finishedAt !== null) finished?.(status);
    },
  });
  s.start();
  return {
    stop: s.stop,
    run: async (elapsed = 0) => {
      monotonic = BigInt(elapsed);
      const status = new Promise<RetentionRunStatus>((resolve) => {
        finished = resolve;
      });
      scheduled?.();
      const result = await status;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return result;
    },
  };
}

describe('storage retention scheduler owner composition', () => {
  it('keeps scratch retry evidence when shutdown has already aborted cleanup', async () => {
    const f = fixture();
    const quarantine = new RecoveryQuarantineStore(f.db, f.runtime.time);
    quarantine.upsert({
      boundary: 'stale-job-cleanup',
      subject: { key: 'scratch-pending', revision: { kind: 'until-cleared' } },
      stage: 'settle',
      state: 'active',
      errorMessage: 'scratch deletion denied',
      detail: 'stale job artifact cleanup failed',
    });
    const abort = new AbortController();
    abort.abort();
    await expect(
      cleanupStaleJobs(f.store, 'test-bundle', () => {}, f.runtime.storage, RETENTION_NOW, 14 * DAY, abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(quarantine.read('stale-job-cleanup', 'scratch-pending')).not.toBeNull();
  });

  it('leaves legacy SQLite writers and their family untouched without legacy status or cursors', async () => {
    const f = fixture();
    const root = f.runtime.paths.coral.store.dbDir;
    const legacy = join(root, 'store.db');
    const writer = newRawDatabase(legacy);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE old(v); INSERT INTO old VALUES('initial'); PRAGMA wal_checkpoint(TRUNCATE)",
    );
    for (const suffix of ['', '-wal', '-shm']) utimesSync(legacy + suffix, 1, 1);
    for (const suffix of ['.format', '.bak']) {
      writeFileSync(legacy + suffix, 'legacy sidecar');
      utimesSync(legacy + suffix, 1, 1);
    }
    const quarantine = join(root, '.legacy-retention-family', 'store.db');
    mkdirSync(join(root, '.legacy-retention-family'));
    writeFileSync(quarantine, 'interrupted legacy retirement');
    utimesSync(quarantine, 1, 1);
    f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('storage-retention.legacy.v1', 'store.db');
    const rename = vi.spyOn(f.runtime.storage, 'renameSync');
    const unlink = vi.spyOn(f.runtime.storage, 'unlinkSync');
    const s = scheduler(f);
    try {
      const status = await s.run();
      expect(rename.mock.calls.filter(([path]) => String(path).startsWith(legacy))).toEqual([]);
      expect(unlink.mock.calls.filter(([path]) => String(path).startsWith(legacy))).toEqual([]);
      for (const suffix of ['', '-wal', '-shm', '.format', '.bak']) expect(existsSync(legacy + suffix)).toBe(true);
      expect(existsSync(quarantine)).toBe(true);
      writer.exec("INSERT INTO old VALUES('after retention')");
      expect(writer.prepare('SELECT * FROM old').all()).toEqual([{ v: 'initial' }, { v: 'after retention' }]);
      expect(status.outcomes.some((outcome) => outcome.subject === legacy || outcome.subject === 'legacy-store')).toBe(
        false,
      );
      expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.legacy.v1')).toBeUndefined();
    } finally {
      await s.stop();
      writer.close();
    }
  });

  it.each([false, true])(
    'reports scratch deletion failure and retries next cycle (prior quarantine: %s)',
    async (quarantined) => {
      const f = fixture();
      f.setNow(1);
      launch(f, 'scratch-fail');
      finish(f, 'scratch-fail');
      const scratch = f.store.jobDir('scratch-fail');
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'result.md'), 'result');
      if (quarantined)
        new RecoveryQuarantineStore(f.db, f.runtime.time).upsert({
          boundary: 'stale-job-cleanup',
          subject: { key: 'scratch-fail', revision: { kind: 'until-cleared' } },
          stage: 'settle',
          state: 'active',
          errorMessage: 'previous scratch deletion denied',
          detail: 'stale job artifact cleanup failed',
        });
      const rm = f.runtime.storage.rmSync;
      let denied = true;
      let calls = 0;
      f.runtime.storage.rmSync = (path, options) => {
        if (String(path) === scratch) {
          calls += 1;
          if (denied) throw Object.assign(new Error('scratch deletion denied'), { code: 'EACCES' });
        }
        return rm(path, options);
      };
      f.setNow(RETENTION_NOW);
      const s = scheduler(f, (signal) =>
        cleanupStaleJobs(f.store, 'test-bundle', () => {}, f.runtime.storage, f.runtime.time.now(), 14 * DAY, signal),
      );
      try {
        const status = await s.run();
        expect(['failed', 'partial']).toContain(status.phase);
        expect(status.failed).toBeGreaterThan(0);
        expect(status.outcomes).toContainEqual(expect.objectContaining({ kind: 'failed', subject: 'scratch-jobs' }));
        expect(existsSync(scratch)).toBe(true);
        denied = false;
        f.setNow(RETENTION_NOW + DAY);
        const retry = await s.run(DAY);
        expect(calls).toBe(2);
        expect(existsSync(scratch)).toBe(false);
        expect(retry.failed).toBe(0);
      } finally {
        await s.stop();
      }
    },
  );

  it('keeps a terminal regression witnessed by any preceding event of that job between daily samples', async () => {
    const f = fixture();
    const seq = launch(f, 'regressed');
    const s = scheduler(f);
    try {
      await s.run();
      f.setNow(RETENTION_NOW - 30 * DAY);
      f.store.appendProgress('regressed', 'session-regressed', 'during correction');
      const path = finish(f, 'regressed');
      f.setNow(RETENTION_NOW + DAY);
      const status = await s.run(DAY);
      expect(existsSync(path)).toBe(true);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
      expect(readExportJobState(f.db, f.store, 'regressed')).toEqual({ kind: 'regression' });
      expect(status.phase).toBe('partial');
      expect(status.outcomes).toContainEqual({
        kind: 'kept',
        subject: 'progress:regressed',
        reason: 'terminal-clock-regression',
      });
    } finally {
      await s.stop();
    }
  });

  it('expires an idle old terminal on the first short boot and does not reset age on restart', async () => {
    const f = fixture();
    f.setNow(RETENTION_NOW - 30 * DAY);
    const seq = launch(f, 'idle');
    const path = finish(f, 'idle');
    for (let boot = 0; boot < 3; boot += 1) {
      f.setNow(RETENTION_NOW + boot * DAY);
      const s = scheduler(f);
      try {
        await s.run();
        expect(existsSync(path)).toBe(false);
        expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeUndefined();
      } finally {
        await s.stop();
      }
    }
  });

  it('documents the accepted unwitnessed clock risk with a negative control', async () => {
    const f = fixture();
    f.setNow(RETENTION_NOW - 30 * DAY);
    const seq = launch(f, 'unwitnessed');
    const path = finish(f, 'unwitnessed');
    f.setNow(RETENTION_NOW);
    const s = scheduler(f);
    try {
      await s.run();
      expect(existsSync(path)).toBe(false);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeUndefined();
    } finally {
      await s.stop();
    }
  });

  it('reports unknown terminal evidence as partial and keeps the data', async () => {
    const f = fixture();
    f.setNow(1);
    const seq = launch(f, 'held');
    const path = finish(f, 'held');
    f.db.prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'").run(Buffer.from('{}'));
    f.setNow(RETENTION_NOW);
    const s = scheduler(f);
    try {
      const status = await s.run();
      expect(status.phase).toBe('partial');
      expect(existsSync(path)).toBe(true);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
      expect(status.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', reason: 'unknown' }));
      expect(status.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: 'progress:held' }));
    } finally {
      await s.stop();
    }
  });
});
