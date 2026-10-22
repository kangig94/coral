import { expect, it } from 'vitest';
import { loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import { planRecovery, type RecoveryProjectionSnapshot } from '#src/jobs/reconcile/plan.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { executionHarness, openedJob, requestedExecution, executionInput, EXECUTION_JOB_ID as jobId, EXECUTION_NOW } from '#tests/helpers/job-executions.js';

it('plans the queued execution without inheriting a predecessor runtime, terminal or claim-release obligation', () => {
  const h = executionHarness();
  try {
    h.append(openedJob(), requestedExecution(), executionInput('job.execution.started', {
      execution: 1, transport: 'app-server', startedAt: EXECUTION_NOW,
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    }));
    h.complete(1);
    h.append(requestedExecution(2), executionInput('job.execution.queued', {
      execution: 2, queuePosition: 1, runningJobIds: [],
    }));
    const snapshot = (): RecoveryProjectionSnapshot => ({
      jobIds: [jobId], isPidAlive: () => true,
      readJob: () => {
        const detail = loadJobProjectionDetail(h.db, jobId, h.readCtx);
        return { jobId, hasLaunchRequest: detail.launch !== null, hasRuntimeStart: detail.runtime !== null,
          hasTerminalRecord: detail.exit !== null, status: detail.status,
          launchRecord: detail.launch, runtimeRecord: detail.runtime };
      },
    });
    expect(loadJobProjectionDetail(h.db, jobId, h.readCtx)).toMatchObject({
      status: { execution: 2, phase: 'queued' }, runtime: null, exit: null,
    });
    expect(planRecovery(snapshot())).toMatchObject({
      register: [{ type: 'registerQueued', jobId, launchRecord: { execution: 2 } }], cleanup: [],
    });
    h.commit(c => {
      appendJobExecutionOutcomeAccepted(c, { jobId, execution: 2,
        terminal: { content: 'accepted', durationMs: 0, outcome: { kind: 'completed' } } });
      return undefined;
    });
    expect(planRecovery(snapshot())).toEqual({ register: [], cleanup: [] });
  } finally { h.db.close(); }
});
