import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';
import { TEST_CLAUDE_BINDING, TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';

import { decodeEventBody } from '#src/store/body-codec.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { WorkflowDeclaredBody } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type { SessionClaimedBody } from '#src/sessions/event-bodies.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

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
    reducers: composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry),
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

function launchBody(jobId: string, sessionId = `session-${jobId}`): JobLaunchRequestBody {
  return {
    sessionId,
    owner: { kind: 'provider-session', id: sessionId },
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: `/workspace/${sessionId}`,
    backendNamespace: 'tests',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    request: {
      prompt: `prompt for ${jobId}`,
      cwd: `/workspace/${sessionId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW.toISOString(),
  };
}

function launchInput(jobId: string, sessionId = `session-${jobId}`): CoralEventInput<JobLaunchRequestBody> {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId },
    body: launchBody(jobId, sessionId),
  };
}

function sessionEntry(sessionId: string): ProviderSession {
  return {
    sessionId,
    binding: TEST_CODEX_BINDING,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    cwd: `/workspace/${sessionId}`,
    projectRoot: `/workspace/${sessionId}`,
    backendNamespace: 'tests',
    providerContinuity: null,
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
}

function claimInput(entry: ProviderSession, jobId: string): CoralEventInput<SessionClaimedBody> {
  const claimed: ProviderSession = {
    ...entry,
    activeJobId: jobId,
    lastUsedAt: NOW.toISOString(),
    version: entry.version + 1,
  };
  return {
    type: 'session.claimed',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    body: { entry: claimed, jobId },
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
      for (const sessionId of ['session-a', 'session-b']) {
        seedTestSessionProjection(db, {
          sessionId,
          provider: 'codex',
          projectRoot: `/workspace/${sessionId}`,
          activeJobId: sessionId.replace('session-', 'job-'),
        });
      }
      const appended = commit(
        db,
        (c) => {
          const jobACause = c.append(launchInput('job-a', 'session-a'));
          c.append(launchInput('job-b', 'session-b'));
          c.append({
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-b' },
            refs: { jobId: 'job-b', sessionId: 'session-b' },
            body: {
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

      expect(appended.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(appended[2]?.body).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: 'job-a' }, seq: 1 },
          },
        },
      });
      expect(bodiesBySeq(db).get(3)).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'job', id: 'job-a' }, seq: 1 },
          },
        },
      });
    } finally {
      db.close();
    }
  });

  it('rejects residual tokens before schema validation or body encoding, including z.unknown detail', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            const cause = c.append(workflowPlanInput('workflow-hidden-token'));
            const detail: unknown = { causeRef: cause };
            c.append({
              type: 'job.progress.emitted',
              stream: { kind: 'job', id: 'job-hidden-token' },
              refs: { jobId: 'job-hidden-token' },
              body: {
                kind: 'domain',
                stage: 'hosted_kb_operation_failed',
                message: 'hidden token',
                detail,
              },
            });
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(
        /CauseRefToken is not allowed at body\.detail\.causeRef\. Tokens may appear only at: workflow\.completed:body\.causeRef, job\.terminal\.recorded:body\.terminal\.outcome\.causeRef\. Move the token to a pinned path or pass a resolved CauseRef instead\./,
      );

      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects residual tokens hidden behind any casts at runtime', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            const cause = c.append(workflowPlanInput('workflow-any-hidden-token'));
            const body = {
              kind: 'domain',
              stage: 'hosted_kb_operation_failed',
              message: 'hidden token',
              detail: { causeRef: cause },
            } as any;
            c.append({
              type: 'job.progress.emitted',
              stream: { kind: 'job', id: 'job-any-hidden-token' },
              refs: { jobId: 'job-any-hidden-token' },
              body,
            });
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/body\.detail\.causeRef/);

      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects non-finite body numbers before encoding any row', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append({
              type: 'test.non_finite',
              stream: { kind: 'job', id: 'job-non-finite' },
              body: {
                nested: {
                  value: Infinity,
                },
              },
            });
            return undefined;
          },
          ctx(),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'event_body_non_finite_number',
          detail: expect.objectContaining({
            path: 'body.nested.value',
            value: 'Infinity',
          }),
        }),
      );

      expect(countEvents(db)).toBe(0);
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

  it('rejects forward-only violations at pinned causeRef paths', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            const body: { outcome: 'failed'; causeRef?: unknown; stepDetails: [] } = {
              outcome: 'failed',
              stepDetails: [],
            };
            c.append({
              type: 'workflow.completed',
              stream: { kind: 'workflow', id: 'workflow-forward' },
              refs: { workflowId: 'workflow-forward' },
              body,
            });
            const later = c.append(workflowPlanInput('workflow-forward-cause'));
            body.causeRef = later;
            return undefined;
          },
          ctx(),
        ),
      ).toThrow(/cannot be referenced by owner slot 0/);

      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('persists a 3+ event cross-stream causal chain with resolved refs and contiguous seqs', () => {
    const db = createDb();
    try {
      const entry = sessionEntry('session-chain');
      const appended = commit(
        db,
        (c) => {
          c.append({
            type: 'session.opened',
            stream: { kind: 'session', id: 'session-chain' },
            refs: { sessionId: 'session-chain' },
            body: {
              entry,
              controller: 'default',
              scope_key: 'tests',
            },
          });
          const providerFailure = c.append({
            type: 'session.provider_failed',
            stream: { kind: 'session', id: 'session-chain' },
            refs: { sessionId: 'session-chain' },
            body: {
              provider: 'codex',
              reason: 'request_failed',
              message: 'transport reset',
            },
          });
          c.append(workflowPlanInput('workflow-chain'));
          const workflowCompleted = c.append({
            type: 'workflow.completed',
            stream: { kind: 'workflow', id: 'workflow-chain' },
            refs: { workflowId: 'workflow-chain' },
            body: {
              outcome: 'failed',
              causeRef: providerFailure,
              stepDetails: [],
            },
          });
          c.append(claimInput(entry, 'job-chain'));
          c.append(launchInput('job-chain', 'session-chain'));
          c.append({
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-chain' },
            refs: { jobId: 'job-chain', sessionId: 'session-chain' },
            body: {
              terminal: {
                outcome: { kind: 'failed', causeRef: workflowCompleted },
                durationMs: 1,
                content: 'failed',
              },
            },
          });
          return undefined;
        },
        ctx(),
      );

      expect(appended.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      const bodies = bodiesBySeq(db);
      expect(bodies.get(4)).toMatchObject({
        outcome: 'failed',
        causeRef: { stream: { kind: 'session', id: 'session-chain' }, seq: 2 },
      });
      expect(bodies.get(7)).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'workflow', id: 'workflow-chain' }, seq: 4 },
          },
        },
      });
    } finally {
      db.close();
    }
  });

  it('rejects a provider launch without a previously established provider session', () => {
    const db = createDb();
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(launchInput('job-missing-session'));
          },
          ctx(),
        ),
      ).toThrow(/no provider session/u);
      expect(countEvents(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('makes provider session order explicit inside an atomic batch', () => {
    const db = createDb();
    const entry = sessionEntry('session-order');
    const opened = {
      type: 'session.opened' as const,
      stream: { kind: 'session' as const, id: entry.sessionId },
      refs: { sessionId: entry.sessionId },
      body: { entry, controller: 'default', scope_key: 'tests' },
    };
    try {
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(launchInput('job-before-open', entry.sessionId));
            c.append(opened);
          },
          ctx(),
        ),
      ).toThrow(/no provider session/u);
      expect(countEvents(db)).toBe(0);

      const appended = commit(
        db,
        (c) => {
          c.append(opened);
          c.append(claimInput(entry, 'job-after-open'));
          c.append(launchInput('job-after-open', entry.sessionId));
        },
        ctx(),
      );
      expect(appended.map((event) => event.type)).toEqual([
        'session.opened',
        'session.claimed',
        'job.launch.requested',
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects duplicate launch declarations both within a batch and against the journal', () => {
    const db = createDb();
    try {
      const entry = sessionEntry('session-duplicate');
      const opened = {
        type: 'session.opened' as const,
        stream: { kind: 'session' as const, id: entry.sessionId },
        refs: { sessionId: entry.sessionId },
        body: { entry, controller: 'default', scope_key: 'tests' },
      };
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(opened);
            c.append(claimInput(entry, 'job-duplicate'));
            c.append(launchInput('job-duplicate', entry.sessionId));
            c.append(launchInput('job-duplicate', entry.sessionId));
          },
          ctx(),
        ),
      ).toThrow(/already has a launch declaration/u);
      expect(countEvents(db)).toBe(0);

      commit(
        db,
        (c) => {
          c.append(opened);
          c.append(claimInput(entry, 'job-duplicate'));
          c.append(launchInput('job-duplicate', entry.sessionId));
        },
        ctx(),
      );
      expect(() =>
        commit(
          db,
          (c) => {
            c.append(launchInput('job-duplicate', entry.sessionId));
          },
          ctx(),
        ),
      ).toThrow(/already has a launch declaration/u);
      expect(countEvents(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it('rejects a provider launch whose provider disagrees with the session binding', () => {
    const db = createDb();
    try {
      const mismatchedEntry = {
        ...sessionEntry('session-binding-mismatch'),
        binding: TEST_CLAUDE_BINDING,
      };
      commit(
        db,
        (c) => {
          c.append({
            type: 'session.opened',
            stream: { kind: 'session', id: mismatchedEntry.sessionId },
            refs: { sessionId: mismatchedEntry.sessionId },
            body: { entry: mismatchedEntry, controller: 'default', scope_key: 'tests' },
          });
        },
        ctx(),
      );

      expect(() =>
        commit(
          db,
          (c) => {
            c.append(claimInput(mismatchedEntry, 'job-binding-mismatch'));
            c.append(launchInput('job-binding-mismatch', mismatchedEntry.sessionId));
          },
          ctx(),
        ),
      ).toThrow(/does not match its provider session binding and execution owner/u);
      expect(countEvents(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});
