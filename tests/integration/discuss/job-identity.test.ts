import { describe, expect, it } from 'vitest';

import { readDiscussEventLog } from '#src/discuss/read-queries.js';
import { listProjectionDiscussSnapshots, readProjectionDiscuss } from '#src/discuss/projections.js';
import { toJournalInput } from '#src/discuss/event-registry.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { createDiscussContextRegistry, getOrCreate } from '#src/discuss/shell/live-registry.js';
import { runPlainTurn } from '#src/discuss/shell/runtime-build.js';
import { DiscussSessionStore } from '#src/discuss/shell/session-store.js';
import { discussionJobPurposes } from '#src/jobs/discussion-run.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

describe('discussion participant conversation identity', () => {
  it('uses one job per participant for bids, speeches, evaluations, follow-ups and synthesis', async () => {
    const f = conversationIdentityFixture();
    const discussionId = 'identity-discussion';
    const agents = [
      { name: 'alpha', persona: 'Alpha', provider: 'codex', participation: 'required' as const },
      { name: 'beta', persona: 'Beta', provider: 'claude', participation: 'required' as const },
    ];
    const decided = decideSessionCreate(
      {
        topic: 'Identity',
        agents: agents.map(({ name, persona, participation }) => ({ name, persona, participation })),
        min_bid_delay_ms: 0,
      },
      { sessionId: discussionId, projectRoot: f.ctx.projectRoot, topic: 'Identity' },
      1,
      new Date(f.runtime.time.now()).toISOString(),
      {
        agentExecution: Object.fromEntries(
          agents.map((agent) => [agent.name, { manual: false, provider: agent.provider, model: 'fixture-model' }]),
        ),
        providerScope: TEST_PROVIDER_SCOPE,
      },
    );
    if (!decided.ok) throw new Error(decided.error);
    const store = new DiscussSessionStore(f.ctx.projectRoot, {
      journal: {
        append: (_source, _snapshot, events) => {
          f.commit((commit) => {
            for (const event of events) commit.append(toJournalInput(event));
            return undefined;
          });
        },
        readSnapshot: (id) => readProjectionDiscuss(f.db, id)?.state ?? null,
        readEvents: (id) => readDiscussEventLog(f.db, id, f.readCtx),
        listSnapshots: () => listProjectionDiscussSnapshots(f.db).map((row) => row.state),
        listSources: () => [f.ctx.projectRoot],
      },
    });

    try {
      await store.append(discussionId, null, decided.value);
      const context = getOrCreate(createDiscussContextRegistry(), f.ctx.projectRoot, f.service, store, {
        runtime: {
          ids: f.runtime.ids,
          env: f.runtime.env,
          time: f.runtime.time,
          storage: f.runtime.storage,
          projectData: f.runtime.paths.projectData.bind(f.runtime.paths),
        },
        providerRegistry: f.providers,
        jobStatusReader: {
          read: (id) => f.store.readStatus(id),
          readExit: () => null,
          listOwned: () => [],
        },
      });
      const jobs = new Map<string, string>();
      for (const purpose of discussionJobPurposes) {
        for (const agent of agents) {
          const result = await f.drive(
            runPlainTurn(context, {
              agentName: agent.name,
              sessionId: discussionId,
              provider: agent.provider,
              model: 'fixture-model',
              prompt: `${agent.name} ${purpose}`,
              instruction: agent.persona,
              cwd: f.ctx.projectRoot,
              invocationCtx: f.ctx,
              purpose,
              timeoutMs: 10_000,
            }),
          );
          expect(result.content).toContain(`${agent.name} ${purpose}`);
          const jobId = store.load(discussionId)?.runtime.agentRuns[agent.name]?.jobId;
          expect(jobId).toBeDefined();
          if (jobId === undefined) throw new Error('Participant must be bound to its conversation job.');
          expect(jobId).toBe(jobs.get(agent.name) ?? jobId);
          jobs.set(agent.name, jobId);
        }
      }

      expect(new Set(jobs.values()).size).toBe(2);
      expect(f.store.listJobIds().sort()).toEqual([...jobs.values()].sort());
      for (const jobId of jobs.values()) f.assertIdentity(jobId, [1, 2, 3, 4, 5]);
    } finally {
      store.dispose();
      await f.dispose();
    }
  });
});
