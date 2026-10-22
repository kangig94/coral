import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { ensureRetentionIndexes } from '#src/store/retention-indexes.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';
import { decodeWaitCursor, encodeWaitCursor } from '#src/jobs/wait/cursor.js';
import { loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import {
  executionHarness,
  executionInput,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID as jobId,
  EXECUTION_NOW,
} from '#tests/helpers/job-executions.js';

const journals: ReturnType<typeof executionHarness>[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.db.close();
});
function fixture() {
  const journal = executionHarness();
  journals.push(journal);
  return journal;
}
function progress(execution: number, message: string) {
  return executionInput('job.execution.progress', {
    execution,
    kind: 'message',
    message,
    timing: { origin: 'runtime', originAt: EXECUTION_NOW, emittedAt: EXECUTION_NOW, elapsedMs: 0 },
  });
}

describe('execution consumers', () => {
  it('prunes expired #1 while #2 is open, preserving causes, fault diagnostics and decimal cursors', async () => {
    const h = fixture();
    ensureRetentionIndexes(h.db);
    h.ctx.now = () => new Date('2026-10-01T00:00:00Z');
    h.append(openedJob(), requestedExecution());
    const removable = h.append(progress(1, 'expired'))[0].seq;
    const protectedSeq = h.append(progress(1, 'causal evidence'))[0].seq;
    const faultSeq = h.append(
      executionInput('job.execution.progress', { execution: 1, kind: 'missing_launch_record' }),
    )[0].seq;
    h.commit((c) => {
      const accepted = appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution: 1,
        terminal: {
          content: 'failed',
          durationMs: 1,
          outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: jobId }, seq: protectedSeq } },
        },
      });
      appendJobExecutionEnded(c, { jobId, execution: 1, causeRef: accepted });
      return undefined;
    });
    h.ctx.now = () => new Date(EXECUTION_NOW);
    h.append(requestedExecution(2), progress(2, 'still running'));
    const liveSeq = h.events().at(-1)!.seq;
    const record = vi.fn();
    await pruneJobProgress({
      db: h.db,
      readCtx: h.readCtx,
      cutoff: Date.parse('2026-10-15T00:00:00Z'),
      afterSeq: 0,
      budget: { canContinue: () => true, record },
    });
    const retained = h.events().map((event) => event.seq);
    expect(retained).not.toContain(removable);
    expect(retained).toEqual(expect.arrayContaining([protectedSeq, faultSeq, liveSeq]));
    expect(loadJobProjectionDetail(h.db, jobId, h.readCtx).status).toMatchObject({ execution: 2, phase: 'launching' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'deleted', count: 1 }));
    expect(encodeWaitCursor(protectedSeq)).toBe(String(protectedSeq));
    expect(decodeWaitCursor(String(protectedSeq))).toEqual({ kind: 'decoded', watermark: protectedSeq });
  });

  it('sums stale-aborted and replacement ends once while nested workflows contribute their end diagnostics', () => {
    const h = fixture();
    const parent = '10000000-0000-4000-8000-000000000099';
    h.append(openedJob(), requestedExecution());
    const end = (execution: number, usage: { inputTokens: number; costUsd?: number }, aborted = false) =>
      h.commit((c) => {
        const accepted = appendJobExecutionOutcomeAccepted(c, {
          jobId,
          execution,
          terminal: {
            content: '',
            durationMs: 1,
            outcome: aborted ? { kind: 'aborted', reason: 'user_abort' } : { kind: 'completed' },
          },
          diagnostics: { usage },
        });
        appendJobExecutionEnded(c, { jobId, execution, causeRef: accepted });
        return undefined;
      });
    end(1, { inputTokens: 10, costUsd: 0.1 }, true);
    h.append(requestedExecution(2));
    h.db
      .prepare(
        'UPDATE projection_jobs SET parent_workflow_job_id = ?, workflow_slot = ?, execution_owner = ? WHERE job_id = ?',
      )
      .run(parent, `${parent}:0:0`, JSON.stringify({ kind: 'workflow', id: parent }), jobId);
    expect(aggregateWorkflowUsage(h.db, parent)).toEqual({ inputTokens: 10, costUsd: 0.1 });
    end(2, { inputTokens: 20 });
    const nested = '10000000-0000-4000-8000-000000000003';
    h.append(
      {
        ...openedJob(),
        stream: { kind: 'job', id: nested },
        body: {
          jobKind: 'workflow',
          owner: { kind: 'workflow', id: nested },
          projectRoot: '/workspace',
          cwd: '/workspace',
          bypassPermissions: false,
          createdAt: EXECUTION_NOW,
        },
      },
      { ...requestedExecution(), stream: { kind: 'job', id: nested } },
    );
    h.commit((c) => {
      const accepted = appendJobExecutionOutcomeAccepted(c, {
        jobId: nested,
        execution: 1,
        terminal: { content: '', durationMs: 1, outcome: { kind: 'completed' } },
        diagnostics: { usage: { inputTokens: 40, costUsd: 0.4, jobsWithoutCostData: 2 } },
      });
      appendJobExecutionEnded(c, { jobId: nested, execution: 1, causeRef: accepted });
      return undefined;
    });
    h.db.prepare('UPDATE projection_jobs SET parent_workflow_job_id = ? WHERE job_id = ?').run(parent, nested);
    const grandchild = '10000000-0000-4000-8000-000000000004';
    h.append(
      {
        ...openedJob({ owner: { kind: 'provider-session', id: grandchild } }),
        stream: { kind: 'job', id: grandchild },
      },
      { ...requestedExecution(), stream: { kind: 'job', id: grandchild } },
    );
    h.db
      .prepare(
        'UPDATE projection_jobs SET parent_workflow_job_id = ?, workflow_slot = ?, execution_owner = ? WHERE job_id = ?',
      )
      .run(nested, `${nested}:0:0`, JSON.stringify({ kind: 'workflow', id: nested }), grandchild);
    h.commit((c) => {
      const accepted = appendJobExecutionOutcomeAccepted(c, {
        jobId: grandchild,
        execution: 1,
        terminal: { content: '', durationMs: 1, outcome: { kind: 'completed' } },
        diagnostics: { usage: { inputTokens: 40, costUsd: 0.4 } },
      });
      appendJobExecutionEnded(c, { jobId: grandchild, execution: 1, causeRef: accepted });
      return undefined;
    });
    const expected = { inputTokens: 70, costUsd: 0.5, jobsWithoutCostData: 1 };
    expect(aggregateWorkflowUsage(h.db, parent)).toEqual(expected);
    expect(aggregateWorkflowUsage(h.db, parent)).toEqual(expected);
  });
});
