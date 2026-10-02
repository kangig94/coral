import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { pruneJobExports, readExportJobState } from '#src/jobs/export-retention.js';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { createRetentionFixture, RETENTION_NOW, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import type { RetentionRunStatus } from '#src/store/retention-outcome.js';

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
function scheduler(f: ReturnType<typeof fixture>) {
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
    cleanupScratch: () => {},
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

describe('retention round-two probes', () => {
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

  it('releases unrelated old residue after ordinary location registration', async () => {
    const f = fixture();
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    locations.register('current', 'active', { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'residue');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old');
    for (const p of [path, join(path, 'result.md')]) utimesSync(p, 1, 1);
    const s = scheduler(f);
    try {
      await s.run();
      expect(existsSync(path)).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it.each(['nested', 'top-level'])(
    'finishes eligibility for a residue with a large descendant tree and removes it across retries (%s)',
    async (layout) => {
      const f = fixture();
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'large');
      const descendants = layout === 'nested' ? join(path, 'provider-artifacts') : path;
      mkdirSync(descendants, { recursive: true });
      writeFileSync(join(descendants, 'evidence'), 'old');
      for (const p of [path, descendants, join(descendants, 'evidence')]) utimesSync(p, 1, 1);
      const iterate = f.runtime.storage.iterateDirectory;
      let remaining = 20_001;
      let visited = 0;
      const stat = f.runtime.storage.lstatSync;
      const unlink = f.runtime.storage.unlinkSync;
      f.runtime.storage.iterateDirectory = async function* (p) {
        if (p === descendants) {
          for (let i = 0; i < remaining; i += 1) yield `virtual-${i}`;
          yield 'evidence';
        } else yield* iterate(p);
      };
      vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation((...args) => {
        if (String(args[0]).startsWith(descendants + '/virtual-')) {
          visited += 1;
          return stat(join(descendants, 'evidence'), args[1]);
        }
        return stat(...args);
      });
      const remove = vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation((p) => {
        if (String(p).startsWith(descendants + '/virtual-')) return;
        unlink(p);
      });
      let cycles = 0;
      while (remaining > 0) {
        let operations = 0;
        const countVirtual = () => remove.mock.calls.filter(([p]) => String(p).includes('/virtual-')).length;
        const before = countVirtual();
        await pruneJobExports({
          runtime: f.runtime,
          cutoff: RETENTION_CUTOFF,
          afterId: '',
          budget: { record: () => {}, canContinue: () => ++operations <= 20_000 },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        remaining -= countVirtual() - before;
        expect(++cycles).toBeLessThan(10);
      }
      expect(visited).toBeGreaterThan(20_001);
      expect(existsSync(path)).toBe(false);
    },
  );

  it('restores SQLite settings before yielding and bounds each deletion batch even after a stalled commit', async () => {
    const f = fixture();
    f.setNow(1);
    launch(f, 'many');
    for (let i = 0; i < 130; i += 1) f.store.appendProgress('many', 'session-many', 'message');
    finish(f, 'many');
    const exec = f.db.exec.bind(f.db);
    let aborted = false;
    let deletes = 0;
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('DELETE FROM events')) {
        deletes += 1;
        expect(sql.match(/\?/gu)?.length).toBeLessThanOrEqual(64);
      }
      return prepare(sql);
    });
    vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && !aborted) {
        expect(f.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 25 });
        expect(f.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 1000 });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
        aborted = true;
      }
      exec(sql);
    });
    expect(
      await pruneJobProgress({
        db: f.db,
        readCtx: f.store,
        cutoff: RETENTION_CUTOFF,
        afterSeq: 0,
        budget: { record: () => {}, canContinue: () => !aborted },
      }),
    ).toBeGreaterThan(0);
    expect(deletes).toBe(1);
    expect(f.db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    expect(f.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 1000 });
  });
});
