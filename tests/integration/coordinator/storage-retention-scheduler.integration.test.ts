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

const DAY = 86_400_000;
const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
  selection.kind = 'valid';
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

const selection = vi.hoisted(() => ({ kind: 'valid' }));
vi.mock('#src/store/active-store-selection.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readActiveStoreSelectionForCoordination: () => ({ kind: selection.kind }),
}));

describe('storage retention scheduler owner composition', () => {
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

  it.each(['selection', 'epoch', 'terminal'])(
    'reports unknown %s evidence as partial and keeps the data',
    async (evidence) => {
      const f = fixture();
      f.setNow(1);
      const seq = launch(f, 'held');
      const path = finish(f, 'held');
      const legacy = join(f.runtime.paths.coral.store.dbDir, 'store.db');
      writeFileSync(legacy, 'old legacy data');
      utimesSync(legacy, 1, 1);
      if (evidence === 'selection') selection.kind = 'rejected';
      if (evidence === 'epoch')
        f.runtime.storage.unlinkSync(join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'epoch.json'));
      if (evidence === 'terminal')
        f.db.prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'").run(Buffer.from('{}'));
      f.setNow(RETENTION_NOW);
      const s = scheduler(f);
      try {
        const status = await s.run();
        expect(status.phase).toBe('partial');
        if (evidence === 'terminal') {
          expect(existsSync(path)).toBe(true);
          expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
          expect(status.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', reason: 'unknown' }));
          expect(status.outcomes).toContainEqual(expect.objectContaining({ kind: 'kept', subject: 'progress:held' }));
        } else {
          expect(existsSync(legacy)).toBe(true);
          expect(status.outcomes).toContainEqual(
            expect.objectContaining({
              kind: 'kept',
              reason: evidence === 'epoch' ? 'current-epoch-unproven' : 'active-selection-unknown-or-legacy',
            }),
          );
        }
      } finally {
        await s.stop();
      }
    },
  );
});
