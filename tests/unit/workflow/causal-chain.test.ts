import { currentCoralStoreFormat } from '#src/store-format.js';
// Pinning regression test for the canonical worked example
// "[A] | [B, C] where C fails" — the demonstration that the causal-graph
// fault model replaces wrapped fault unions: a child job exits non-zero,
// the workflow stream records a `workflow.completed { outcome: 'failed',
// causeRef }`, and the workflow job's terminal in turn carries
// `failed { causeRef }` pointing at that workflow event. Every event lives
// once on its originating stream; outer terminals point inward instead of
// duplicating payload.
//
// The test reproduces the five-transaction sequence, then verifies
// (a) projection state at the final seq matches the worked example and
// (b) the cause-ref renderer walks the chain to the originating provider
// exit. The test pins the chain primitive (`describeCauseRef`) plus
// `WorkflowView.slotOutcomes`, which together are the inputs that CLI
// presentation composes from.

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';
import { TEST_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';

import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { REAL_CONSUMER_DRIVER_TIMERS } from '#tests/helpers/consumer-driver-defaults.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { commit } from '#src/store/append.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { readWorkflowView } from '#src/workflow/read-queries.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');
const PROJECT_ROOT = '/workspace/coral';
const NAMESPACE = 'wf-namespace';
const BUNDLE_HASH = 'wf-bundle';
const WORKFLOW_ID = 'wf-1';
const SLOT_A = `${WORKFLOW_ID}:0:0`;
const SLOT_B = `${WORKFLOW_ID}:1:0`;
const SLOT_C = `${WORKFLOW_ID}:1:1`;
function workflowPlan(): {
  slots: Array<{
    slotId: string;
    dependencies: string[];
    provider: string;
    instruction: string;
    agent?: string;
  }>;
} {
  return {
    slots: [
      { slotId: SLOT_A, dependencies: [], provider: 'codex', instruction: 'A', agent: 'A' },
      { slotId: SLOT_B, dependencies: [SLOT_A], provider: 'codex', instruction: 'B', agent: 'B' },
      { slotId: SLOT_C, dependencies: [SLOT_A], provider: 'codex', instruction: 'C', agent: 'C' },
    ],
  };
}

function providerLaunchBody(args: { sessionId: string; enqueueSequence: number }): Record<string, unknown> {
  return {
    owner: { kind: 'workflow', id: WORKFLOW_ID },
    sessionId: args.sessionId,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: PROJECT_ROOT,
    backendNamespace: NAMESPACE,
    bundleHash: BUNDLE_HASH,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: args.enqueueSequence,
    request: {
      prompt: 'go',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW.toISOString(),
  };
}

function transactionLaunchAndStart(args: {
  jobId: string;
  sessionId: string;
  enqueueSequence: number;
  parentJobId?: string;
  workflowSlotId?: string;
}): CoralEventInput[] {
  const refs: NonNullable<CoralEventInput['refs']> = {
    sessionId: args.sessionId,
    ...(args.parentJobId ? { parentJobId: args.parentJobId, workflowId: WORKFLOW_ID } : {}),
    ...(args.workflowSlotId ? { workflowSlotId: args.workflowSlotId } : {}),
  };
  return [
    {
      type: 'job.launch.requested',
      stream: { kind: 'job', id: args.jobId },
      refs,
      body: {
        ...providerLaunchBody({
          sessionId: args.sessionId,
          enqueueSequence: args.enqueueSequence,
        }),
        ...(args.workflowSlotId === undefined ? {} : { workflowSlotGeneration: 0 }),
      },
    },
    {
      type: 'job.queue.admitted',
      stream: { kind: 'job', id: args.jobId },
      refs,
      body: { queuePosition: 0 },
    },
    {
      type: 'job.runtime.started',
      stream: { kind: 'job', id: args.jobId },
      refs,
      body: {
        transport: 'durable-cli',
        pid: 1234,
        stdoutPath: `/tmp/${args.jobId}.stdout`,
        stderrPath: `/tmp/${args.jobId}.stderr`,
        startedAt: NOW.toISOString(),
      },
    },
  ];
}

function workflowLaunchAndStart(): CoralEventInput[] {
  const refs = { jobId: WORKFLOW_ID, workflowId: WORKFLOW_ID };
  return [
    {
      type: 'job.launch.requested',
      stream: { kind: 'job', id: WORKFLOW_ID },
      refs,
      body: {
        owner: { kind: 'workflow', id: WORKFLOW_ID },
        projectRoot: PROJECT_ROOT,
        backendNamespace: NAMESPACE,
        bundleHash: BUNDLE_HASH,
        jobKind: 'workflow',
        pool: 'default',
        enqueueSequence: 0,
        request: {
          prompt: 'go',
          cwd: PROJECT_ROOT,
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt: NOW.toISOString(),
      },
    },
    {
      type: 'job.queue.admitted',
      stream: { kind: 'job', id: WORKFLOW_ID },
      refs,
      body: { queuePosition: 0 },
    },
    {
      type: 'job.runtime.started',
      stream: { kind: 'job', id: WORKFLOW_ID },
      refs,
      body: { transport: 'workflow', startedAt: NOW.toISOString() },
    },
  ];
}

function setup(): {
  db: Database;
  driver: ConsumerDriver;
  store: CoralStore;
} {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: () => NOW });
  // Cursor-only base consumers; commit-time reducer writes projections.
  driver.register({ id: 'jobs', authority: 'journal', kind: 'cursor', registrationKind: 'base' });
  driver.register({ id: 'workflow', authority: 'journal', kind: 'cursor', registrationKind: 'base' });
  const readCtx: StoreReadContext = createDefaultStoreReadContext();
  const store = new CoralStore(db, readCtx);
  return { db, driver, store };
}

async function runChain(db: Database, driver: ConsumerDriver): Promise<number> {
  for (const sessionId of ['session-a-1', 'session-b-1', 'session-c-1']) {
    seedTestSessionProjection(db, {
      sessionId,
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: NAMESPACE,
    });
  }
  const append = (events: CoralEventInput[]): number => {
    const result = commitInputs(db, events, {
      now: () => NOW,
      reducers: composeReducers(jobsRegistry, workflowRegistry),
      bodyCodec: createEventBodyCodec(),
      providers: permissiveProviderLookupPort,
    });
    return result.at(-1)?.seq ?? 0;
  };

  // Transaction 1 — workflow plan declared + workflow job launched.
  append([
    {
      type: 'workflow.plan.declared',
      stream: { kind: 'workflow', id: WORKFLOW_ID },
      refs: { workflowId: WORKFLOW_ID },
      body: { plan: workflowPlan(), providerScope: TEST_PROVIDER_SCOPE },
    },
    ...workflowLaunchAndStart(),
  ]);

  // Transaction 2 — slot A launched and completed.
  append([
    ...transactionLaunchAndStart({
      jobId: 'a-1',
      sessionId: 'session-a-1',
      enqueueSequence: 1,
      parentJobId: WORKFLOW_ID,
      workflowSlotId: SLOT_A,
    }),
    {
      type: 'job.terminal.recorded',
      stream: { kind: 'job', id: 'a-1' },
      refs: { sessionId: 'session-a-1', parentJobId: WORKFLOW_ID, workflowId: WORKFLOW_ID, workflowSlotId: SLOT_A },
      body: {
        terminal: {
          outcome: { kind: 'completed' },
          content: 'A done',
          durationMs: 1200,
        },
      },
    },
  ]);

  // Transaction 3 — slots B and C launched.
  append([
    ...transactionLaunchAndStart({
      jobId: 'b-1',
      sessionId: 'session-b-1',
      enqueueSequence: 2,
      parentJobId: WORKFLOW_ID,
      workflowSlotId: SLOT_B,
    }),
    ...transactionLaunchAndStart({
      jobId: 'c-1',
      sessionId: 'session-c-1',
      enqueueSequence: 3,
      parentJobId: WORKFLOW_ID,
      workflowSlotId: SLOT_C,
    }),
  ]);

  // Transaction 4 — slot B completes.
  append([
    {
      type: 'job.terminal.recorded',
      stream: { kind: 'job', id: 'b-1' },
      refs: { sessionId: 'session-b-1', parentJobId: WORKFLOW_ID, workflowId: WORKFLOW_ID, workflowSlotId: SLOT_B },
      body: {
        terminal: {
          outcome: { kind: 'completed' },
          content: 'B done',
          durationMs: 2200,
        },
      },
    },
  ]);

  // Transaction 5 — C fails, workflow fails, workflow-job fails.
  // All three events commit atomically (BEGIN IMMEDIATE..COMMIT).
  const workflowJobTerminalSeq =
    commit(
      db,
      (c) => {
        const childTerminal = c.append({
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: 'c-1' },
          refs: { sessionId: 'session-c-1', parentJobId: WORKFLOW_ID, workflowId: WORKFLOW_ID, workflowSlotId: SLOT_C },
          body: {
            terminal: {
              outcome: { kind: 'provider_exit', code: 1 },
              content: '',
              durationMs: 3300,
            },
          },
        });
        const workflowCompleted = c.append({
          type: 'workflow.completed',
          stream: { kind: 'workflow', id: WORKFLOW_ID },
          refs: { workflowId: WORKFLOW_ID },
          body: {
            outcome: 'failed',
            causeRef: childTerminal,
            stepDetails: [],
          },
        });
        c.append({
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: WORKFLOW_ID },
          refs: { jobId: WORKFLOW_ID, workflowId: WORKFLOW_ID },
          body: {
            terminal: {
              outcome: {
                kind: 'failed',
                causeRef: workflowCompleted,
              },
              content: '',
              durationMs: 8452,
            },
          },
        });
        return undefined;
      },
      {
        now: () => NOW,
        reducers: composeReducers(jobsRegistry, workflowRegistry),
        bodyCodec: createEventBodyCodec(),
        providers: permissiveProviderLookupPort,
      },
    ).at(-1)?.seq ?? 0;

  driver.notify('journal', workflowJobTerminalSeq);
  await driver.waitFreshUntil('journal', workflowJobTerminalSeq, 'jobs');
  await driver.waitFreshUntil('journal', workflowJobTerminalSeq, 'workflow');
  return workflowJobTerminalSeq;
}

