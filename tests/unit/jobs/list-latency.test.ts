import { createJobsListHistory as history, coordinatorJobs as coordinator } from '#tests/helpers/jobs-list-history.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import {
  readExecutionRetryStatus,
  readExecutionRetryStatuses,
  EXECUTION_FINISHING_BOUNDARY,
} from '#src/jobs/finishing.js';
import {
  writeFinishingQuarantine,
  breakFinishingRetryAuthority,
  FINISHING_QUARANTINE_STATUS,
} from '#tests/helpers/finishing-quarantine.js';
import { formatJobsList } from '#src/cli/format/jobs.js';
import { describe, expect, it, vi } from 'vitest';
import {
  type executionHarness,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID,
} from '#tests/helpers/job-executions.js';
import { insertTestJobProjection } from '#tests/helpers/job-projection.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { listJobs, listJobProjections, loadJobProjectionDetail, type JobsListFilters } from '#src/jobs/read-queries.js';
import { jobInCallerScope } from '#src/jobs/scope.js';
import { isLivePhase } from '#src/jobs/phase.js';
import type { EventsRow } from '#src/store/schema.js';
import type { ProjectionJobStoredRow } from '#src/jobs/projection-row.js';

describe('jobs list hydration', () => {
  it('preserves statuses for every selection and reads only surviving evidence', () => {
    const h = history(4);
    try {
      const projections = h.db
        .prepare<[], ProjectionJobStoredRow>('SELECT * FROM projection_jobs ORDER BY job_id')
        .all();
      const old = projections.map((p) => ({
        jobId: p.job_id,
        status: loadJobProjectionDetail(h.db, p.job_id, h.readCtx).status!,
      }));
      const scope = fixtureCanonicalWorkDir('/workspace');
      for (const all of [false, true])
        for (const phase of [undefined, 'launching', 'completed', 'error'] as const)
          for (const provider of [undefined, 'codex', 'claude'])
            for (const projectRoot of [undefined, scope, fixtureCanonicalWorkDir('/workspace/child')]) {
              const filters: JobsListFilters = { all, phase, provider, projectRoot };
              const expected = old.filter(
                ({ status }) =>
                  (all || isLivePhase(status.phase)) &&
                  (phase === undefined || phase === status.phase) &&
                  (provider === undefined || provider === status.provider) &&
                  (projectRoot === undefined || jobInCallerScope(status, projectRoot, 'exact')),
              );
              expect(listJobProjections(h.db, h.readCtx, filters)).toEqual(expected);
              expect(listJobs(h.db, filters, h.readCtx)).toEqual(expected);
              const actual = coordinator(h).list(filters);
              expect(formatJobsList({ jobs: actual })).toEqual(
                formatJobsList({ jobs: expected.map((entry) => ({ ...entry, execution: entry.status.execution })) }),
              );
              expect(coordinator(h).list({ ...filters, owner: 'missing' })).toEqual([]);
              expect(
                coordinator(h)
                  .list({ ...filters, owner: 'mine' })
                  .map(({ jobId }) => jobId),
              ).toEqual(
                expected
                  .filter(({ status }) => isLivePhase(status.phase) && status.jobKind !== 'kb')
                  .map(({ jobId }) => jobId),
              );
            }
      expect(listJobProjections(h.db, h.readCtx, { all: true, discussionId: 'discussion-a' })).toEqual(
        old.filter(({ status }) => status.owner.kind === 'discussion' && status.owner.id === 'discussion-a'),
      );
    } finally {
      h.db.close();
    }
  }, 120_000);

  it('keeps quarantine reads bounded as terminal and live histories grow', async () => {
    const inspect = async (terminalCount: number, additionalLive: number, quarantinedCount: number) => {
      const h = history(terminalCount);
      for (let index = 0; index < additionalLive; index++) {
        const jobId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        h.append(
          { ...openedJob({ owner: { kind: 'provider-session', id: jobId } }), stream: { kind: 'job', id: jobId } },
          { ...requestedExecution(), stream: { kind: 'job', id: jobId } },
        );
      }
      let quarantineReads = 0;
      let projectionRows = 0;
      let largestQuarantineBatch = 0;
      const eventRows: Array<Pick<EventsRow, 'seq' | 'stream_id'>> = [];
      const prepare = h.db.prepare.bind(h.db);
      vi.spyOn(h.db, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        const all = statement.all.bind(statement);
        const get = statement.get.bind(statement);
        const iterate = statement.iterate.bind(statement);
        const run = statement.run.bind(statement);
        const observe = (rows: unknown[], args: unknown[]) => {
          if (/\brecovery_quarantine\b/iu.test(sql)) {
            quarantineReads++;
            largestQuarantineBatch = Math.max(largestQuarantineBatch, args.length - 1);
          }
          if (/\bprojection_jobs\b/iu.test(sql))
            projectionRows += rows.filter((row) => row !== null && typeof row === 'object' && 'job_id' in row).length;
          if (/\bevents\b/iu.test(sql)) eventRows.push(...(rows as Array<Pick<EventsRow, 'seq' | 'stream_id'>>));
        };
        statement.all = (...args: unknown[]) => {
          const rows = all(...args);
          observe(rows, args);
          return rows;
        };
        statement.get = (...args: unknown[]) => {
          const row = get(...args);
          observe(row === undefined ? [] : [row], args);
          return row;
        };
        statement.iterate = (...args: unknown[]) => {
          const rows = iterate(...args);
          return (function* () {
            observe([], args);
            for (const row of rows) {
              if (/\bprojection_jobs\b/iu.test(sql) && row !== null && typeof row === 'object' && 'job_id' in row)
                projectionRows++;
              if (/\bevents\b/iu.test(sql)) eventRows.push(row as EventsRow);
              yield row;
            }
          })();
        };
        statement.run = (...args: unknown[]) => {
          observe([], args);
          return run(...args);
        };
        return statement;
      });
      try {
        for (let index = 0; index < quarantinedCount; index++)
          writeFinishingQuarantine(h.db, `job-${String(index).padStart(5, '0')}`, 2);
        quarantineReads = 0;
        projectionRows = 0;
        largestQuarantineBatch = 0;
        eventRows.length = 0;
        h.db.prepare("UPDATE projection_jobs SET diagnostics = diagnostics WHERE job_id = 'job-00000'").run();
        const live = coordinator(h).list({});
        expect(live).toHaveLength(4 + additionalLive);
        expect(projectionRows).toBeGreaterThan(0);
        expect(projectionRows).toBeLessThanOrEqual(live.length);
        const liveIds = new Set(live.map(({ jobId }) => jobId));
        expect(eventRows.length).toBeGreaterThan(0);
        expect(eventRows.every((row) => liveIds.has(row.stream_id))).toBe(true);
        expect(eventRows.length).toBeLessThanOrEqual(live.length * 3);
        expect(largestQuarantineBatch).toBeGreaterThan(1);
        expect(quarantineReads).toBeGreaterThan(0);
        expect(quarantineReads).toBeLessThanOrEqual(Math.ceil(live.length / largestQuarantineBatch));
        eventRows.length = 0;
        quarantineReads = 0;
        projectionRows = 0;
        largestQuarantineBatch = 0;
        const terminal = coordinator(h).list({ all: true, phase: 'completed' });
        const terminalIds = new Set(terminal.map(({ jobId }) => jobId));
        expect(eventRows.length).toBeGreaterThan(0);
        expect(eventRows.every((row) => terminalIds.has(row.stream_id))).toBe(true);
        expect(eventRows.length).toBeLessThanOrEqual(terminal.length * 3);
        expect(largestQuarantineBatch).toBeGreaterThan(1);
        expect(quarantineReads).toBeGreaterThan(0);
        expect(quarantineReads).toBeLessThanOrEqual(Math.ceil(terminal.length / largestQuarantineBatch));
      } finally {
        vi.restoreAllMocks();
        h.db.close();
      }
    };
    await inspect(8, 0, 3);
    await inspect(2000, 12, 40);
  }, 120_000);
});

