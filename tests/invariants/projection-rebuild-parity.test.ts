import { currentCoralStoreFormat } from '#src/store-format.js';
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

import type { Database } from '#src/store/db.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
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
import type { ProviderSession } from '#src/sessions/entry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';

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
    query: `SELECT job_id, execution_owner, phase, terminal, diagnostics, session_id, provider, project_root,
                 work_dir, backend_namespace, bundle_hash, job_kind, parent_workflow_job_id,
                 workflow_slot, workflow_slot_generation, replaces_workflow_job_id,
                 created_at, last_seq
            FROM projection_jobs`,
    orderBy: 'job_id',
  },
  {
    name: 'projection_sessions',
    query: `SELECT session_id, controller, resumable, conversation_ref,
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
    query: 'SELECT workflow_id, plan, provider_scope, lifecycle, last_seq FROM projection_workflows',
    orderBy: 'workflow_id',
  },
];

function sessionEntry(sessionId: string): ProviderSession {
  return {
    sessionId,
    binding: TEST_CODEX_BINDING,
    name: sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    cwd: '/workspace/coral',
    projectRoot: '/workspace/coral',
    backendNamespace: 'invariant-ns',
    providerContinuity: null,
    createdAt: NOW.toISOString(),
    lastUsedAt: NOW.toISOString(),
    version: 1,
    controllerProfile: { owner: 'team-invariant' },
  };
}

function snapshotProjections(db: Database): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>();
  for (const table of PROJECTION_TABLES) {
    const rows = db.prepare(`${table.query} ORDER BY ${table.orderBy}`).all();
    result.set(table.name, rows);
  }
  return result;
}

function loadDiscussFixtureEvents(): Array<ReturnType<typeof toJournalInput>> {
  // The fixture is a serialized DiscussEventEnvelope[]; reuse the production
  // journaling adapter to convert each envelope into the CoralEventInput shape.
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

const DISCUSS_EXECUTION_SESSION_ID = '00000000-0000-0000-0000-000000000001';
const FIRST_DISCUSS_JOB_ID = '00000000-0000-0000-0000-000000000002';

function discussionJobLaunchInput(
  jobId: string,
  purpose: 'bid' | 'speech' | 'epoch_evaluation' | 'follow_up' | 'synthesis',
  attempt: number,
): CoralEventInput {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: jobId },
    refs: { sessionId: DISCUSS_EXECUTION_SESSION_ID },
    body: {
      owner: { kind: 'discussion', id: 'discuss-golden' },
      discussionRun: { agent: 'alpha', purpose, attempt },
      sessionId: DISCUSS_EXECUTION_SESSION_ID,
      provider: 'codex',
      providerAction: jobId === FIRST_DISCUSS_JOB_ID ? 'exec' : 'resume',
      projectRoot: '<root>',
      backendNamespace: 'invariant-ns',
      bundleHash: 'bundle-parity',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: Number.parseInt(jobId.slice(-1), 10),
      request: {
        prompt: `golden discussion ${purpose}`,
        cwd: '/workspace/discuss',
        bypassPermissions: false,
        coralEnv: {},
      },
      createdAt: NOW.toISOString(),
    },
  };
}

function sessionClaimInput(entry: ProviderSession, jobId: string): { input: CoralEventInput; entry: ProviderSession } {
  const claimed: ProviderSession = { ...entry, activeJobId: jobId, version: entry.version + 1 };
  return {
    input: {
      type: 'session.claimed',
      stream: { kind: 'session', id: entry.sessionId },
      refs: { sessionId: entry.sessionId, jobId },
      body: { entry: claimed, jobId },
    },
    entry: claimed,
  };
}

function sessionReleaseInput(
  entry: ProviderSession,
  jobId: string,
): { input: CoralEventInput; entry: ProviderSession } {
  const { activeJobId: _activeJobId, ...unclaimed } = entry;
  const released: ProviderSession = { ...unclaimed, version: entry.version + 1 };
  return {
    input: {
      type: 'session.claim.released',
      stream: { kind: 'session', id: entry.sessionId },
      refs: { sessionId: entry.sessionId, jobId },
      body: { entry: released, jobId },
    },
    entry: released,
  };
}

function loadAuthorizedDiscussFixtureEvents(openedSession: ProviderSession): CoralEventInput[] {
  const inputs: CoralEventInput[] = [];
  let session = openedSession;
  for (const input of loadDiscussFixtureEvents()) {
    if (input.type === 'discuss.agent.run.bound') {
      const claim = sessionClaimInput(session, FIRST_DISCUSS_JOB_ID);
      inputs.push(claim.input, discussionJobLaunchInput(FIRST_DISCUSS_JOB_ID, 'bid', 1));
      session = claim.entry;
    } else if (input.type === 'discuss.agent.job.started') {
      const body = input.body as {
        jobId: string;
        purpose: Parameters<typeof discussionJobLaunchInput>[1];
        attempt: number;
      };
      if (body.jobId !== FIRST_DISCUSS_JOB_ID) {
        const claim = sessionClaimInput(session, body.jobId);
        inputs.push(claim.input, discussionJobLaunchInput(body.jobId, body.purpose, body.attempt));
        session = claim.entry;
      }
    }
    inputs.push(input);
    if (input.type === 'discuss.agent.job.finished') {
      const body = input.body as { jobId: string };
      const release = sessionReleaseInput(session, body.jobId);
      inputs.push(release.input);
      session = release.entry;
    }
  }
  return inputs;
}

describe('Phase 7: rebuildProjections parity for all 4 base journal consumers', () => {
  it('commit-time reducer state == rebuildProjections state, row by row, for jobs/sessions/discuss/workflow', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();

      const plan = buildWorkflowPlan('workflow-parity', parseExpression('architect -> resolver'), {
        defaultProvider: 'codex',
      });

      const sessionOpen = sessionEntry('session-parity');
      const parityClaim = sessionClaimInput(sessionOpen, 'job-parity-1');
      const sessionReady: ProviderSession = {
        ...parityClaim.entry,
        state: 'ready',
        conversationRef: 'thread-parity',
        providerContinuity: { threadId: 'thread-parity', turnId: 'turn-1' },
        version: parityClaim.entry.version + 1,
      };

      const discussSessionOpen: ProviderSession = {
        ...sessionEntry(DISCUSS_EXECUTION_SESSION_ID),
        cwd: '<root>',
        projectRoot: '<root>',
      };
      const discussInputs = loadAuthorizedDiscussFixtureEvents(discussSessionOpen);

      const inputs = [
        // Session authority must precede the provider job it owns.
        {
          type: 'session.opened' as const,
          stream: { kind: 'session' as const, id: 'session-parity' },
          refs: { sessionId: 'session-parity' },
          body: {
            entry: sessionOpen,
            controller: 'team-invariant',
            scope_key: 'parity-scope',
          },
        },
        parityClaim.input,
        {
          type: 'job.launch.requested' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          body: {
            owner: { kind: 'provider-session' as const, id: 'session-parity' },
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
          body: { queuePosition: 0, runningJobIds: [] },
        },
        {
          type: 'job.queue.admitted' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          body: { queuePosition: 0 },
        },
        {
          type: 'job.runtime.started' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          body: {
            transport: 'durable-cli' as const,
            pid: 9001,
            stdoutPath: '/tmp/job-parity-1.stdout',
            stderrPath: '/tmp/job-parity-1.stderr',
            startedAt: NOW.toISOString(),
          },
        },
        {
          type: 'job.terminal.recorded' as const,
          stream: { kind: 'job' as const, id: 'job-parity-1' },
          refs: { sessionId: 'session-parity' },
          body: {
            terminal: {
              outcome: { kind: 'provider_exit' as const, code: 0 },
              durationMs: 42,
              content: 'done',
            },
          },
        },
        {
          type: 'session.continuity.checkpointed' as const,
          stream: { kind: 'session' as const, id: 'session-parity' },
          refs: { sessionId: 'session-parity' },
          body: {
            entry: sessionReady,
            snapshot: {
              conversationRef: 'thread-parity',
              resumable: true,
              providerContinuity: { threadId: 'thread-parity', turnId: 'turn-1' },
            },
          },
        },
        workflowPlanDeclaredEvent('workflow-parity', plan, TEST_PROVIDER_SCOPE),
        {
          type: 'job.launch.requested' as const,
          stream: { kind: 'job' as const, id: 'workflow-parity' },
          refs: { workflowId: 'workflow-parity' },
          body: {
            owner: { kind: 'workflow' as const, id: 'workflow-parity' },
            projectRoot: '/workspace/coral',
            backendNamespace: 'invariant-ns',
            bundleHash: 'bundle-parity',
            jobKind: 'workflow' as const,
            pool: 'default',
            enqueueSequence: 2,
            request: {
              prompt: 'run workflow',
              cwd: '/workspace/coral/workflow',
              bypassPermissions: false,
              coralEnv: {},
            },
            createdAt: NOW.toISOString(),
          },
        },
        {
          type: 'job.launch.requested' as const,
          stream: { kind: 'job' as const, id: 'kb-parity' },
          refs: { jobId: 'kb-parity' },
          body: {
            owner: { kind: 'system-task' as const, id: 'kb.reindex:kb-parity' },
            projectRoot: '/workspace/coral',
            backendNamespace: 'invariant-ns',
            bundleHash: 'bundle-parity',
            jobKind: 'kb' as const,
            operation: 'kb.reindex' as const,
            pool: 'default',
            enqueueSequence: 3,
            request: {},
            createdAt: NOW.toISOString(),
          },
        },
        workflowDrainEnteredEvent('workflow-parity', {
          firstFailureSlotId: plan.slots[1].slotId,
          drainDeadline: Date.parse('2026-04-29T00:00:15.000Z'),
        }),
        workflowCompletedEvent('workflow-parity', {
          outcome: 'failed',
          causeRef: { stream: { kind: 'workflow' as const, id: 'workflow-parity' }, seq: 2 },
          stepDetails: [],
        }),
        {
          type: 'session.opened' as const,
          stream: { kind: 'session' as const, id: DISCUSS_EXECUTION_SESSION_ID },
          refs: { sessionId: DISCUSS_EXECUTION_SESSION_ID },
          body: {
            entry: discussSessionOpen,
            controller: 'team-invariant',
            scope_key: 'parity-discuss-scope',
          },
        },
        ...discussInputs,
      ];

      const appended = commitInputs(db, inputs, {
        now: () => NOW,
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
      expect(appended.length).toBe(inputs.length);

      const before = snapshotProjections(db);
      const jobRows = before.get('projection_jobs') as Array<{ job_id: string; work_dir: string | null }>;
      expect(jobRows.find((row) => row.job_id === 'job-parity-1')?.work_dir).toBe('/workspace/coral');
      expect(jobRows.find((row) => row.job_id === 'workflow-parity')?.work_dir).toBe('/workspace/coral/workflow');
      expect(jobRows.find((row) => row.job_id === 'kb-parity')?.work_dir).toBeNull();
      // Sanity: all four projections received writes from commit().
      for (const table of PROJECTION_TABLES) {
        expect(before.get(table.name)?.length, `${table.name} populated by commit()`).toBeGreaterThan(0);
      }

      rebuildProjections({
        db,
        cutoffSeq: appended.at(-1)?.seq ?? 0,
        reducers,
        bodyCodec,
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
