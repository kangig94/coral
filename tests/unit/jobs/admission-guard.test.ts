import { expect, it, vi } from 'vitest';
import { executionHarness, openedJob, requestedExecution, executionInput } from '#tests/helpers/job-executions.js';

it('guards admissions without locking ordinary execution appends', () => {
  const h = executionHarness();
  const guard = vi.fn();
  h.ctx.withCommitGuard = <T>(action: () => T): T => {
    guard();
    return action();
  };
  try {
    h.append(openedJob(), requestedExecution());
    expect(guard).toHaveBeenCalledTimes(1);
    h.append(executionInput('job.execution.progress', { execution: 1, kind: 'missing_launch_record' }));
    h.complete(1);
    expect(guard).toHaveBeenCalledTimes(1);
    h.append(requestedExecution(2));
    expect(guard).toHaveBeenCalledTimes(2);
  } finally {
    h.db.close();
  }
});

it('runs read-then-append closures once under the write transaction after the admission guard', () => {
  const h = executionHarness();
  const seen: string[] = [];
  h.ctx.withCommitGuard = (write, jobIds) => {
    expect(jobIds).toEqual([openedJob().stream.id]);
    expect(h.db.isTransaction).toBe(false);
    seen.push('guard');
    return write();
  };
  try {
    h.commit(
      (c) => {
        expect(h.db.isTransaction).toBe(true);
        seen.push('closure');
        expect(h.db.prepare('SELECT * FROM projection_jobs').all()).toEqual([]);
        c.append(openedJob());
        c.append(requestedExecution());
        return undefined;
      },
      { admittingJobs: [openedJob().stream.id] },
    );
    expect(seen).toEqual(['guard', 'closure']);
    expect(h.db.isTransaction).toBe(false);
  } finally {
    h.db.close();
  }
});