function corruptEnd(h: ReturnType<typeof executionHarness>, jobId = EXECUTION_JOB_ID): void {
  const row = h.db
    .prepare<
      [string],
      { seq: number; body: Uint8Array }
    >("SELECT seq, body FROM events WHERE stream_id = ? AND type = 'job.execution.ended' ORDER BY seq DESC LIMIT 1")
    .get(jobId)!;
  const body = JSON.parse(Buffer.from(row.body).toString());
  body.causeRef.seq = 1;
  h.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from(JSON.stringify(body)), row.seq);
}

it.each([null, JSON.stringify({ content: 'tampered', durationMs: 100, outcome: { kind: 'completed' } })])(
  'renders the event result when projection terminal is %s',
  (terminal) => {
    const h = history(1);
    try {
      h.db.prepare("UPDATE projection_jobs SET terminal = ? WHERE job_id = 'job-00000'").run(terminal);
      expect(coordinator(h).list({ all: true })[0].status.result?.content).toBe('done');
      h.db.prepare("UPDATE projection_jobs SET terminal = NULL WHERE job_id = 'job-00000'").run();
      expect(coordinator(h).list({ all: true })[0].status.result?.content).toBe('done');
    } finally {
      h.db.close();
    }
  },
);

it('decodes only current finishing quarantine and retains malformed-detail tolerance', () => {
  const h = history(1);
  try {
    const current = 'job-00000';
    const colonId = 'worker:branch:0099';
    insertTestJobProjection(h.db, { job_id: colonId, project_root: '/workspace', phase: 'completed' });
    writeFinishingQuarantine(h.db, current, 2);
    writeFinishingQuarantine(h.db, current, 1);
    writeFinishingQuarantine(h.db, 'missing-job', 1);
    writeFinishingQuarantine(h.db, colonId, 1);
    new RecoveryQuarantineStore(h.db, { now: () => Date.parse('2026-10-22T00:00:00.000Z') }).upsert({
      boundary: 'another-boundary',
      subject: { key: current + ':2', revision: { kind: 'until-cleared' } },
      state: 'active',
      stage: 'settle',
      errorMessage: 'fixture',
      detail: '{}',
    });
    breakFinishingRetryAuthority(h.db, current, 1);
    breakFinishingRetryAuthority(h.db, 'missing-job', 1);
    h.db.prepare("UPDATE recovery_quarantine SET state = 'retrying' WHERE boundary_id = 'another-boundary'").run();
    const statuses = readExecutionRetryStatuses(h.db, [
      { jobId: current, execution: 2 },
      { jobId: colonId, execution: 1 },
    ]);
    expect(statuses).toEqual(
      new Map([
        [current + ':2', FINISHING_QUARANTINE_STATUS],
        [colonId + ':1', FINISHING_QUARANTINE_STATUS],
      ]),
    );
    const listed = coordinator(h).list({ all: true });
    expect(listed.find(({ jobId }) => jobId === current)?.status.finishingStatus).toEqual(FINISHING_QUARANTINE_STATUS);
    expect(listed.find(({ jobId }) => jobId === colonId)?.status.finishingStatus).toEqual(FINISHING_QUARANTINE_STATUS);
    const stored = listJobs(h.db, { all: true }, h.readCtx);
    expect(stored.find(({ jobId }) => jobId === current)?.status.finishingStatus).toEqual(FINISHING_QUARANTINE_STATUS);
    expect(stored.find(({ jobId }) => jobId === colonId)?.status.finishingStatus).toEqual(FINISHING_QUARANTINE_STATUS);
    h.db
      .prepare('UPDATE recovery_quarantine SET disposition_detail = ? WHERE boundary_id = ? AND subject_key = ?')
      .run('{malformed', EXECUTION_FINISHING_BOUNDARY, current + ':2');
    expect(readExecutionRetryStatus(h.db, { jobId: current, execution: 2 })).toBeNull();
    expect(readExecutionRetryStatuses(h.db, [{ jobId: current, execution: 2 }]).has(current + ':2')).toBe(false);
    expect(
      coordinator(h)
        .list({ all: true })
        .find(({ jobId }) => jobId === current)?.status.finishingStatus,
    ).toBeUndefined();
    expect(
      listJobs(h.db, { all: true }, h.readCtx).find(({ jobId }) => jobId === current)?.status.finishingStatus,
    ).toBeUndefined();
  } finally {
    h.db.close();
  }
});

