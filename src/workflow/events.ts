import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import type { CoralEvent, CoralEventInput } from '../store/envelope.js';
import type { DomainEventRegistry, Reducer } from '../store/reducers.js';
import { causeRefSchema } from '../jobs/outcome.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';

export const workflowCompletedBodySchema = z
  .object({
    outcome: z.enum(['completed', 'failed', 'aborted']),
    causeRef: causeRefSchema.optional(),
  })
  .strict();

/**
 * Body intentionally narrower than plan AC4(b): we store only `firstFailureSlotId`
 * because `jobId` and `stepIndex` are re-derivable by joining against
 * `projection_workflows.plan.slots` at read time (see src/workflow/recover.ts:133-145).
 * This works because drain events are always read together with the plan.
 */
export const workflowDrainEnteredBodySchema = z
  .object({
    firstFailureSlotId: z.string(),
    drainDeadline: z.number().int().nonnegative(),
  })
  .strict();

export type WorkflowCompletedBody = z.infer<typeof workflowCompletedBodySchema>;
export type WorkflowDrainEnteredBody = z.infer<typeof workflowDrainEnteredBodySchema>;

function readProjectionWorkflow(db: Database, workflowId: string): { plan: WorkflowPlan; lastSeq: number } | null {
  const row = db
    .prepare(
      `SELECT plan, last_seq
         FROM projection_workflows
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as { plan: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    lastSeq: row.last_seq,
  };
}

function upsertProjectionWorkflow(db: Database, event: CoralEvent, plan?: WorkflowPlan): void {
  const previous = readProjectionWorkflow(db, event.stream.id);
  const nextPlan = plan ?? previous?.plan ?? { workflowId: event.stream.id, slots: [] };

  db.prepare(
    `INSERT INTO projection_workflows (workflow_id, plan, last_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       plan = excluded.plan,
       last_seq = excluded.last_seq`,
  ).run(event.stream.id, JSON.stringify(nextPlan), event.seq);
}

function reducerForPlan(): Reducer<WorkflowPlan> {
  return (db, event) => {
    upsertProjectionWorkflow(db, event, workflowPlanSchema.parse(event.body));
  };
}

function reducerForStateOnly(): Reducer<WorkflowCompletedBody | WorkflowDrainEnteredBody> {
  return (db, event) => {
    upsertProjectionWorkflow(db, event);
  };
}

export const workflowRegistry: DomainEventRegistry = {
  types: [
    'workflow.plan.declared',
    'workflow.plan.revised',
    'workflow.drain.entered',
    'workflow.completed',
  ],
  reducers: {
    'workflow.plan.declared': reducerForPlan() as Reducer<unknown>,
    'workflow.plan.revised': reducerForPlan() as Reducer<unknown>,
    'workflow.drain.entered': reducerForStateOnly() as Reducer<unknown>,
    'workflow.completed': reducerForStateOnly() as Reducer<unknown>,
  },
  schemas: {
    'workflow.plan.declared': workflowPlanSchema,
    'workflow.plan.revised': workflowPlanSchema,
    'workflow.drain.entered': workflowDrainEnteredBodySchema,
    'workflow.completed': workflowCompletedBodySchema,
  },
};

export function workflowPlanDeclaredEvent(workflowId: string, plan: WorkflowPlan): CoralEventInput<WorkflowPlan> {
  return {
    type: 'workflow.plan.declared',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body: plan,
  };
}

export function workflowPlanRevisedEvent(workflowId: string, plan: WorkflowPlan): CoralEventInput<WorkflowPlan> {
  return {
    type: 'workflow.plan.revised',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body: plan,
  };
}

export function workflowDrainEnteredEvent(
  workflowId: string,
  body: WorkflowDrainEnteredBody,
): CoralEventInput<WorkflowDrainEnteredBody> {
  return {
    type: 'workflow.drain.entered',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body,
  };
}

export function workflowCompletedEvent(
  workflowId: string,
  body: WorkflowCompletedBody,
): CoralEventInput<WorkflowCompletedBody> {
  return {
    type: 'workflow.completed',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body,
  };
}
