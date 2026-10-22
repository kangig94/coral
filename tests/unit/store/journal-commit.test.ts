import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';
import { TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '../../helpers/canonical-work-dir.js';

import { decodeEventBody } from '#src/store/body-codec.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { WorkflowDeclaredBody } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobExecutionRequestedBody } from '#src/jobs/launch.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection, testJobConversation, testConversationOpenedInput } from '#tests/helpers/session.js';

const JOB_A = '10000000-0000-4000-8000-000000000001';
const JOB_B = '10000000-0000-4000-8000-000000000002';
const JOB_BEFORE_OPEN = '10000000-0000-4000-8000-000000000003';

const NOW = new Date('2026-04-19T00:00:00.000Z');
const TS_OVERRIDE = '2026-04-18T12:00:00.000Z';

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  };
}

function countEvents(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

function bodiesBySeq(db: Database): Map<number, unknown> {
  const rows = db.prepare('SELECT seq, body FROM events ORDER BY seq ASC').all() as Array<{
    seq: number;
    body: Buffer;
  }>;
  return new Map(rows.map((row) => [row.seq, decodeEventBody(row.body)]));
}

function launchInput(jobId: string): CoralEventInput<JobExecutionRequestedBody> {
  return {
    type: 'job.execution.requested',
    stream: { kind: 'job', id: jobId },
    refs: { jobId },
    body: {
      execution: 1,
      input: `prompt for ${jobId}`,
      action: 'exec',
      pool: 'default',
      enqueueSequence: 0,
      coralEnv: {},
      backendNamespace: 'tests',
      createdAt: NOW.toISOString(),
    },
  };
}

function workflowPlanInput(workflowId: string): CoralEventInput<WorkflowDeclaredBody> {
  return {
    type: 'workflow.plan.declared',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    body: {
      plan: {
        slots: [
          {
            slotId: `${workflowId}:0:0`,
            dependencies: [],
            provider: 'codex',
            instruction: 'test workflow slot',
          },
        ],
      },
      providerScope: TEST_PROVIDER_SCOPE,
    },
  };
}

describe('journal commit primitive', () => {
  it('resolves tokens before schema parse and preserves source stream for cross-stream terminals', () => {
    const db = createDb();
    try {
      for (const jobId of [JOB_A, JOB_B]) {
        seedTestSessionProjection(db, {
          jobId,
          provider: 'codex',
          projectRoot: fixtureCanonicalWorkDir(`/workspace/${jobId}`),
        });
      }
      const appended = commit(
        db,
        (c) => {
          const jobACause = c.append(launchInput(JOB_A));
          c.append(launchInput(JOB_B));
          c.append({
            type: 'job.execution.outcome.accepted',
            stream: { kind: 'job', id: JOB_B },
            refs: { jobId: JOB_B },
            body: {
              execution: 1,
              terminal: {
                outcome: { kind: 'failed', causeRef: jobACause },
                durationMs: 1,
                content: 'failed',
              },
            },
          });
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.seq)).toEqual([3, 4, 5]);
      expect(appended[2]?.body).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: JOB_A }, seq: 3 },
          },
        },
      });
      expect(bodiesBySeq(db).get(5)).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: JOB_A }, seq: 3 },
          },
        },
      });
    } finally {
      db.close();
    }
  });

  it('rolls back collected events when the closure throws', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(workflowPlanInput('workflow-rollback'));
            throw new Error('closure failure');
          },
          ctx(),
        ),
      ).toThrow(/closure failure/);

      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('reserves explicit contiguous seqs and applies tsOverride only to the owning event', () => {
    const db = createDb();
    try {
      commit(
        db,
        (c) => {
          c.append(workflowPlanInput('workflow-existing'));
          return undefined;
        },
        ctx(),
      );

      const appended = commit(
        db,
        (c) => {
          c.append({ ...workflowPlanInput('workflow-seq-a'), tsOverride: TS_OVERRIDE });
          c.append(workflowPlanInput('workflow-seq-b'));
          c.append(workflowPlanInput('workflow-seq-c'));
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.seq)).toEqual([2, 3, 4]);
      expect(appended.map((event) => event.ts)).toEqual([TS_OVERRIDE, NOW.toISOString(), NOW.toISOString()]);
      expect(
        (db.prepare('SELECT seq FROM events ORDER BY seq ASC').all() as Array<{ seq: number }>).map((row) => row.seq),
      ).toEqual([1, 2, 3, 4]);
    } finally {
      db.close();
    }
  });

  it('rolls back a batch whose execution request precedes its job opening', () => {
    const db = createDb();
    const entry = testJobConversation(JOB_BEFORE_OPEN);
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(launchInput(entry.jobId));
            c.append(testConversationOpenedInput(entry));
          },
          ctx(),
        ),
      ).toThrow(/job.opened must be first/u);
      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });
});