it.each(['coordinator', 'journal', 'discuss'].flatMap((caller) => [false, true].map((all) => ({ caller, all }))))(
  'validates selected evidence on every $caller list with all=$all without revision changes',
  ({ caller, all }) => {
    const h = history(1);
    const filters = { all };
    const jobId = all ? 'job-00000' : 'job-00001';
    const row = h.db
      .prepare<
        [string],
        { seq: number }
      >("SELECT seq FROM events WHERE stream_id = ? AND type = 'job.execution.progress' ORDER BY seq DESC LIMIT 1")
      .get(jobId)!;
    const body = { execution: 2, attempt: 0, handles: [], reason: 'fixture' as string | number };
    h.db
      .prepare('UPDATE events SET type = ?, body = ? WHERE seq = ?')
      .run('job.retention.discard.failed', Buffer.from(JSON.stringify(body)), row.seq);
    const list = () =>
      caller === 'coordinator'
        ? coordinator(h).list(filters)
        : caller === 'journal'
          ? listJobs(h.db, filters, h.readCtx)
          : listJobProjections(h.db, h.readCtx, filters);
    try {
      expect(list()).toHaveLength(all ? 5 : 4);
      body.reason = 7;
      h.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from(JSON.stringify(body)), row.seq);
      expect(list).toThrow();
    } finally {
      h.db.close();
    }
  },
);

