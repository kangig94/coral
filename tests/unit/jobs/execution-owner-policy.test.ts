import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderScope } from '#src/infra/provider-scope.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { readProjectionDiscuss } from '#src/discuss/projections.js';
import type { ExecutionOwner } from '#src/runtime/execution-owner.js';
import {
  EXECUTION_JOB_ID as jobId,
  OTHER_EXECUTION_JOB_ID as otherJobId,
  executionHarness,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';

const workflowId = 'workflow-owner';
const discussionId = 'discussion-owner';
const slotId = `${workflowId}:0:0`;
const descriptor = { agent: 'alpha', purpose: 'speech', attempt: 1 } as const;
const scope: ProviderScope = {
  origin: 'caller',
  profiles: [{ provider: 'codex', profile: { canonicalLocation: '/test/codex', routing: { kind: 'home' } } }],
};
const harnesses: ReturnType<typeof executionHarness>[] = [];
function harness() {
  const h = executionHarness(workflowRegistry, discussRegistry);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.db.close();
});

function seedWorkflow(h: ReturnType<typeof harness>, lifecycle = 'active') {
  h.db
    .prepare(
      'INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq) VALUES (?, ?, ?, ?, 0)',
    )
    .run(
      workflowId,
      JSON.stringify({ slots: [{ slotId, dependencies: [], provider: 'codex', instruction: 'work' }] }),
      JSON.stringify(scope),
      lifecycle,
    );
}

function seedDiscussion(h: ReturnType<typeof harness>) {
  h.append({
    type: 'discuss.session.created',
    stream: { kind: 'discuss', id: discussionId },
    project: '/workspace',
    body: {
      sourceSeq: 1,
      input: {
        topic: 'test',
        agents: [{ name: 'alpha', persona: 'Alpha', participation: 'required' }],
        min_bid_delay_ms: 0,
      },
      config: { bidThreshold: 0, maxEpochs: 2, quotaPerEpoch: 2 },
      agentExecution: { alpha: { manual: false, provider: 'codex', model: 'fake' } },
      providerScope: scope,
    },
  });
}

function first(h: ReturnType<typeof harness>, owner: ExecutionOwner) {
  h.append(
    openedJob({ owner, ...(owner.kind === 'workflow' ? { workflowSlotId: slotId } : {}) }),
    requestedExecution(1, owner.kind === 'discussion' ? { discussionRun: descriptor } : {}),
  );
  if (owner.kind === 'discussion')
    h.append({
      type: 'discuss.agent.run.bound',
      stream: { kind: 'discuss', id: discussionId },
      body: { agent: 'alpha', jobId, sourceSeq: 2 },
    });
  h.complete();
}

function next(owner: ExecutionOwner) {
  return requestedExecution(2, {
    originatingClientMessageId: owner.kind === 'provider-session' ? 'send-attempt' : undefined,
    ...(owner.kind === 'discussion' ? { discussionRun: { ...descriptor, attempt: 2 } } : {}),
  });
}

