// Phase 7 of apply-contract-reform plan.
//
// AC3/AC4 made the four base journal consumers cursor-only: spec §3.3 commit
// is now the sole writer for `projection_jobs` / `projection_sessions` /
// `projection_discuss` / `projection_workflows`. The test-side rebuild
// helper (`#tests/helpers/rebuild-projections.js`) replaces the deleted
// production `applyProjectionRange` path. This invariant proves the helper
// remains byte-identical to the commit-time reducer for all four base
// consumers from a single suite — the regression baseline that catches
// drift if either path changes in isolation.

import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers } from '#src/store/reducers.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import {
  workflowCompletedEvent,
  workflowDrainEnteredEvent,
  workflowPlanDeclaredEvent,
  workflowRegistry,
} from '#src/workflow/events.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { parseExpression } from '#src/workflow/parser.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const NOW = new Date('2026-04-29T00:00:00.000Z');
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'unit', 'discuss', 'fixtures');

interface ProjectionTable {
  readonly name: string;
  readonly query: string;
  readonly orderBy: string;
}

const PROJECTION_TABLES: readonly ProjectionTable[] = [
  {
    name: 'projection_jobs',
    query: `SELECT job_id, phase, terminal, diagnostics, session_id, provider, project_root,
                 backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
                 workflow_slot, created_at, last_seq
            FROM projection_jobs`,
    orderBy: 'job_id',
  },
  {
    name: 'projection_sessions',
    query: `SELECT session_id, controller, provider, resumable, conversation_ref,
                 scope_key, entry, last_seq
            FROM projection_sessions`,
    orderBy: 'session_id',
  },
  {
    name: 'projection_discuss',
    query: 'SELECT discuss_id, state, last_seq FROM projection_discuss',
    orderBy: 'discuss_id',
  },
  {
    name: 'projection_workflows',
    query: 'SELECT workflow_id, plan, last_seq FROM projection_workflows',
    orderBy: 'workflow_id',
  },
];

function sessionEntry(sessionId: string, provider: 'codex' | 'claude'): SessionEntry {
  return {
    sessionId,
    provider,
    name: sessionId,
    state: 'pending',
    cwd: '/tmp/project',
    projectRoot: '/tmp/project',
    backendNamespace: 'invariant-ns',
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
    controllerProfile: { owner: 'team-invariant' },
  };
}

function snapshotProjections(db: InstanceType<typeof Database>): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>();
  for (const table of PROJECTION_TABLES) {
    const rows = db.prepare(`${table.query} ORDER BY ${table.orderBy}`).all();
    result.set(table.name, rows);
  }
  return result;
}

function loadDiscussFixtureEvents(): Array<ReturnType<typeof toJournalInput>> {
  // The fixture is a serialized DiscussEventEnvelope[]; reuse the production
  // journaling adapter to convert each envelope into the AppendInput shape.
  // The fixture uses a `<ts>` placeholder that fails datetime validation in
  // commit() — substitute the canonical NOW used by the rest of the suite so
  // the journal accepts the events. Reducer behaviour is timestamp-blind.
  type DiscussEnvelope = Parameters<typeof toJournalInput>[0];
  const path = join(FIXTURE_DIR, 'session-store-golden.events.jsonl');
  return fs
    .readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DiscussEnvelope)
    .map((envelope) => toJournalInput({ ...envelope, ts: NOW.toISOString() }));
}

describe('Phase 7: rebuildProjections parity for all 4 base journal consumers', () => {
  it('commit-time reducer state == rebuildProjections state, row by row, for jobs/sessions/discuss/workflow', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const upcasters = createDefaultUpcasterRegistry();

      // Workflow plan + drain + completion (3 events).
      const plan = buildWorkflowPlan('workflow-parity', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });

      // Sessions: open + checkpoint (2 events).
      const sessionOpen = sessionEntry('session-parity', 'codex');
      const sessionReady: SessionEntry = {
        ...sessionOpen,
        state: 'ready',
        conversationRef: 'thread-parity',
        providerContinuity: { threadId: 'thread-parity', turnId: 'turn-1' },
        version: 2,
      };

      // Jobs: launch + queue + admit + start + terminal (5 events).
      // Discuss: replay the full golden fixture (16 events) — covers every
      // discuss event kind the production reducer handles.
      const discussInputs = loadDiscussFixtureEvents();

      const inputs = [
        // Jobs
        {
          type: 'job.launch.requested' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: {
            sessionId: 'session-parity',
            provider: 'codex' as const,
            providerAction: 'exec' as const,
            projectRoot: '/workspace/coral',
            backendNamespace: 'invariant-ns',
            bundleHash: 'bundle-parity',
            jobKind: 'provider' as const,
            pool: 'default',
            enqueueSequence: 1,
            request: {
              prompt: 'parity check',
              cwd: '/workspace/coral',
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: NOW.toISOString(),
          },
        },
        {
          type: 'job.queue.queued' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: { queuePosition: 0, runningJobIds: [] },
        },
        {
          type: 'job.queue.admitted' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: { queuePosition: 0 },
        },
        {
          type: 'job.runtime.started' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: { transport: 'durable-cli' as const, pid: 9001, startedAt: NOW.toISOString() },
        },
        {
          type: 'job.terminal.recorded' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: {
            terminal: {
              outcome: { kind: 'provider_exit' as const, code: 0 },
              durationMs: 42,
              content: 'done',
            },
          },
        },
        // Sessions
        {
          type: 'session.opened' as const,
          stream: { kind: 'session' as const, id: 'session-parity' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: {
            entry: sessionOpen,
            controller: 'team-invariant',
            provider: 'codex' as const,
            scope_key: 'parity-scope',
          },
        },
        {
          type: 'session.continuity.checkpointed' as const,
          stream: { kind: 'session' as const, id: 'session-parity' },
          refs: { sessionId: 'session-parity' },
          bodyVersion: 1,
          body: {
            entry: sessionReady,
            snapshot: {
              conversationRef: 'thread-parity',
              resumable: true,
              providerContinuity: { threadId: 'thread-parity', turnId: 'turn-1' },
            },
          },
        },
        // Workflow
        workflowPlanDeclaredEvent('workflow-parity', plan),
        workflowDrainEnteredEvent('workflow-parity', {
          firstFailureSlotId: plan.slots[1].slotId,
          drainDeadline: Date.parse('2026-04-29T00:00:15.000Z'),
        }),
        workflowCompletedEvent('workflow-parity', {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow' as const, id: 'workflow-parity' }, seq: 2 },
          stepDetails: [],
        }),
        // Discuss (golden fixture replay).
        ...discussInputs,
      ];

      const appended = commitInputs(db, inputs, {
        now: () => NOW,
        reducers,
        upcasters,
        providers: permissiveProviderLookupPort,
      });
      expect(appended.length).toBe(inputs.length);

      const before = snapshotProjections(db);
      // Sanity: all four projections received writes from commit().
      for (const table of PROJECTION_TABLES) {
        expect(before.get(table.name)?.length, `${table.name} populated by commit()`).toBeGreaterThan(0);
      }

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        upcasters,
      });

      const after = snapshotProjections(db);
      for (const table of PROJECTION_TABLES) {
        expect(after.get(table.name), `${table.name} byte-identical after rebuild`).toStrictEqual(
          before.get(table.name),
        );
      }
    } finally {
      db.close();
    }
  });
});