it.each(['coordinator', 'journal', 'discuss'] as const)('validates only selected rows through %s', (caller) => {
  const h = history(1);
  const list = (filters: JobsListFilters) =>
    caller === 'coordinator'
      ? coordinator(h).list(filters)
      : caller === 'journal'
        ? listJobs(h.db, filters, h.readCtx)
        : listJobProjections(h.db, h.readCtx, filters);
  try {
    corruptEnd(h, 'job-00000');
    expect(list({})).toHaveLength(4);
    expect(() => list({ all: true })).toThrow('does not cite its accepted outcome');
    expect(() => loadJobProjectionDetail(h.db, 'job-00000', h.readCtx)).toThrow('does not cite its accepted outcome');
  } finally {
    h.db.close();
  }
});

it.each([false, true])('validates selected quarantine after a previous list=%s', (previous) => {
  const h = history(1);
  try {
    writeFinishingQuarantine(h.db, 'job-00000', 2);
    if (previous) coordinator(h).list({ all: true });
    breakFinishingRetryAuthority(h.db, 'job-00000', 2);
    expect(coordinator(h).list({})).toHaveLength(4);
    expect(listJobs(h.db, {}, h.readCtx)).toHaveLength(4);
    expect(() => coordinator(h).list({ all: true })).toThrow('Recovery retry authority is incomplete');
    expect(() => listJobs(h.db, { all: true }, h.readCtx)).toThrow('Recovery retry authority is incomplete');
  } finally {
    h.db.close();
  }
});

it('decodes selected projections after writes without auditing unlisted history', () => {
  const h = history(1);
  try {
    expect(coordinator(h).list({})).toHaveLength(4);
    h.db.prepare("UPDATE projection_jobs SET diagnostics = 'invalid-json' WHERE job_id = 'job-00000'").run();
    expect(coordinator(h).list({})).toHaveLength(4);
    expect(listJobs(h.db, {}, h.readCtx)).toHaveLength(4);
    expect(() => coordinator(h).list({ all: true })).toThrow();
  } finally {
    h.db.close();
  }
});
