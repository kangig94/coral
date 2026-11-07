import { decodeProjectionJobExecutionOwner } from '#src/jobs/projection-row.js';
import { insertTestJobProjection } from '#tests/helpers/job-projection.js';
import { writeFinishingQuarantine, breakFinishingRetryAuthority } from '#tests/helpers/finishing-quarantine.js';
import { EXECUTION_NOW } from '#tests/helpers/job-executions.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runPlainTurn, executeAgentAttempt, recordJobFinished } from '#src/discuss/shell/runtime-build.js';
import { reconcileDiscussionOwnedJobs, runStartup } from '#src/discuss/shell/recovery.js';
import { reduceDiscussEvent } from '#src/discuss/reducer.js';
import { readJobOpened } from '#src/jobs/execution-journal.js';
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

  it.each(['live', 'startup'] as const)(
    'recovers an ended first turn before binding and continues the same job with %s recovery',
    async (mode) => {
      const f = fixture();
      const jobId = PARTICIPANT_JOBS.alpha;
      f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
      f.complete(jobId, 1);
      const count = f.events().length;
      const services = mode === 'startup' ? f.reopen() : f.services;
      const recover = () =>
        mode === 'live'
          ? reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID)
          : runStartup({
              getDiscussContext: services.getDiscussContext,
              createInvocationContext: () => f.invocation,
              signal: new AbortController().signal,
            });
      await recover();
      await recover();
      expect(
        f
          .events()
          .slice(count)
          .map((event) => ({ kind: event.kind, payload: event.payload })),
      ).toEqual([
        { kind: 'agent.run.bound', payload: { agent: 'alpha', jobId } },
        {
          kind: 'agent.job.started',
          payload: { agent: 'alpha', jobId, execution: 1, purpose: 'bid', attempt: 1 },
        },
        {
          kind: 'agent.job.finished',
          payload: { agent: 'alpha', jobId, execution: 1, attempt: 1, outcome: 'completed' },
        },
      ]);
      expect(f.snapshot().runtime.agentRuns.alpha).toMatchObject({ jobId, lastAttemptOutcome: 'completed' });
      expect(f.snapshot().runtime.agentRuns.alpha.currentJobId).toBeUndefined();

      await runPlainTurn(services.getDiscussContext(f.invocation), turn(f, 'alpha', 'speech'));
      expect(f.service.start).not.toHaveBeenCalled();
      expect(f.service.resume).toHaveBeenCalledExactlyOnceWith(
        'codex',
        expect.objectContaining({ jobId, discussionRun: { agent: 'alpha', purpose: 'speech', attempt: 1 } }),
        f.invocation,
      );
      expect(
        f
          .events()
          .filter((event) => event.kind === 'agent.job.started')
          .map((event) => event.payload.execution),
      ).toEqual([1, 2]);
      expect(f.journal.events().filter((event) => event.type === 'job.opened')).toHaveLength(1);
    },
  );

  it.each(['live', 'startup'] as const)(
    'recovers an ended turn whose started event was lost before a pending turn during %s recovery',
    async (mode) => {
      const f = fixture();
      const jobId = PARTICIPANT_JOBS.alpha;
      f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
      f.complete(jobId, 1);
      f.append('agent.run.bound', { agent: 'alpha', jobId });
      f.request(jobId, { agent: 'alpha', purpose: 'speech', attempt: 1 });
      if (mode === 'live') await reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID);
      else
        await runStartup({
          getDiscussContext: f.reopen().getDiscussContext,
          createInvocationContext: () => f.invocation,
          signal: new AbortController().signal,
        });
      expect(
        f
          .events()
          .filter((event) => event.kind === 'agent.job.started')
          .map((event) => event.payload.execution),
      ).toEqual([1, 2]);
      expect(
        f
          .events()
          .filter((event) => event.kind === 'agent.job.finished')
          .map((event) => event.payload.execution),
      ).toEqual([1]);
      expect(f.snapshot().runtime.agentRuns.alpha).toMatchObject({ jobId, currentJobId: jobId, currentExecution: 2 });
      expect(f.service.start).not.toHaveBeenCalled();
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

  it.each(['live', 'startup'] as const)(
    'preserves a newer active and then finished turn when an older start is missing during %s recovery',
    async (mode) => {
      const f = fixture();
      const jobId = PARTICIPANT_JOBS.alpha;
      f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
      f.complete(jobId, 1);
      f.append('agent.run.bound', { agent: 'alpha', jobId });
      f.request(jobId, { agent: 'alpha', purpose: 'speech', attempt: 1 });
      f.append('agent.job.started', { agent: 'alpha', jobId, execution: 2, purpose: 'speech', attempt: 1 });
      const services = mode === 'startup' ? f.reopen() : f.services;
      const recover = () =>
        mode === 'live'
          ? reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID)
          : runStartup({
              getDiscussContext: services.getDiscussContext,
              createInvocationContext: () => f.invocation,
              signal: new AbortController().signal,
            });
      const active = f.snapshot();
      await recover();
      expect(f.snapshot()).toEqual(active);

      f.complete(jobId, 2);
      f.append('agent.job.finished', { agent: 'alpha', jobId, execution: 2, attempt: 1, outcome: 'completed' });
      const finished = f.snapshot();
      await recover();
      await recover();
      expect(f.snapshot()).toEqual(finished);
      expect(f.service.start).not.toHaveBeenCalled();
      expect(f.service.resume).not.toHaveBeenCalled();
    },
  );
});