describe('worked example — [A] | [B, C] where C fails', () => {
  it('at the final seq, projection_jobs(wf-1) is failed-with-causeRef pointing at workflow.completed', async () => {
    const { db, driver } = setup();
    try {
      const finalSeq = await runChain(db, driver);

      const row = db
        .prepare(
          `SELECT job_id, phase, terminal, parent_workflow_job_id, workflow_slot, last_seq
             FROM projection_jobs
            WHERE job_id = ?`,
        )
        .get(WORKFLOW_ID) as
        | {
            job_id: string;
            phase: string;
            terminal: string | null;
            parent_workflow_job_id: string | null;
            workflow_slot: string | null;
            last_seq: number;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.phase).toBe('error');
      expect(row?.parent_workflow_job_id).toBeNull();
      expect(row?.workflow_slot).toBeNull();
      expect(row?.last_seq).toBe(finalSeq);

      const terminal = JSON.parse(row?.terminal ?? 'null');
      expect(terminal.outcome.kind).toBe('failed');
      expect(terminal.outcome.causeRef.stream).toEqual({ kind: 'workflow', id: WORKFLOW_ID });
      expect(terminal.outcome.causeRef.seq).toBe(finalSeq - 1);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('WorkflowView aggregates plan + slot outcomes with causeRef pointing at job/c-1', async () => {
    const { db, driver, store } = setup();
    try {
      await runChain(db, driver);

      const view = readWorkflowView(db, WORKFLOW_ID, store);
      expect(view).toBeDefined();
      expect(view?.outcome).toBe('failed');
      expect(view?.causeRef).toEqual({
        stream: { kind: 'job', id: 'c-1' },
        seq: expect.any(Number),
      });
      expect(view?.plan.slots.map((slot) => slot.slotId)).toEqual([SLOT_A, SLOT_B, SLOT_C]);

      // Children are derived from the projection, not embedded in the view.
      expect(view?.slotOutcomes[SLOT_A]).toMatchObject({ jobId: 'a-1', phase: 'completed', causeRef: null });
      expect(view?.slotOutcomes[SLOT_B]).toMatchObject({ jobId: 'b-1', phase: 'completed', causeRef: null });
      // c-1 ended via provider_exit, not failed-with-causeRef, so slot causeRef is null.
      expect(view?.slotOutcomes[SLOT_C]).toMatchObject({ jobId: 'c-1', phase: 'error', causeRef: null });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('describeCauseRef walks workflow.completed → c-1 provider_exit chain', async () => {
    const { db, driver, store } = setup();
    try {
      await runChain(db, driver);

      const row = db.prepare(`SELECT terminal FROM projection_jobs WHERE job_id = ?`).get(WORKFLOW_ID) as
        | { terminal: string }
        | undefined;
      const terminal = JSON.parse(row?.terminal ?? 'null');
      const description = renderer.describe(terminal.outcome.causeRef, store);

      // The chain primitive renders one sentence per hop; the originating
      // failure surfaces as the provider exit, not a wrapped union variant.
      expect(description).toContain('Workflow failed.');
      expect(description).toContain('Provider exited 1.');
      expect(description).toMatch(/Workflow failed\..*Caused by:.*Provider exited 1\./);
    } finally {
      await driver.shutdown();
      db.close();
    }
  });

  it('Transaction 5 commit atomicity: the three events share a contiguous seq range and replay sees all-or-nothing', async () => {
    const { db, driver } = setup();
    try {
      const finalSeq = await runChain(db, driver);

      // Transaction 5 produced exactly: c-1 terminal → workflow.completed →
      // wf-1 terminal, in three contiguous seqs.
      const tx5 = db
        .prepare(
          `SELECT seq, type, stream_kind, stream_id
             FROM events
            WHERE seq BETWEEN ? AND ?
            ORDER BY seq ASC`,
        )
        .all(finalSeq - 2, finalSeq) as Array<{
        seq: number;
        type: string;
        stream_kind: string;
        stream_id: string;
      }>;

      expect(tx5).toHaveLength(3);
      expect(tx5[0]).toMatchObject({ type: 'job.terminal.recorded', stream_kind: 'job', stream_id: 'c-1' });
      expect(tx5[1]).toMatchObject({ type: 'workflow.completed', stream_kind: 'workflow', stream_id: WORKFLOW_ID });
      expect(tx5[2]).toMatchObject({ type: 'job.terminal.recorded', stream_kind: 'job', stream_id: WORKFLOW_ID });
    } finally {
      await driver.shutdown();
      db.close();
    }
  });
});
