import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { decodeEventBody } from '#src/store/body-codec.js';
import { commit, type AppendContext } from '#src/store/append.js';
import { createDefaultUpcasterRegistry } from '#src/store/envelope.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { workflowRegistry } from '#src/workflow/events.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const NOW = new Date('2026-04-19T00:00:00.000Z');
const TS_OVERRIDE = '2026-04-18T12:00:00.000Z';

const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function createDb(): Database.Database {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return db;
}

function ctx(): AppendContext {
  return {
    now: () => NOW,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry),
    upcasters: createDefaultUpcasterRegistry(),
  };
}

function countEvents(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

function bodiesBySeq(db: Database.Database): Map<number, unknown> {
  const rows = db.prepare('SELECT seq, body FROM events ORDER BY seq ASC').all() as Array<{
    seq: number;
    body: Buffer;
  }>;
  return new Map(rows.map((row) => [row.seq, decodeEventBody(row.body)]));
}

function launchBody(jobId: string, sessionId = `session-${jobId}`): JobLaunchRequestBody {
  return {
    sessionId,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'tests',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    request: {
      prompt: `prompt for ${jobId}`,
      cwd: `/workspace/${jobId}`,
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
    bodyVersion: 1,
    body: launchBody(jobId, sessionId),
  };
}

function sessionEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    provider: 'codex',
    name: sessionId,
    state: 'pending',
    cwd: `/workspace/${sessionId}`,
    projectRoot: `/workspace/${sessionId}`,
    backendNamespace: 'tests',
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
  };
}

function workflowPlanInput(workflowId: string): CoralEventInput {
  return {
    type: 'workflow.plan.declared',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body: {
      slots: [
        {
          slotId: `${workflowId}:0:0`,
          dependencies: [],
          provider: 'codex',
          instruction: 'test workflow slot',
        },
      ],
    },
  };
}

describe('journal commit primitive', () => {
  it('resolves tokens before schema parse and preserves source stream for cross-stream terminals', () => {
    const db = createDb();
    try {
      const appended = commit(
        db,
        (c) => {
          const jobACause = c.append(launchInput('job-a', 'session-a'));
          c.append(launchInput('job-b', 'session-b'));
          c.append({
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-b' },
            refs: { jobId: 'job-b', sessionId: 'session-b' },
            bodyVersion: 1,
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
              bodyVersion: 1,
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
              bodyVersion: 1,
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
              bodyVersion: 1,
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
            bodyVersion: 1,
            body: {
              entry,
              controller: 'default',
              provider: 'codex',
              scope_key: 'tests',
            },
          });
          const providerFailure = c.append({
            type: 'session.provider_failed',
            stream: { kind: 'session', id: 'session-chain' },
            refs: { sessionId: 'session-chain' },
            bodyVersion: 1,
            body: {
              provider: 'codex',
              reason: 'request_failed',
              message: 'transport reset',
            },
          });
          const workflowCompleted = c.append({
            type: 'workflow.completed',
            stream: { kind: 'workflow', id: 'workflow-chain' },
            refs: { workflowId: 'workflow-chain' },
            bodyVersion: 1,
            body: {
              outcome: 'failed',
              causeRef: providerFailure,
              stepDetails: [],
            },
          });
          c.append(launchInput('job-chain', 'session-chain'));
          c.append({
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: 'job-chain' },
            refs: { jobId: 'job-chain', sessionId: 'session-chain' },
            bodyVersion: 1,
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

      expect(appended.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

      const bodies = bodiesBySeq(db);
      expect(bodies.get(3)).toMatchObject({
        outcome: 'failed',
        causeRef: { stream: { kind: 'session', id: 'session-chain' }, seq: 2 },
      });
      expect(bodies.get(5)).toMatchObject({
        terminal: {
          outcome: {
            kind: 'failed',
            causeRef: { stream: { kind: 'workflow', id: 'workflow-chain' }, seq: 3 },
          },
        },
      });
    } finally {
      db.close();
    }
  });
});
