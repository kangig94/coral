import { expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';

it.each(['shutdown', 'park', 'crash'] as const)(
  'resumes the ceiling and within-job checkpoint after %s',
  async (interruption) => {
    const f = createRetentionFixture(true);
    let resumed: ReturnType<typeof newRawDatabase> | undefined;
    let closed = false;
    try {
      f.setNow(1);
      initTestJob(f.store, {
        jobId: 'large',
        sessionId: 'session-large',
        provider: 'codex',
        projectRoot: '/workspace',
        backendNamespace: 'test-ns',
      });
      f.store.appendProgress('large', 'session-large', 'progress');
      for (let i = 0; i < 130; i += 1) f.store.appendProgress('large', 'session-large', 'message');
      const ceiling = commitJobTerminal(f.store, 'large', 'session-large', {
        content: 'done',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const exec = f.db.exec.bind(f.db);
      let stopped = false;
      vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
        exec(sql);
        if (sql === 'COMMIT') stopped = true;
      });
      await pruneJobProgress({
        db: f.db,
        readCtx: f.store,
        cutoff: RETENTION_CUTOFF,
        afterSeq: 0,
        budget: {
          record: () => {},
          canContinue: () => !stopped,
          canMutate: () => interruption === 'shutdown' || !stopped,
        },
      });
      const saved = f.db.prepare("SELECT value FROM meta WHERE key = 'storage-retention.progress.v1'").get() as {
        value: string;
      };
      expect(JSON.parse(saved.value)).toMatchObject({ afterSeq: 0, ceiling });
      expect(JSON.parse(saved.value).progressSeq).toBeGreaterThan(0);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
        n: 67,
      });
      f.db.close();
      closed = true;
      resumed = newRawDatabase(join(f.baseDir, 'store.db'));
      expect(resumed.prepare("SELECT value FROM meta WHERE key = 'storage-retention.progress.v1'").get()).toEqual(
        saved,
      );
      await pruneJobProgress({
        db: resumed,
        readCtx: f.store,
        cutoff: RETENTION_CUTOFF,
        afterSeq: 0,
        budget: f.budget,
      });
      expect(resumed.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
        n: 0,
      });
    } finally {
      vi.restoreAllMocks();
      resumed?.close();
      if (!closed) f.db.close();
      rmSync(f.baseDir, { recursive: true, force: true });
    }
  },
);