describe('execution continuation owner policy', () => {
  it.each(['active', 'draining'])('allows workflow continuation while %s and its slot names this job', (lifecycle) => {
    const h = harness();
    seedWorkflow(h, lifecycle);
    const owner = { kind: 'workflow', id: workflowId } as const;
    first(h, owner);
    expect(() => h.append(next(owner))).not.toThrow();
  });

  it.each(['completed', 'failed', 'aborted', 'faulted'])(
    'refuses workflow #2 after the owner becomes %s',
    (lifecycle) => {
      const h = harness();
      seedWorkflow(h);
      const owner = { kind: 'workflow', id: workflowId } as const;
      first(h, owner);
      h.db.prepare('UPDATE projection_workflows SET lifecycle = ? WHERE workflow_id = ?').run(lifecycle, workflowId);
      expect(() => h.append(next(owner))).toThrowError(expect.objectContaining({ code: 'workflow_owner_terminal' }));
      expect(h.events().filter((event) => event.type === 'job.execution.requested')).toHaveLength(1);
    },
  );

  it('refuses workflow #2 when its owning slot no longer names this job', () => {
    const h = harness();
    seedWorkflow(h);
    const owner = { kind: 'workflow', id: workflowId } as const;
    first(h, owner);
    h.db
      .prepare('UPDATE projection_workflows SET plan = ? WHERE workflow_id = ?')
      .run(JSON.stringify({ slots: [] }), workflowId);
    expect(() => h.append(next(owner))).toThrowError(expect.objectContaining({ code: 'workflow_slot_job_mismatch' }));
  });

  it('refuses workflow #2 when closure appears later in the same batch', () => {
    const h = harness();
    seedWorkflow(h);
    const owner = { kind: 'workflow', id: workflowId } as const;
    first(h, owner);
    expect(() =>
      h.append(next(owner), {
        type: 'workflow.completed',
        stream: { kind: 'workflow', id: workflowId },
        body: { outcome: 'completed', stepDetails: [] },
      }),
    ).toThrowError(expect.objectContaining({ code: 'workflow_owner_terminal' }));
  });

  it('refuses a second job for an already bound workflow slot', () => {
    const h = harness();
    seedWorkflow(h);
    const owner = { kind: 'workflow', id: workflowId } as const;
    first(h, owner);
    expect(() =>
      h.append({ ...openedJob({ owner, workflowSlotId: slotId }), stream: { kind: 'job', id: otherJobId } }),
    ).toThrowError(expect.objectContaining({ code: 'workflow_slot_job_conflict' }));
  });

  it('allows discussion #2 only with an open discussion and the same agent’s bound job', () => {
    const h = harness();
    seedDiscussion(h);
    const owner = { kind: 'discussion', id: discussionId } as const;
    first(h, owner);
    expect(() => h.append(next(owner))).not.toThrow();
  });

  it.each(['closed', 'unbound', 'other-job', 'other-agent'] as const)(
    'refuses discussion #2 for %s authority',
    (reason) => {
      const h = harness();
      seedDiscussion(h);
      const owner = { kind: 'discussion', id: discussionId } as const;
      first(h, owner);
      const snapshot = readProjectionDiscuss(h.db, discussionId)!.state;
      if (reason === 'closed') snapshot.state.status = 'ended';
      else snapshot.runtime.agentRuns.alpha.jobId = reason === 'unbound' ? undefined : otherJobId;
      if (reason === 'other-agent') snapshot.runtime.agentRuns.beta = { ...snapshot.runtime.agentRuns.alpha, jobId };
      h.db
        .prepare('UPDATE projection_discuss SET state = ? WHERE discuss_id = ?')
        .run(JSON.stringify(snapshot), discussionId);
      expect(() => h.append(next(owner))).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
    },
  );

  it('refuses discussion #2 after same-batch closure, regardless of order', () => {
    const h = harness();
    seedDiscussion(h);
    const owner = { kind: 'discussion', id: discussionId } as const;
    first(h, owner);
    expect(() =>
      h.append(next(owner), {
        type: 'discuss.session.ended',
        stream: { kind: 'discuss', id: discussionId },
        body: { sourceSeq: 3 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
  });

  it('admits provider-session #2 through jobs send and refuses an unbound continuation', () => {
    const h = harness();
    const owner = { kind: 'provider-session', id: jobId } as const;
    first(h, owner);
    expect(() => h.append(requestedExecution(2, { originatingClientMessageId: undefined }))).toThrowError(
      expect.objectContaining({ code: 'job_execution_order_violation' }),
    );
    expect(() => h.append(next(owner))).not.toThrow();
  });

  it('never admits system-task #2, including a request with a jobs send message identity', () => {
    const h = harness();
    const owner = { kind: 'system-task', id: 'system' } as const;
    h.append(
      {
        type: 'job.opened',
        stream: { kind: 'job', id: jobId },
        body: { jobKind: 'kb', owner, projectRoot: '/workspace', createdAt: '2026-10-22T00:00:00.000Z' },
      },
      requestedExecution(1, { input: { operation: 'kb.reindex', request: {} } }),
    );
    h.complete();
    expect(() => h.append(next(owner))).toThrowError(
      expect.objectContaining({ code: 'job_execution_order_violation' }),
    );
    expect(() => h.append(requestedExecution(2))).toThrowError(
      expect.objectContaining({ code: 'job_execution_order_violation' }),
    );
  });
});
