import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import type { CoralEvent, CoralEventInput, ResolvableCoralEventInput } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import { causeRefSchema, type ResolvableCauseRef } from '../causality/cause-ref.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';

export const workflowCompletedBodySchema = z
  .object({
    outcome: z.enum(['completed', 'failed', 'aborted']),
    causeRef: causeRefSchema.optional(),
  })
  .strict();

/**
 * Stores only `firstFailureSlotId`; `jobId` and `stepIndex` are re-derivable
 * by joining against `projection_workflows.plan.slots` at read time
 * (see src/workflow/recover.ts:133-145). Drain events are always read
 * together with the plan, so the join is always available.
 */
export const workflowDrainEnteredBodySchema = z
  .object({
    firstFailureSlotId: z.string(),
    drainDeadline: z.number().int().nonnegative(),
  })
  .strict();

export type WorkflowCompletedBody = z.infer<typeof workflowCompletedBodySchema>;
export interface WorkflowCompletedInputBody<Scope = never> {
  outcome: WorkflowCompletedBody['outcome'];
  causeRef?: ResolvableCauseRef<Scope>;
}
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
  const nextPlan = plan ?? previous?.plan ?? { slots: [] };

  upsertProjection(db, {
    table: 'projection_workflows',
    pkColumn: 'workflow_id',
    pkValue: event.stream.id,
    columns: {
      plan: JSON.stringify(nextPlan),
    },
    lastSeq: event.seq,
  });
}

export const workflowRegistry: DomainEventRegistry = {
  entries: [
    defineDomainEvent({
      type: 'workflow.plan.declared',
      schema: workflowPlanSchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event, event.body),
    }),
    defineDomainEvent({
      type: 'workflow.plan.revised',
      schema: workflowPlanSchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event, event.body),
    }),
    defineDomainEvent({
      type: 'workflow.drain.entered',
      schema: workflowDrainEnteredBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
    }),
    defineDomainEvent({
      type: 'workflow.completed',
      schema: workflowCompletedBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
    }),
  ],
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
): CoralEventInput<WorkflowCompletedBody>;
export function workflowCompletedEvent<Scope>(
  workflowId: string,
  body: WorkflowCompletedInputBody<Scope>,
): ResolvableCoralEventInput<Scope, WorkflowCompletedInputBody<Scope>>;
export function workflowCompletedEvent<Scope>(
  workflowId: string,
  body: WorkflowCompletedInputBody<Scope>,
): ResolvableCoralEventInput<Scope, WorkflowCompletedInputBody<Scope>> {
  return {
    type: 'workflow.completed',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body,
  };
}
