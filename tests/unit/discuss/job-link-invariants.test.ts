import { afterEach, describe, expect, it } from 'vitest';

import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { makeEvent } from '#src/discuss/events.js';
import { reconcileDiscussionOwnedJobs } from '#src/discuss/shell/recovery.js';
import { runPlainTurn } from '#src/discuss/shell/runtime-build.js';
import { readProjectionDiscuss } from '#src/discuss/projections.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { executionHarness, EXECUTION_NOW } from '#tests/helpers/job-executions.js';
import { discussionExecutionFixture, DISCUSSION_ID, PARTICIPANT_JOBS } from '#tests/unit/discuss/execution-fixture.js';

const fixtures: ReturnType<typeof discussionExecutionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

function fixture() {
  const f = discussionExecutionFixture();
  fixtures.push(f);
  return f;
}

const descriptor = { agent: 'alpha', purpose: 'bid', attempt: 1 } as const;
const jobId = PARTICIPANT_JOBS.alpha;

function start(f: ReturnType<typeof fixture>, execution = 1) {
  return f.append('agent.job.started', { ...descriptor, jobId, execution });
}

function bind(f: ReturnType<typeof fixture>) {
  f.append('agent.run.bound', { agent: 'alpha', jobId });
}

async function runTurn(f: ReturnType<typeof fixture>) {
  await runPlainTurn(f.context, {
    agentName: 'alpha',
    sessionId: DISCUSSION_ID,
    provider: 'codex',
    model: 'gpt-5',
    prompt: 'Bid.',
    instruction: 'Participate.',
    cwd: f.invocation.projectRoot,
    invocationCtx: f.invocation,
    purpose: 'bid',
  });
}

describe('discussion-owned job linkage invariants', () => {
  it('atomically rejects arbitrary job linkage after same-batch creation', () => {
    const f = fixture();
    const empty = executionHarness(discussRegistry);
    try {
      const created = f.events()[0]!;
      expect(() =>
        empty.append(
          toJournalInput(created),
          toJournalInput(
            makeEvent(DISCUSSION_ID, f.invocation.projectRoot, created.topic, 2, 'agent.run.bound', EXECUTION_NOW, {
              agent: 'alpha',
              jobId,
            }),
          ),
        ),
      ).toThrowError(expect.objectContaining({ code: 'discuss_job_link_invalid' }));
      expect(readProjectionDiscuss(empty.db, DISCUSSION_ID)).toBeNull();
    } finally {
      empty.db.close();
    }
  });

  it('refuses a second job for an agent even before its first run binding is recorded', () => {
    const f = fixture();
    f.request(jobId, descriptor);
    expect(() => f.request(PARTICIPANT_JOBS.beta, descriptor)).toThrowError(
      expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
    );
    expect(f.store.readStatus(PARTICIPANT_JOBS.beta)).toBeNull();
  });

  it('rejects assigning one job to another participant or rebinding its participant', () => {
    const f = fixture();
    f.request(jobId, descriptor);
    bind(f);
    expect(() => f.append('agent.run.bound', { agent: 'beta', jobId })).toThrowError(
      expect.objectContaining({ code: 'discuss_job_link_invalid' }),
    );
    f.request(PARTICIPANT_JOBS.beta, { agent: 'beta', purpose: 'bid', attempt: 1 });
    expect(() => f.append('agent.run.bound', { agent: 'alpha', jobId: PARTICIPANT_JOBS.beta })).toThrowError(
      expect.objectContaining({ code: 'discuss_job_link_invalid' }),
    );
    expect(f.snapshot().runtime.agentRuns.alpha.jobId).toBe(jobId);
  });

  it('validates each execution descriptor and refuses a duplicate start after its finish', async () => {
    const f = fixture();
    f.request(jobId, descriptor);
    bind(f);
    expect(() => start(f, 2)).toThrowError(expect.objectContaining({ code: 'discuss_job_link_invalid' }));
    expect(() => f.append('agent.job.started', { ...descriptor, jobId, execution: 1, purpose: 'speech' })).toThrowError(
      expect.objectContaining({ code: 'discuss_job_link_invalid' }),
    );
    expect(() => f.append('agent.job.started', { ...descriptor, jobId, execution: 1, attempt: 2 })).toThrowError(
      expect.objectContaining({ code: 'discuss_job_link_invalid' }),
    );
    start(f);
    f.complete(jobId, 1);
    f.append('agent.job.finished', { agent: 'alpha', jobId, execution: 1, attempt: 1, outcome: 'completed' });
    expect(() => start(f)).toThrowError(expect.objectContaining({ code: 'discuss_job_link_invalid' }));
    f.request(jobId, descriptor);
    expect(() => start(f, 2)).not.toThrow();
  });

  it('allows continuation only for the bound agent in a live discussion', async () => {
    const f = fixture();
    f.request(jobId, descriptor);
    f.complete(jobId, 1);
    expect(() => f.request(jobId, descriptor)).toThrowError(
      expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
    );
    bind(f);
    expect(() => f.request(jobId, { agent: 'beta', purpose: 'bid', attempt: 1 })).toThrowError(
      expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
    );
    f.append('session.ended', { force: true, reason: 'complete' });
    f.append('session.synthesized', { synthesis: 'Done.' });
    expect(() => f.request(jobId, descriptor)).toThrowError(
      expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
    );
  });

  it.each([false, true])(
    'reconciles the first execution idempotently when binding already exists: %s',
    async (bound) => {
      const f = fixture();
      f.request(jobId, descriptor);
      if (bound) bind(f);
      await reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID);
      await reconcileDiscussionOwnedJobs(f.context, DISCUSSION_ID);
      expect(f.events().filter((event) => event.kind === 'agent.run.bound')).toHaveLength(1);
      expect(
        f
          .events()
          .filter((event) => event.kind === 'agent.job.started')
          .map((event) => event.payload),
      ).toEqual([{ ...descriptor, jobId, execution: 1 }]);
      expect(f.snapshot().runtime.agentRuns.alpha).toMatchObject({ jobId, currentJobId: jobId, currentExecution: 1 });
    },
  );

  it('rebuilds the same discussion state after two executions', async () => {
    const f = fixture();
    await runTurn(f);
    await runTurn(f);
    const before = f.snapshot();
    rebuildProjections({
      db: f.journal.db,
      cutoffSeq: f.journal.db.prepare<[], { seq: number }>('SELECT MAX(seq) AS seq FROM events').get()!.seq,
      reducers: f.journal.ctx.reducers,
      bodyCodec: f.journal.ctx.bodyCodec,
    });
    expect(f.snapshot()).toEqual(before);
  });
});