it.each([DISCUSSION_ID])('rejects corrupt terminal evidence through discuss listOwned(%s)', (discussionId) => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(jobId, 1);
  const row = f.journal.db
    .prepare<
      [string],
      { seq: number; body: Uint8Array }
    >("SELECT seq, body FROM events WHERE stream_id = ? AND type = 'job.execution.ended' ORDER BY seq DESC LIMIT 1")
    .get(jobId)!;
  const body = JSON.parse(Buffer.from(row.body).toString());
  body.causeRef.seq = 1;
  f.journal.db.prepare('UPDATE events SET body = ? WHERE seq = ?').run(Buffer.from(JSON.stringify(body)), row.seq);
  expect(() => f.context.jobStatusReader.listOwned(discussionId)).toThrow('does not cite its accepted outcome');
});

it('preserves discuss ownership output across terminal and live executions', () => {
  const f = fixture();
  const bid = { agent: 'alpha', purpose: 'bid', attempt: 1 } as const;
  const speech = { agent: 'alpha', purpose: 'speech', attempt: 1 } as const;
  const beta = { agent: 'beta', purpose: 'bid', attempt: 1 } as const;
  f.request(PARTICIPANT_JOBS.alpha, bid);
  f.complete(PARTICIPANT_JOBS.alpha, 1);
  f.append('agent.run.bound', { agent: 'alpha', jobId: PARTICIPANT_JOBS.alpha });
  f.request(PARTICIPANT_JOBS.alpha, speech);
  f.complete(PARTICIPANT_JOBS.alpha, 2);
  f.request(PARTICIPANT_JOBS.beta, beta);
  expect(f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toEqual([
    { launch: { jobId: PARTICIPANT_JOBS.alpha, execution: 1, discussionRun: bid, createdAt: EXECUTION_NOW } },
    { launch: { jobId: PARTICIPANT_JOBS.alpha, execution: 2, discussionRun: speech, createdAt: EXECUTION_NOW } },
    { launch: { jobId: PARTICIPANT_JOBS.beta, execution: 1, discussionRun: beta, createdAt: EXECUTION_NOW } },
  ]);
  expect(f.context.jobStatusReader.listOwned('another-discussion')).toEqual([]);
});

it.each([false, true])('validates selected quarantine through discuss after a previous list=%s', (previous) => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(jobId, 1);
  writeFinishingQuarantine(f.journal.db, jobId, 1);
  if (previous) expect(f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toHaveLength(1);
  breakFinishingRetryAuthority(f.journal.db, jobId, 1);
  expect(f.context.jobStatusReader.listOwned('another-discussion')).toEqual([]);
  expect(() => f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toThrow('Recovery retry authority is incomplete');
});

it('lists matching discussion jobs alongside an unrelated malformed owner', () => {
  const f = fixture();
  f.request(PARTICIPANT_JOBS.alpha, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(PARTICIPANT_JOBS.alpha, 1);
  f.request(PARTICIPANT_JOBS.beta, { agent: 'beta', purpose: 'bid', attempt: 1 });
  const expected = f.context.jobStatusReader.listOwned(DISCUSSION_ID);
  expect(expected).toHaveLength(2);
  insertTestJobProjection(f.journal.db, {
    job_id: 'unrelated-history',
    project_root: '/elsewhere',
    phase: 'completed',
  });
  f.journal.db
    .prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?')
    .run('{broken', 'unrelated-history');
  expect(f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toEqual(expected);
});

it.each([
  `{"kind":"discussion","id":"another-discussion","id":${JSON.stringify(DISCUSSION_ID)}}`,
  `{"kind":"discussion","id":${JSON.stringify(DISCUSSION_ID)},"id":"another-discussion"}`,
  `{"kind":"provider-session","kind":"discussion","id":${JSON.stringify(PARTICIPANT_JOBS.alpha)}}`,
  `{"kind":"discussion","kind":"provider-session","id":${JSON.stringify(PARTICIPANT_JOBS.alpha)}}`,
])('matches the owner codec for duplicate keys in %s', (executionOwner) => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(jobId, 1);
  f.request(PARTICIPANT_JOBS.beta, { agent: 'beta', purpose: 'bid', attempt: 1 });
  const baseline = f.context.jobStatusReader.listOwned(DISCUSSION_ID);
  expect(baseline).toHaveLength(2);
  f.journal.db.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run(executionOwner, jobId);
  const owner = decodeProjectionJobExecutionOwner({ job_id: jobId, execution_owner: executionOwner });
  for (const discussionId of [DISCUSSION_ID, 'another-discussion', jobId]) {
    const expected = baseline.filter(({ launch }) =>
      launch.jobId === jobId
        ? owner.kind === 'discussion' && owner.id === discussionId
        : discussionId === DISCUSSION_ID,
    );
    expect(f.context.jobStatusReader.listOwned(discussionId)).toEqual(expected);
  }
});

it('rejects an undecodable discussion candidate before exact owner selection', () => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.journal.db
    .prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?')
    .run(`{"kind":"discussion","id":${JSON.stringify(DISCUSSION_ID)},"id":7}`, jobId);
  expect(() => f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toThrow('could not be decoded');
});

it('matches the owner codec for a lone-surrogate discussion id', () => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(jobId, 1);
  const expected = f.context.jobStatusReader.listOwned(DISCUSSION_ID);
  expect(expected).toHaveLength(1);
  const discussionId = 'discussion-\ud800';
  const executionOwner = JSON.stringify({ kind: 'discussion', id: discussionId });
  f.journal.db.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run(executionOwner, jobId);
  expect(decodeProjectionJobExecutionOwner({ job_id: jobId, execution_owner: executionOwner }).id).toBe(discussionId);
  expect(f.context.jobStatusReader.listOwned(discussionId)).toEqual(expected);
});

it('discards a valid non-matching owner before decoding unrelated corrupt fields', () => {
  const f = fixture();
  const jobId = PARTICIPANT_JOBS.alpha;
  f.request(jobId, { agent: 'alpha', purpose: 'bid', attempt: 1 });
  f.complete(jobId, 1);
  f.request(PARTICIPANT_JOBS.beta, { agent: 'beta', purpose: 'bid', attempt: 1 });
  const expected = f.context.jobStatusReader.listOwned(DISCUSSION_ID).filter(({ launch }) => launch.jobId !== jobId);
  expect(expected).toHaveLength(1);
  const executionOwner = `{"kind":"discussion","id":${JSON.stringify(DISCUSSION_ID)},"id":"another-discussion"}`;
  f.journal.db
    .prepare('UPDATE projection_jobs SET execution_owner = ?, diagnostics = ? WHERE job_id = ?')
    .run(executionOwner, 'invalid-json', jobId);
  expect(f.context.jobStatusReader.listOwned(DISCUSSION_ID)).toEqual(expected);
  expect(() => f.context.jobStatusReader.listOwned('another-discussion')).toThrow('could not be decoded');
});
