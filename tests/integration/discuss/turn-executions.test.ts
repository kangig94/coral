import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPlainTurn, executeAgentAttempt, recordJobFinished } from '#src/discuss/shell/runtime-build.js';
import { reconcileDiscussionOwnedJobs, runStartup } from '#src/discuss/shell/recovery.js';
import { reduceDiscussEvent } from '#src/discuss/reducer.js';
import { readJobOpened } from '#src/jobs/execution-state.js';
import type { DiscussWaitResult } from '#src/discuss/shell/types.js';
import { discussionExecutionFixture, DISCUSSION_ID, PARTICIPANT_JOBS } from '#tests/unit/discuss/execution-fixture.js';

const fixtures: ReturnType<typeof discussionExecutionFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture() {
  const f = discussionExecutionFixture();
  fixtures.push(f);
  return f;
}

function turn(f: ReturnType<typeof fixture>, agentName = 'alpha', purpose: 'bid' | 'speech' = 'bid') {
  return {
    agentName,
    sessionId: DISCUSSION_ID,
    provider: 'codex',
    model: 'gpt-5',
    prompt: purpose,
    instruction: 'Participate.',
    cwd: f.invocation.projectRoot,
    invocationCtx: f.invocation,
    purpose,
  };
}

describe('discussion turns as job executions', () => {
  it('runs two turns per participant on one retained job per participant, with attempts resetting per purpose', async () => {
    const f = fixture();
    for (const purpose of ['bid', 'speech'] as const) {
      for (const agent of Object.keys(PARTICIPANT_JOBS)) await runPlainTurn(f.context, turn(f, agent, purpose));
    }
    expect(f.service.start).toHaveBeenCalledTimes(2);
    expect(f.service.resume).toHaveBeenCalledTimes(2);
    for (const [agent, jobId] of Object.entries(PARTICIPANT_JOBS)) {
      const starts = f
        .events()
        .filter((event) => event.kind === 'agent.job.started')
        .filter((event) => event.payload.agent === agent);
      expect(starts.map((event) => event.payload)).toEqual([
        { agent, jobId, execution: 1, purpose: 'bid', attempt: 1 },
        { agent, jobId, execution: 2, purpose: 'speech', attempt: 1 },
      ]);
      expect(f.snapshot().runtime.agentRuns[agent]).toMatchObject({
        jobId,
        lastAttemptPurpose: 'speech',
        currentAttempt: 1,
      });
      expect(readJobOpened(f.journal.db, jobId, f.journal.readCtx)).toMatchObject({
        conversation: { retention: 'retain' },
      });
      expect(
        f.journal.db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM events WHERE type = 'job.opened' AND stream_id = ?")
          .get(jobId),
      ).toEqual({ count: 1 });
    }
    expect(f.journal.events().filter((event) => event.type === 'job.opened')).toHaveLength(2);
    expect(
      f
        .events()
        .filter((event) => event.kind === 'agent.job.finished')
        .map((event) => event.payload.execution),
    ).toEqual([1, 1, 2, 2]);
    expect(vi.mocked(f.service.start).mock.calls.every(([, input]) => input.retention === 'retain')).toBe(true);
  });

  it('does not close N+1 when a delayed finish for N has the same job, purpose and retry count', async () => {
    const f = fixture();
    const params = turn(f);
    await runPlainTurn(f.context, params);
    const jobId = PARTICIPANT_JOBS.alpha;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiting!: () => void;
    const enteredWait = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    vi.mocked(f.service.waitStreamOnce).mockImplementationOnce(async (): Promise<DiscussWaitResult> => {
      waiting();
      await blocked;
      f.complete(jobId, 2);
      return { content: 'result #2', continuity: null };
    });
    const pendingTurn = executeAgentAttempt(f.context, params);
    await enteredWait;
    expect(f.store.readStatus(jobId)).toMatchObject({ execution: 2, phase: 'running' });
    const before = f.snapshot();
    await recordJobFinished(f.context, {
      sessionId: DISCUSSION_ID,
      agentName: 'alpha',
      purpose: 'bid',
      jobId,
      execution: 1,
      attempt: 1,
      outcome: 'completed',
    });
    expect(f.snapshot()).toEqual(before);
    const oldFinish = f.events().find((event) => event.kind === 'agent.job.finished')!;
    expect(
      reduceDiscussEvent(before, { ...oldFinish, seq: before.lastAppliedSeq + 1 }).runtime.agentRuns.alpha,
    ).toEqual(before.runtime.agentRuns.alpha);
    expect(() =>
      f.append('agent.job.finished', {
        agent: 'alpha',
        jobId,
        execution: 1,
        attempt: 1,
        outcome: 'completed',
      }),
    ).toThrowError(expect.objectContaining({ code: 'discuss_job_link_invalid' }));
    expect(f.snapshot().runtime.agentRuns.alpha.currentExecution).toBe(2);
    release();
    const pending = await pendingTurn;
    if (!pending.ok) throw new Error(pending.message);
    expect(pending).toMatchObject({ jobId, execution: 2, attempt: 1 });
    await recordJobFinished(f.context, {
      sessionId: DISCUSSION_ID,
      agentName: 'alpha',
      purpose: 'bid',
      jobId: pending.jobId,
      execution: pending.execution,
      attempt: pending.attempt,
      outcome: 'completed',
    });
    expect(f.snapshot().runtime.agentRuns.alpha.currentExecution).toBeUndefined();
  });

  it.each(['live', 'startup'] as const)(
    'reconciles a crash after requested(k) before started(k), with %s recovery',
    async (mode) => {
      const f = fixture();
      await runPlainTurn(f.context, turn(f));
      const jobId = PARTICIPANT_JOBS.alpha;
      f.request(jobId, { agent: 'alpha', purpose: 'speech', attempt: 1 });
      const count = f.events().length;
      if (mode === 'live') {
        await reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID);
        await reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID);
      } else {
        const services = f.reopen();
        const deps = {
          getDiscussContext: services.getDiscussContext,
          createInvocationContext: () => f.invocation,
          signal: new AbortController().signal,
        };
        await runStartup(deps);
        await runStartup(deps);
      }
      expect(
        f
          .events()
          .slice(count)
          .map((event) => event.payload),
      ).toEqual([{ agent: 'alpha', jobId, execution: 2, purpose: 'speech', attempt: 1 }]);
      expect(f.snapshot().runtime.agentRuns.alpha).toMatchObject({
        jobId,
        currentJobId: jobId,
        currentExecution: 2,
        currentJobPurpose: 'speech',
      });
      expect(f.service.start).toHaveBeenCalledTimes(1);
      expect(f.service.resume).not.toHaveBeenCalled();
    },
  );

  it('counts parse retries independently from execution ordinals and resets attempts for another purpose', async () => {
    const f = fixture();
    for (const [purpose, execution, expectedAttempt] of [
      ['bid', 1, 1],
      ['bid', 2, 2],
      ['speech', 3, 1],
    ] as const) {
      const result = await executeAgentAttempt(f.context, turn(f, 'alpha', purpose));
      expect(result).toMatchObject({ ok: true, execution, attempt: expectedAttempt });
      if (!result.ok) throw new Error(result.message);
      await recordJobFinished(f.context, {
        sessionId: DISCUSSION_ID,
        agentName: 'alpha',
        purpose,
        jobId: result.jobId,
        execution: result.execution,
        attempt: result.attempt,
        outcome: 'retryable_parse_error',
      });
    }
  });
});
