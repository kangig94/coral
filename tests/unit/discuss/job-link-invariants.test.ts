import { describe, expect, it } from 'vitest';

import { makeEvent, type DiscussDomainEvent } from '#src/discuss/events.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import { readSessionEvents } from '#src/discuss/shell/persistence.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobLaunchRequestedEvent } from '#src/jobs/store.js';
import type { JobLaunch } from '#src/jobs/records.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { commitJobInputs } from '#tests/helpers/job-commits.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import {
  createDiscussHarness,
  defaultAgentExecution,
  defaultAgents,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

type OwnedJobOptions = {
  jobId: string;
  sessionId: string;
  agent?: string;
  purpose?: 'bid' | 'speech';
  attempt?: number;
  provider?: 'claude' | 'codex';
};

function ownedLaunch(harness: DiscussHarness, options: OwnedJobOptions): JobLaunch {
  const provider = options.provider ?? 'codex';
  seedTestSessionProjection(harness.progressStore.getDb(), {
    sessionId: options.sessionId,
    provider,
    projectRoot: harness.projectRoot,
    backendNamespace: harness.progressStore.getNamespace(),
    activeJobId: options.jobId,
  });
  return {
    jobId: options.jobId,
    owner: { kind: 'discussion', id: 'discussion-link-test' },
    discussionRun: {
      agent: options.agent ?? 'alpha',
      purpose: options.purpose ?? 'bid',
      attempt: options.attempt ?? 1,
    },
    sessionId: options.sessionId,
    provider,
    projectRoot: harness.projectRoot,
    backendNamespace: harness.progressStore.getNamespace(),
    jobKind: 'provider',
    pool: 'discuss',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: { prompt: 'linked run', cwd: harness.projectRoot, bypassPermissions: true, coralEnv: {} },
    createdAt: '2026-07-22T00:00:01.000Z',
  };
}

function seedOwnedJob(harness: DiscussHarness, options: OwnedJobOptions): void {
  harness.progressStore.appendLaunchRequested(options.jobId, ownedLaunch(harness, options));
}

async function createdHarness(): Promise<DiscussHarness> {
  const harness = createDiscussHarness();
  await persistSession(harness, { sessionId: 'discussion-link-test' });
  return harness;
}

function sessionCreatedEvent(harness: DiscussHarness): DiscussDomainEvent {
  const agents = defaultAgents();
  const decided = decideSessionCreate(
    { topic: 'Atomic discussion linkage', agents, min_bid_delay_ms: 0 },
    {
      sessionId: 'discussion-link-test',
      projectRoot: harness.projectRoot,
      topic: 'Atomic discussion linkage',
    },
    1,
    '2026-07-22T00:00:00.000Z',
    {
      agentExecution: defaultAgentExecution(agents),
      providerScope: TEST_PROVIDER_SCOPE,
    },
  );
  if (!decided.ok) throw new Error(decided.error);
  const created = decided.value[0];
  if (created === undefined) throw new Error('missing discussion creation event');
  return created;
}

describe('discussion-owned job linkage invariants', () => {
  it('atomically rejects linkage after same-batch creation when no owned launch authorizes it', () => {
    const harness = createDiscussHarness();
    const created = sessionCreatedEvent(harness);

    expect(() =>
      commitJobInputs(harness.progressStore, [
        toJournalInput(created),
        toJournalInput(
          makeEvent(
            created.sessionId,
            created.projectRoot,
            created.topic,
            2,
            'agent.run.bound',
            '2026-07-22T00:00:01.000Z',
            { agent: 'alpha', executionSessionId: 'unauthorized-session' },
          ),
        ),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'discuss_job_link_invalid' }));
    expect(harness.store.load(created.sessionId)).toBeNull();
  });

  it('atomically rejects assigning one provider session to different discussion agents', async () => {
    const harness = await createdHarness();
    const alpha = ownedLaunch(harness, {
      jobId: 'shared-alpha-job',
      sessionId: 'shared-session',
      agent: 'alpha',
    });
    const beta = ownedLaunch(harness, {
      jobId: 'shared-beta-job',
      sessionId: 'shared-session',
      agent: 'beta',
    });

    expect(() =>
      commitJobInputs(harness.progressStore, [
        jobLaunchRequestedEvent('shared-alpha-job', alpha),
        jobLaunchRequestedEvent('shared-beta-job', beta),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
    expect(harness.progressStore.readStatus('shared-alpha-job')).toBeNull();
    expect(harness.progressStore.readStatus('shared-beta-job')).toBeNull();
  });

  it('rejects arbitrary provider session and job ids at the discussion append boundary', async () => {
    const harness = await createdHarness();
    const snapshot = harness.store.load('discussion-link-test');
    if (snapshot === null) throw new Error('missing discussion fixture');

    await expect(
      harness.store.append('discussion-link-test', snapshot.lastAppliedSeq, [
        makeEvent(
          snapshot.sessionId,
          snapshot.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'agent.run.bound',
          '2026-07-22T00:00:02.000Z',
          { agent: 'alpha', executionSessionId: 'arbitrary-session' },
        ),
      ]),
    ).rejects.toMatchObject({ code: 'discuss_job_link_invalid' });

    seedOwnedJob(harness, { jobId: 'real-job', sessionId: 'real-session' });
    const bound = await harness.store.append('discussion-link-test', snapshot.lastAppliedSeq, [
      makeEvent(
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        snapshot.lastAppliedSeq + 1,
        'agent.run.bound',
        '2026-07-22T00:00:02.000Z',
        { agent: 'alpha', executionSessionId: 'real-session' },
      ),
    ]);
    await expect(
      harness.store.append('discussion-link-test', bound.lastAppliedSeq, [
        makeEvent(
          bound.sessionId,
          bound.projectRoot,
          bound.state.topic,
          bound.lastAppliedSeq + 1,
          'agent.job.started',
          '2026-07-22T00:00:03.000Z',
          { agent: 'alpha', jobId: 'arbitrary-job', purpose: 'bid', attempt: 1 },
        ),
      ]),
    ).rejects.toMatchObject({ code: 'discuss_job_link_invalid' });
  });

  it('reconciles both launch crash windows deterministically and remains idempotent', async () => {
    const harness = await createdHarness();
    seedOwnedJob(harness, { jobId: 'crash-job', sessionId: 'crash-session' });

    const recover = () =>
      recoverPersistedSessionsFromStore(
        harness.store,
        () => harness.context,
        () => harness.ctx,
      );
    await expect(recover()).resolves.toHaveLength(1);
    expect(
      readSessionEvents(harness.context, 'discussion-link-test')
        .map((event) => event.kind)
        .slice(-2),
    ).toEqual(['agent.run.bound', 'agent.job.started']);

    await expect(recover()).resolves.toHaveLength(1);
    const events = readSessionEvents(harness.context, 'discussion-link-test');
    expect(events.filter((event) => event.kind === 'agent.run.bound')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'agent.job.started')).toHaveLength(1);

    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const before = harness.store.load('discussion-link-test');
    rebuildProjections({
      db: harness.progressStore.getDb(),
      cutoffSeq:
        harness.progressStore
          .getDb()
          .prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM events')
          .get()?.seq ?? 0,
      reducers,
      bodyCodec: createEventBodyCodec(),
    });
    expect(harness.store.load('discussion-link-test')).toStrictEqual(before);
  });
});
