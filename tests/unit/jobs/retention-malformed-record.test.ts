import { readRetentionCursor } from '#src/store/retention-meta.js';
import { backendLog } from '#src/infra/backend-log.js';
import { createRetentionPendingSet } from '#src/store/retention-outcome.js';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { pruneJobExports } from '#src/jobs/export-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture() {
  const value = createRetentionFixture();
  fixtures.push(value);
  return value;
}

describe('red retention malformed durable records', () => {
  it.each(['{', 'null', '[]', '{"afterSeq":-1,"progressSeq":0}', '{"afterSeq":0,"progressSeq":1e100}'])(
    'restarts a malformed progress cursor: %s',
    async (value) => {
      const f = fixture();
      f.setNow(1);
      initTestJob(f.store, {
        jobId: 'expired-job',
        sessionId: 'expired-session',
        provider: 'codex',
        projectRoot: '/workspace',
        backendNamespace: 'red-attacker',
      });
      const progress = f.store.appendProgress('expired-job', 'expired-session', 'expired');
      commitJobTerminal(f.store, 'expired-job', 'expired-session', {
        content: 'complete',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('storage-retention.progress.v1', value);

      await expect(
        pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: RETENTION_CUTOFF, afterSeq: 0, budget: f.budget }),
      ).resolves.toBe(0);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(progress)).toBeUndefined();
      expect(
        f.db
          .prepare('SELECT value FROM meta WHERE key = ?')
          .get('storage-retention.quarantine.v1.storage-retention.progress.v1'),
      ).toEqual({ value });
      expect(f.outcomes).toContainEqual({
        kind: 'kept',
        subject: 'storage-retention.progress.v1',
        reason: 'metadata-quarantined-restarted',
        pending: false,
      });
      await pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: RETENTION_CUTOFF, afterSeq: 0, budget: f.budget });
      expect(
        f.outcomes.filter((outcome) => outcome.kind === 'kept' && outcome.reason === 'metadata-quarantined-restarted'),
      ).toHaveLength(1);
    },
  );

  it('continues scanning exports when an interrupted-deletion pending record is malformed', async () => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'expired-residue');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old result');
    utimesSync(path, new Date(1), new Date(1));
    utimesSync(join(path, 'result.md'), new Date(1), new Date(1));
    f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('storage-retention.exports.pending.v1', '{');

    await expect(
      pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: 'zzz-previous-cursor',
        budget: f.budget,
        jobState: () => ({ kind: 'absent' }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      }),
    ).resolves.toBe('');
    expect(existsSync(path)).toBe(false);
  });
});

it.each(['storage-retention.exports.pending.v1', 'storage-retention.scratch.pending.v1'])(
  'quarantines malformed pending bookkeeping once: %s',
  (key) => {
    const f = fixture();
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        f.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, 'null');
        const pending = createRetentionPendingSet(f.db, key, (operation) => operation(), f.budget.record);
        expect(pending.subjects.size).toBe(0);
        expect(pending.overflow()).toBe(true);
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(f.outcomes).toHaveLength(1);
      expect(
        f.db.prepare('SELECT value FROM meta WHERE key = ?').get(`storage-retention.quarantine.v1.${key}`),
      ).toEqual({ value: 'null' });
    } finally {
      warn.mockRestore();
    }
  },
);

it('accepts additive pending metadata without resetting its retry set', () => {
  const f = fixture();
  const key = 'storage-retention.exports.pending.v1';
  f.db
    .prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
    .run(key, JSON.stringify({ subjects: ['held'], overflow: false, futureField: true }));
  expect(createRetentionPendingSet(f.db, key, (operation) => operation(), f.budget.record).retryOrder()).toEqual([
    'held',
  ]);
  expect(f.outcomes).toEqual([]);
});

it.each(['admission', 'retirement'])(
  'quarantines malformed export %s evidence without deleting its subject',
  async (kind) => {
    const f = fixture();
    const id = kind === 'retirement' ? `.retiring-residue-${randomUUID()}` : 'residue';
    const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'keep this evidence');
    utimesSync(path, new Date(1), new Date(1));
    utimesSync(join(path, 'result.md'), new Date(1), new Date(1));
    const key = `storage-retention.exports.${kind}.v1.${id}`;
    f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(key, '{');
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind: 'absent' }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'residue', 'result.md'))).toBe(true);
    expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get(`storage-retention.quarantine.v1.${key}`)).toEqual({
      value: '{',
    });
  },
);

it.each(['unknown', 'nonterminal', 'regression'] as const)(
  'keeps an export with %s job evidence after pending metadata resets',
  async (kind) => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'held');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'required');
    f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('storage-retention.exports.pending.v1', '{}');
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(existsSync(path)).toBe(true);
  },
);

it.each(['exports', 'scratch', 'holders'])('restarts an undecodable %s scan cursor', (owner) => {
  const f = fixture();
  const key = `storage-retention.${owner}.v1`;
  f.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(key, 'invalid\0cursor');
  expect(readRetentionCursor({ db: f.db, key, mutate: (operation) => operation(), record: f.budget.record })).toBe('');
  expect(f.db.prepare('SELECT value FROM meta WHERE key = ?').get(`storage-retention.quarantine.v1.${key}`)).toEqual({
    value: 'invalid\0cursor',
  });
});
