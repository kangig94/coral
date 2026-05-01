import type { Database } from '../store/db.js';
import { z } from 'zod';

import type { CoralEvent, CoralEventInput, ResolvableCoralEventInput } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { CoralSetupError } from '../runtime/errors.js';
import { CoralAppendError } from '../store/append-error.js';
import { causeRefSchema, type CauseRef, type CauseRefToken } from '../causality/cause-ref.js';
import { parseWorkflowSlotId, workflowPlanSchema, type WorkflowPlan } from './plan.js';

export const workflowStepDetailSchema = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    atomIndex: z.number().int().nonnegative(),
    label: z.string(),
    output: z.string(),
  })
  .strict();

const workflowStepDetailsField = {
  stepDetails: z.array(workflowStepDetailSchema),
} as const;

/**
 * Failure location captured at the wait/launch site that detected the
 * terminal failure. Optional because launch-rejection paths may set only a
 * subset (e.g. no `jobId` if rejected before job creation). Surfaced in
 * `workflow.completed` body for failed outcomes so coral-reef and operators
 * can identify the failing slot/step/atom without re-walking the journal.
 */
export const workflowFailureLocationSchema = z
  .object({
    slotId: z.string().optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    atomLabel: z.string().optional(),
    jobId: z.string().optional(),
  })
  .strict();

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
      failureLocation: workflowFailureLocationSchema.optional(),
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
export type WorkflowFailureLocation = z.infer<typeof workflowFailureLocationSchema>;
export type WorkflowLifecycleFaultBody = z.infer<typeof workflowLifecycleFaultBodySchema>;
export type WorkflowCompletedInputBody<Scope = never> =
  | { outcome: 'completed'; stepDetails: WorkflowStepDetail[] }
  | { outcome: 'aborted'; stepDetails: WorkflowStepDetail[] }
  | {
      outcome: 'failed';
      causeRef: CauseRef | CauseRefToken<Scope>;
      stepDetails: WorkflowStepDetail[];
      failureLocation?: WorkflowFailureLocation;
    };
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

type WorkflowPlanInvalidReason =
  | 'duplicate_slot'
  | 'cycle'
  | 'empty_plan'
  | 'slot_id_format'
  | 'unknown_dependency'
  | 'unknown_slot'
  | 'unknown_provider';

function workflowPlanInvalid(
  reason: WorkflowPlanInvalidReason,
  detail: Record<string, unknown> = {},
): CoralAppendError {
  return new CoralAppendError('workflow_plan_invalid', { reason, ...detail });
}

