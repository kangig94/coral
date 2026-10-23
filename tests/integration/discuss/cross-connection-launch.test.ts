import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { executionHarness, openedJob, requestedExecution, EXECUTION_NOW } from '#tests/helpers/job-executions.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const FIRST_JOB = '10000000-0000-4000-8000-000000000001';
const COMPETING_JOB = '10000000-0000-4000-8000-000000000002';

describe('discussion launch serialization across store connections', () => {
  it('rejects a competing first job before the participant binding is recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-discuss-competing-launch-'));
    const dbPath = join(root, 'store.sqlite');
    const firstDb = newRawDatabase(dbPath);
    applyBundledStoreSchema(firstDb, currentCoralStoreFormat());
    const secondDb = newRawDatabase(dbPath);
    const template = executionHarness(discussRegistry);
    const ctx: AppendContext = template.ctx;
    const discussionId = 'discussion-cross-connection';
    const descriptor = { agent: 'alpha', purpose: 'bid', attempt: 1 } as const;

    try {
      const decided = decideSessionCreate(
        {
          topic: 'Cross-connection launch race',
          min_bid_delay_ms: 0,
          agents: [{ name: 'alpha', persona: 'Alpha', participation: 'required' }],
        },
        { sessionId: discussionId, projectRoot: '/workspace', topic: 'Cross-connection launch race' },
        1,
        EXECUTION_NOW,
        {
          agentExecution: { alpha: { manual: false, provider: 'codex', model: 'gpt-5' } },
          providerScope: TEST_PROVIDER_SCOPE,
        },
      );
      if (!decided.ok) throw new Error(decided.error);
      commit(
        firstDb,
        (c) => {
          for (const event of decided.value) c.append(toJournalInput(event));
          return undefined;
        },
        ctx,
      );

      const launch = (db: typeof firstDb, jobId: string) =>
        commit(
          db,
          (c) => {
            const opened = openedJob({ owner: { kind: 'discussion', id: discussionId } });
            const requested = requestedExecution(1, { pool: 'discuss', discussionRun: descriptor });
            c.append({ ...opened, stream: { kind: 'job', id: jobId } });
            c.append({ ...requested, stream: { kind: 'job', id: jobId } });
            return undefined;
          },
          ctx,
        );

      expect(() => launch(firstDb, FIRST_JOB)).not.toThrow();
      expect(() => launch(secondDb, COMPETING_JOB)).toThrowError(
        expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
      );
      expect(
        secondDb
          .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM events WHERE stream_id = ?')
          .get(COMPETING_JOB),
      ).toEqual({ count: 0 });
      expect(
        firstDb
          .prepare<
            [string],
            { job_id: string; execution: number }
          >('SELECT job_id, execution FROM projection_jobs WHERE job_id = ?')
          .get(FIRST_JOB),
      ).toEqual({ job_id: FIRST_JOB, execution: 1 });
    } finally {
      template.db.close();
      secondDb.close();
      firstDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
