import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunch } from '#src/jobs/records.js';
import { jobLaunchRequestedEvent, JobStore } from '#src/jobs/store.js';
import { SessionManager } from '#src/sessions/shell.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobInputs } from '#tests/helpers/job-commits.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { defaultAgentExecution, defaultAgents } from '#tests/unit/discuss/shell/discuss-test-helpers.js';

describe('discussion launch serialization across store connections', () => {
  it('rejects a competing child after another connection commits against a journal-created provider session', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-discuss-competing-launch-'));
    const dbPath = join(root, 'store.sqlite');
    const firstDb = newRawDatabase(dbPath);
    applyBundledStoreSchema(firstDb);
    const secondDb = newRawDatabase(dbPath);
    const runtime = new SimulationRuntime();
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const firstStore = new JobStore('discussion-test', runtime, bodyCodec, {
      db: firstDb,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    const secondStore = new JobStore('discussion-test', runtime, bodyCodec, {
      db: secondDb,
      reducers,
      providers: permissiveProviderLookupPort,
    });

    try {
      const firstSessions = new SessionManager(root, runtime, (cb) => firstStore.commit(cb), undefined, firstDb);
      const secondSessions = new SessionManager(root, runtime, (cb) => secondStore.commit(cb), undefined, secondDb);
      const prepareSession = (sessions: SessionManager, name: string) =>
        sessions.prepare({
          binding: TEST_CODEX_BINDING,
          name,
          cwd: root,
          projectRoot: root,
          backendNamespace: 'discussion-test',
          retention: 'retain',
        });
      const firstSession = prepareSession(firstSessions, 'alpha-first-session');
      const competingSession = prepareSession(secondSessions, 'alpha-competing-session');

      const agents = defaultAgents();
      const decided = decideSessionCreate(
        { topic: 'Cross-connection launch race', agents, min_bid_delay_ms: 0 },
        {
          sessionId: 'discussion-cross-connection',
          projectRoot: root,
          topic: 'Cross-connection launch race',
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
      commitJobInputs(firstStore, [toJournalInput(created)]);

      const launch = (jobId: string, sessionId: string): JobLaunch => ({
        jobId,
        owner: { kind: 'discussion', id: created.sessionId },
        discussionRun: { agent: 'alpha', purpose: 'bid', attempt: 1 },
        sessionId,
        provider: 'codex',
        projectRoot: root,
        backendNamespace: 'discussion-test',
        jobKind: 'provider',
        pool: 'discuss',
        enqueueSequence: 0,
        providerAction: 'exec',
        request: { prompt: 'bid', cwd: root, bypassPermissions: true, coralEnv: {} },
        createdAt: '2026-07-22T00:00:01.000Z',
      });

      expect(() =>
        firstStore.commit((c) => {
          firstSessions.appendPreparedClaim(c, firstSession, 'alpha-first');
          c.append(jobLaunchRequestedEvent('alpha-first', launch('alpha-first', firstSession.sessionId)));
          return undefined;
        }),
      ).not.toThrow();
      expect(
        firstDb
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM events WHERE type = 'session.opened' AND stream_id = ?")
          .get(firstSession.sessionId),
      ).toEqual({ count: 1 });
      expect(() =>
        secondStore.commit((c) => {
          secondSessions.appendPreparedClaim(c, competingSession, 'alpha-competing');
          c.append(jobLaunchRequestedEvent('alpha-competing', launch('alpha-competing', competingSession.sessionId)));
          return undefined;
        }),
      ).toThrowError(expect.objectContaining({ code: 'discussion_job_launch_conflict' }));
      expect(secondStore.readStatus('alpha-competing')).toBeNull();
      expect(
        secondDb
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM events WHERE type = 'session.opened' AND stream_id = ?")
          .get(competingSession.sessionId),
      ).toEqual({ count: 0 });
      expect(firstStore.readStatus('alpha-first')).toMatchObject({
        owner: { kind: 'discussion', id: created.sessionId },
        sessionId: firstSession.sessionId,
      });
    } finally {
      secondDb.close();
      firstDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
