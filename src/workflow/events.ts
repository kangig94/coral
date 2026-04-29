import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import type { CoralEvent, CoralEventInput, ResolvableCoralEventInput } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { CoralSetupError } from '../runtime/errors.js';
import { causeRefSchema, type CauseRef, type CauseRefToken } from '../causality/cause-ref.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';

export const workflowStepDetailSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    atomIndex: z.number().int().nonnegative(),
    kind: z.enum(['agent', 'prompt']),
    label: z.string(),
    provider: z.string(),
    tagName: z.string(),
    output: z.string(),
  })
  .strict();

const workflowStepDetailsField = {
  stepDetails: z.array(workflowStepDetailSchema),
} as const;

export const workflowCompletedBodySchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('completed'),
      ...workflowStepDetailsField,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('aborted'),
      ...workflowStepDetailsField,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('failed'),
      causeRef: causeRefSchema,
      ...workflowStepDetailsField,
    })
    .strict(),
]);

export const workflowLifecycleFaultBodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('wrapper_crashed'),
      message: z.string(),
      stack: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('recovery_failed'),
      message: z.string(),
      stack: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unknown'),
      message: z.string(),
    })
    .strict(),
]);

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
export type WorkflowStepDetail = z.infer<typeof workflowStepDetailSchema>;
export type WorkflowLifecycleFaultBody = z.infer<typeof workflowLifecycleFaultBodySchema>;
export type WorkflowCompletedInputBody<Scope = never> =
  | { outcome: 'completed'; stepDetails: WorkflowStepDetail[] }
  | { outcome: 'aborted'; stepDetails: WorkflowStepDetail[] }
  | { outcome: 'failed'; causeRef: CauseRef | CauseRefToken<Scope>; stepDetails: WorkflowStepDetail[] };
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

/**
 * Spec §6.5 line 1006: a workflow stream owns exactly one declared plan. A
 * second `workflow.plan.declared` would silently overwrite the first via
 * `upsertProjectionWorkflow`, hiding both plans behind the surviving row.
 * Reject duplicate declarations at append time — covers both pre-existing
 * declarations on the stream and a second declaration in the same batch.
 */
export const validateWorkflowPlanDeclaredOnce: DomainAppendValidator = (db, inputs) => {
  const declaredInBatch = new Set<string>();

  for (const input of inputs) {
    if (input.type !== 'workflow.plan.declared') continue;

    const workflowId = input.stream.id;
    if (declaredInBatch.has(workflowId)) {
      throw workflowPlanDeclaredDuplicate(workflowId, 'batch');
    }
    declaredInBatch.add(workflowId);

    const existing = db
      .prepare(
        `SELECT seq
           FROM events
          WHERE stream_kind = 'workflow'
            AND stream_id = ?
            AND type = 'workflow.plan.declared'
          LIMIT 1`,
      )
      .get(workflowId) as { seq: number } | undefined;

    if (existing) {
      throw workflowPlanDeclaredDuplicate(workflowId, `existing (seq ${existing.seq})`);
    }
  }
};

function workflowPlanDeclaredDuplicate(workflowId: string, where: string): CoralSetupError {
  return new CoralSetupError({
    code: 'workflow_plan_declared_duplicate',
    userMessage: `workflow.plan.declared is already present for workflow '${workflowId}' (${where}); a workflow stream owns exactly one declared plan.`,
    remediation: 'Use a fresh workflow id; do not redeclare the plan on an existing workflow stream.',
    context: { workflowId, where },
  });
}

/**
 * Spec §6.5: workflow stream identity is the truth → a workflow has exactly
 * one completion. A second `workflow.completed` would silently overwrite the
 * first via `upsertProjectionWorkflow`, hiding both terminals behind the
 * surviving row. Reject duplicate completions at append time — covers both
 * pre-existing completions on the stream and a second completion in the
 * same batch.
 */
export const validateWorkflowCompletedOnce: DomainAppendValidator = (db, inputs) => {
  const completedInBatch = new Set<string>();

  for (const input of inputs) {
    if (input.type !== 'workflow.completed') continue;

    const workflowId = input.stream.id;
    if (completedInBatch.has(workflowId)) {
      throw workflowCompletedDuplicate(workflowId, 'batch');
    }
    completedInBatch.add(workflowId);

    const existing = db
      .prepare(
        `SELECT seq
           FROM events
          WHERE stream_kind = 'workflow'
            AND stream_id = ?
            AND type = 'workflow.completed'
          LIMIT 1`,
      )
      .get(workflowId) as { seq: number } | undefined;

    if (existing) {
      throw workflowCompletedDuplicate(workflowId, `existing (seq ${existing.seq})`);
    }
  }
};

function workflowCompletedDuplicate(workflowId: string, where: string): CoralSetupError {
  return new CoralSetupError({
    code: 'workflow_completed_duplicate',
    userMessage: `workflow.completed is already present for workflow '${workflowId}' (${where}); a workflow has exactly one completion.`,
    remediation: 'Use a fresh workflow id; do not re-complete an existing workflow stream.',
    context: { workflowId, where },
  });
}

export const workflowRegistry: DomainEventRegistry = {
  streamKind: 'workflow',
  entries: [
    defineDomainEvent({
      type: 'workflow.plan.declared',
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
    defineDomainEvent({
      type: 'workflow.lifecycle_fault',
      schema: workflowLifecycleFaultBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
    }),
  ],
  appendValidators: [validateWorkflowPlanDeclaredOnce, validateWorkflowCompletedOnce],
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

export function workflowLifecycleFaultEvent(
  workflowId: string,
  body: WorkflowLifecycleFaultBody,
): CoralEventInput<WorkflowLifecycleFaultBody> {
  return {
    type: 'workflow.lifecycle_fault',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    bodyVersion: 1,
    body,
  };
}
