import { afterEach, describe, expect, it } from 'vitest';
import { committedExecutionRequest, loadExecutionWaitDetail } from '#src/jobs/wait/execution-detail.js';
import { visitJobProgress } from '#src/jobs/read-queries.js';
import { executionHarness, executionInput, openedJob, requestedExecution, EXECUTION_JOB_ID as jobId } from '#tests/helpers/job-executions.js';

const opened: ReturnType<typeof executionHarness>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.db.close(); });

function fixture() {
  const h = executionHarness();
  opened.push(h);
  h.append(openedJob(), requestedExecution());
  return h;
}

function progress(execution: number, message: string) {
  return executionInput('job.execution.progress', {
    execution, kind: 'message', message,
    timing: { origin: 'runtime', originAt: '2026-10-22T00:00:00Z', emittedAt: '2026-10-22T00:00:00Z', elapsedMs: 0 },
  });
}

describe('wait execution evidence in the journal', () => {
  it('reopens #2 by its committed request after #3 has started, without inheriting #3 state', () => {
    const h = fixture();
    h.complete();
    h.append(requestedExecution(2), progress(2, 'second'));
    const request = committedExecutionRequest(h.db, jobId, 2, 'epoch');
    h.complete(2);
    h.append(requestedExecution(3), progress(3, 'third'));
    const detail = loadExecutionWaitDetail(h.db, jobId, h.readCtx, request.requestedSeq);
    expect(detail).toMatchObject({ requestedSeq: request.requestedSeq, status: { execution: 2, phase: 'completed' }, exit: { outcome: { kind: 'completed' } } });
    expect(detail.terminalSeq).toBeLessThan(committedExecutionRequest(h.db, jobId, 3, 'epoch').requestedSeq);
    expect(loadExecutionWaitDetail(h.db, jobId, h.readCtx)).toMatchObject({ status: { execution: 3 }, runtime: null, exit: null });
    const rows = visitJobProgress(h.db, h.readCtx, (source) => ({
      after: source.after(jobId, request.requestedSeq, 500, detail.terminalSeq),
      tail: source.newest(jobId, 20, request.requestedSeq, detail.terminalSeq),
    }));
    expect(rows).toMatchObject({ kind: 'read', value: { after: [{ message: 'second' }], tail: [{ message: 'second' }] } });
  });

  it('admits the latest queued request without a previous execution runtime or end', () => {
    const h = fixture();
    h.complete();
    h.append(requestedExecution(2), executionInput('job.execution.queued', { execution: 2, queuePosition: 1, runningJobIds: [] }));
    const detail = loadExecutionWaitDetail(h.db, jobId, h.readCtx);
    expect(detail).toMatchObject({ status: { execution: 2, phase: 'queued' }, runtime: null, exit: null });
    expect(detail.terminalSeq).toBeUndefined();
    expect(detail.requestedSeq).toBe(committedExecutionRequest(h.db, jobId, 2, 'epoch').requestedSeq);
  });

  it('does not select latest when the addressed request is absent', () => {
    const h = fixture();
    expect(loadExecutionWaitDetail(h.db, jobId, h.readCtx, 999)).toMatchObject({ status: null, runtime: null, exit: null });
    expect(() => committedExecutionRequest(h.db, jobId, 2, 'epoch')).toThrow('Committed execution request is missing');
  });
});