function detectWorkflowPlanCycle(slotsById: ReadonlyMap<string, WorkflowPlan['slots'][number]>): string[] | null {
  const visited = new Set<string>();
  const visitingIndex = new Map<string, number>();
  const stack: string[] = [];

  const visit = (slotId: string): string[] | null => {
    if (visited.has(slotId)) {
      return null;
    }

    const activeIndex = visitingIndex.get(slotId);
    if (activeIndex !== undefined) {
      return [...stack.slice(activeIndex), slotId];
    }

    const slot = slotsById.get(slotId);
    if (!slot) {
      return null;
    }

    visitingIndex.set(slotId, stack.length);
    stack.push(slotId);
    for (const dependency of slot.dependencies) {
      const cycle = visit(dependency);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visitingIndex.delete(slotId);
    visited.add(slotId);
    return null;
  };

  for (const slotId of slotsById.keys()) {
    const cycle = visit(slotId);
    if (cycle) {
      return cycle;
    }
  }

  return null;
}

function validateDeclaredWorkflowPlan(
  ctx: Parameters<DomainAppendValidator>[0],
  workflowId: string,
  plan: WorkflowPlan,
): ReadonlySet<string> {
  if (plan.slots.length === 0) {
    throw workflowPlanInvalid('empty_plan', { workflowId });
  }

  const slotsById = new Map<string, WorkflowPlan['slots'][number]>();
  for (const slot of plan.slots) {
    const parsedSlotId = parseWorkflowSlotId(slot.slotId);
    if (!parsedSlotId || parsedSlotId.workflowId !== workflowId) {
      throw workflowPlanInvalid('slot_id_format', {
        workflowId,
        slotId: slot.slotId,
        expectedWorkflowId: workflowId,
      });
    }

    if (slotsById.has(slot.slotId)) {
      throw workflowPlanInvalid('duplicate_slot', { workflowId, slotId: slot.slotId });
    }

    if (!ctx.providers.hasProvider(slot.provider)) {
      throw workflowPlanInvalid('unknown_provider', {
        workflowId,
        slotId: slot.slotId,
        provider: slot.provider,
      });
    }

    slotsById.set(slot.slotId, slot);
  }

  for (const slot of slotsById.values()) {
    for (const dependency of slot.dependencies) {
      if (!slotsById.has(dependency)) {
        throw workflowPlanInvalid('unknown_dependency', {
          workflowId,
          slotId: slot.slotId,
          dependency,
        });
      }
    }
  }

  const cycle = detectWorkflowPlanCycle(slotsById);
  if (cycle) {
    throw workflowPlanInvalid('cycle', { workflowId, cycle });
  }

  return new Set(slotsById.keys());
}

function slotIdsForStoredWorkflowPlan(db: Database, workflowId: string): ReadonlySet<string> | null {
  const projection = readProjectionWorkflow(db, workflowId);
  return projection === null ? null : new Set(projection.plan.slots.map((slot) => slot.slotId));
}

function workflowIdForSlotRef(input: CoralEventInput, parsedWorkflowId: string): string {
  return input.refs?.workflowId ?? input.refs?.parentJobId ?? parsedWorkflowId;
}

export const validateWorkflowPlanValidity: DomainAppendValidator = (ctx, inputs) => {
  const declaredSlotIdsByWorkflow = new Map<string, ReadonlySet<string>>();
  const storedSlotIdsByWorkflow = new Map<string, ReadonlySet<string> | null>();

  for (const input of inputs) {
    if (input.type !== 'workflow.plan.declared') continue;

    const workflowId = input.stream.id;
    const slotIds = validateDeclaredWorkflowPlan(ctx, workflowId, input.body as WorkflowPlan);
    if (!declaredSlotIdsByWorkflow.has(workflowId)) {
      declaredSlotIdsByWorkflow.set(workflowId, slotIds);
    }
  }

  const readSlotIds = (workflowId: string): ReadonlySet<string> | null => {
    const declared = declaredSlotIdsByWorkflow.get(workflowId);
    if (declared) {
      return declared;
    }

    if (!storedSlotIdsByWorkflow.has(workflowId)) {
      storedSlotIdsByWorkflow.set(workflowId, slotIdsForStoredWorkflowPlan(ctx.db, workflowId));
    }
    return storedSlotIdsByWorkflow.get(workflowId) ?? null;
  };

  for (const input of inputs) {
    const slotId = input.refs?.workflowSlotId;
    if (slotId === undefined) {
      continue;
    }

    const parsedSlotId = parseWorkflowSlotId(slotId);
    if (!parsedSlotId) {
      throw workflowPlanInvalid('slot_id_format', {
        eventType: input.type,
        slotId,
      });
    }

    const workflowId = workflowIdForSlotRef(input, parsedSlotId.workflowId);
    if (workflowId !== parsedSlotId.workflowId) {
      throw workflowPlanInvalid('slot_id_format', {
        eventType: input.type,
        workflowId,
        slotId,
        expectedWorkflowId: workflowId,
      });
    }

    const slotIds = readSlotIds(workflowId);
    if (!slotIds?.has(slotId)) {
      throw workflowPlanInvalid('unknown_slot', {
        eventType: input.type,
        workflowId,
        slotId,
      });
    }
  }
};

/**
 * Spec §6.5 line 1006: a workflow stream owns exactly one declared plan. A
 * second `workflow.plan.declared` would silently overwrite the first via
 * `upsertProjectionWorkflow`, hiding both plans behind the surviving row.
 * Reject duplicate declarations at append time — covers both pre-existing
 * declarations on the stream and a second declaration in the same batch.
 */
export const validateWorkflowPlanDeclaredOnce: DomainAppendValidator = (ctx, inputs) => {
  const declaredInBatch = new Set<string>();

  for (const input of inputs) {
    if (input.type !== 'workflow.plan.declared') continue;

    const workflowId = input.stream.id;
    if (declaredInBatch.has(workflowId)) {
      throw workflowPlanDeclaredDuplicate(workflowId, 'batch');
    }
    declaredInBatch.add(workflowId);

    const existing = ctx.db
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
export const validateWorkflowCompletedOnce: DomainAppendValidator = (ctx, inputs) => {
  const completedInBatch = new Set<string>();

  for (const input of inputs) {
    if (input.type !== 'workflow.completed') continue;

    const workflowId = input.stream.id;
    if (completedInBatch.has(workflowId)) {
      throw workflowCompletedDuplicate(workflowId, 'batch');
    }
    completedInBatch.add(workflowId);

    const existing = ctx.db
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
  appendValidators: [validateWorkflowPlanDeclaredOnce, validateWorkflowPlanValidity, validateWorkflowCompletedOnce],
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
