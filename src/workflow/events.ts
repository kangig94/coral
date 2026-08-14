import type { Database } from '../store/db.js';
import { z } from 'zod';

import type { CoralEvent, CoralEventInput, ResolvableCoralEventInput } from '../store/envelope.js';
import { upsertProjection } from '../store/projection-upsert.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
import { CoralSetupError } from '../runtime/errors.js';
import { CoralAppendError } from '../store/append-error.js';
import { causeRefSchema, type CauseRef, type CauseRefToken } from '../causality/cause-ref.js';
import { parseWorkflowSlotId } from './slot-id.js';
import { workflowPlanSchema, type WorkflowPlan } from './plan.js';
import { providerScopeSchema, type ProviderScope } from '../infra/provider-scope.js';
import {
  transitionWorkflowLifecycle,
  workflowLifecycleSchema,
  type WorkflowLifecycle,
  type WorkflowLifecycleEvent,
} from './lifecycle.js';
import { validateWorkflowJobAuthority } from './job-authority.js';

export const workflowDeclaredBodySchema = z
  .object({ plan: workflowPlanSchema, providerScope: providerScopeSchema })
  .strict();
export type WorkflowDeclaredBody = z.infer<typeof workflowDeclaredBodySchema>;

const workflowStepDetailSchema = z
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
const workflowFailureLocationSchema = z
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
 * Stores only `firstFailureSlotId`; `stepIndex` is derived from
 * `projection_workflows.plan.slots`, while `jobId` is selected from the
 * current generation in the workflow child rows joined by workflow and slot
 * (see `validateAndReadCurrentSlotJobIds` in `src/workflow/recover.ts`).
 */
export const workflowDrainEnteredBodySchema = z
  .object({
    firstFailureSlotId: z.string(),
    drainDeadline: z.number().int().nonnegative(),
  })
  .strict();

export type WorkflowCompletedBody = z.infer<typeof workflowCompletedBodySchema>;
type WorkflowStepDetail = z.infer<typeof workflowStepDetailSchema>;
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

function readProjectionWorkflow(
  db: Database,
  workflowId: string,
): { plan: WorkflowPlan; providerScope: ProviderScope; lifecycle: WorkflowLifecycle; lastSeq: number } | null {
  const row = db
    .prepare(
      `SELECT plan, provider_scope, lifecycle, last_seq
         FROM projection_workflows
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as { plan: string; provider_scope: string; lifecycle: string; last_seq: number } | undefined;

  if (!row) {
    return null;
  }

  return {
    plan: workflowPlanSchema.parse(JSON.parse(row.plan)),
    providerScope: providerScopeSchema.parse(JSON.parse(row.provider_scope)),
    lifecycle: workflowLifecycleSchema.parse(row.lifecycle),
    lastSeq: row.last_seq,
  };
}

function upsertProjectionWorkflow(db: Database, event: CoralEvent, declared?: WorkflowDeclaredBody): void {
  const previous = readProjectionWorkflow(db, event.stream.id);
  const nextPlan = declared?.plan ?? previous?.plan;
  const providerScope = declared?.providerScope ?? previous?.providerScope;
  if (nextPlan === undefined || providerScope === undefined) {
    throw new CoralSetupError({
      code: 'workflow_aggregate_missing',
      userMessage: `Workflow '${event.stream.id}' was not declared.`,
      remediation: 'Declare the workflow aggregate before lifecycle events.',
    });
  }
  const lifecycleEvent = workflowLifecycleEvent(event.type, event.body);
  const lifecycle = transitionWorkflowLifecycle(previous?.lifecycle ?? null, lifecycleEvent);
  if (lifecycle === null) {
    throw workflowLifecycleInvalid(event.stream.id, previous?.lifecycle ?? null, lifecycleEvent);
  }

  upsertProjection(db, {
    table: 'projection_workflows',
    pkColumn: 'workflow_id',
    pkValue: event.stream.id,
    columns: {
      plan: JSON.stringify(nextPlan),
      provider_scope: JSON.stringify(providerScope),
      lifecycle,
    },
    lastSeq: event.seq,
  });
}

function workflowLifecycleEvent(type: string, body: unknown): WorkflowLifecycleEvent {
  switch (type) {
    case 'workflow.plan.declared':
    case 'workflow.drain.entered':
    case 'workflow.lifecycle_fault':
      return { type };
    case 'workflow.completed':
      return { type, outcome: workflowCompletedBodySchema.parse(body).outcome };
    default:
      throw new Error(`Unsupported workflow lifecycle event '${type}'.`);
  }
}

function workflowLifecycleInvalid(
  workflowId: string,
  current: WorkflowLifecycle | null,
  event: WorkflowLifecycleEvent,
): CoralSetupError {
  return new CoralSetupError({
    code: 'workflow_lifecycle_invalid',
    userMessage: `Workflow '${workflowId}' cannot apply '${event.type}' from lifecycle '${current ?? 'none'}'.`,
    remediation: 'Reload the workflow and issue only the next valid lifecycle transition.',
    context: {
      workflowId,
      current,
      eventType: event.type,
      ...('outcome' in event ? { outcome: event.outcome } : {}),
    },
  });
}

type WorkflowPlanInvalidReason =
  | 'duplicate_slot'
  | 'cycle'
  | 'empty_plan'
  | 'slot_id_format'
  | 'unknown_dependency'
  | 'unknown_slot'
  | 'provider_mismatch'
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
  if (projection === null) {
    return null;
  }

  const slotIds = new Set<string>();
  for (const slot of projection.plan.slots) {
    slotIds.add(slot.slotId);
  }
  return slotIds;
}

function workflowIdForSlotRef(input: CoralEventInput, parsedWorkflowId: string): string {
  return input.refs?.workflowId ?? input.refs?.parentJobId ?? parsedWorkflowId;
}

const validateWorkflowPlanValidity: DomainAppendValidator = (ctx, inputs) => {
  const declaredSlotIdsByWorkflow = new Map<string, ReadonlySet<string>>();
  const declaredPlansByWorkflow = new Map<string, WorkflowPlan>();
  const storedSlotIdsByWorkflow = new Map<string, ReadonlySet<string> | null>();
  const storedPlansByWorkflow = new Map<string, WorkflowPlan | null>();

  for (const input of inputs) {
    if (input.type !== 'workflow.plan.declared') continue;

    const workflowId = input.stream.id;
    const declared = workflowDeclaredBodySchema.parse(input.body);
    const { plan, providerScope } = declared;
    const slotIds = validateDeclaredWorkflowPlan(ctx, workflowId, plan);
    const requiredProviders = [...new Set(plan.slots.map((slot) => slot.provider))];
    const scopeValidation = ctx.providers.validatePersistedScope(providerScope, requiredProviders);
    if (!scopeValidation.ok) {
      throw workflowPlanInvalid('provider_mismatch', {
        workflowId,
        requiredProviders,
        providerScopeError: scopeValidation.message,
      });
    }
    if (!declaredSlotIdsByWorkflow.has(workflowId)) {
      declaredSlotIdsByWorkflow.set(workflowId, slotIds);
      declaredPlansByWorkflow.set(workflowId, plan);
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

  const readPlan = (workflowId: string): WorkflowPlan | null => {
    const declared = declaredPlansByWorkflow.get(workflowId);
    if (declared) return declared;
    if (!storedPlansByWorkflow.has(workflowId)) {
      storedPlansByWorkflow.set(workflowId, readProjectionWorkflow(ctx.db, workflowId)?.plan ?? null);
    }
    return storedPlansByWorkflow.get(workflowId) ?? null;
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

    if (input.type === 'job.launch.requested') {
      const provider =
        typeof input.body === 'object' &&
        input.body !== null &&
        'provider' in input.body &&
        typeof input.body.provider === 'string'
          ? input.body.provider
          : undefined;
      const plannedProvider = readPlan(workflowId)?.slots.find((slot) => slot.slotId === slotId)?.provider;
      if (provider !== plannedProvider) {
        throw workflowPlanInvalid('provider_mismatch', {
          workflowId,
          slotId,
          provider,
          plannedProvider,
        });
      }
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
const validateWorkflowPlanDeclaredOnce: DomainAppendValidator = (ctx, inputs) => {
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
          WHERE stream_id = ?
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
const validateWorkflowCompletedOnce: DomainAppendValidator = (ctx, inputs) => {
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
          WHERE stream_id = ?
            AND type = 'workflow.completed'
          LIMIT 1`,
      )
      .get(workflowId) as { seq: number } | undefined;

    if (existing) {
      throw workflowCompletedDuplicate(workflowId, `existing (seq ${existing.seq})`);
    }
  }
};

const validateWorkflowLifecycle: DomainAppendValidator = (ctx, inputs) => {
  const lifecycleByWorkflow = new Map<string, WorkflowLifecycle | null>();

  for (const input of inputs) {
    if (
      input.type !== 'workflow.plan.declared' &&
      input.type !== 'workflow.drain.entered' &&
      input.type !== 'workflow.lifecycle_fault' &&
      input.type !== 'workflow.completed'
    ) {
      continue;
    }

    const workflowId = input.stream.id;
    let current = lifecycleByWorkflow.get(workflowId);
    if (current === undefined) {
      current = readProjectionWorkflow(ctx.db, workflowId)?.lifecycle ?? null;
    }
    const event = workflowLifecycleEvent(input.type, input.body);
    const next = transitionWorkflowLifecycle(current, event);
    if (next === null) {
      throw workflowLifecycleInvalid(workflowId, current, event);
    }
    lifecycleByWorkflow.set(workflowId, next);
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
      schema: workflowDeclaredBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event, event.body),
      materializerContract: 'projection_workflows:initialize-declared-plan-and-scope',
    }),
    defineDomainEvent({
      type: 'workflow.drain.entered',
      schema: workflowDrainEnteredBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
      materializerContract: 'projection_workflows:apply-draining-lifecycle',
    }),
    defineDomainEvent({
      type: 'workflow.completed',
      schema: workflowCompletedBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
      materializerContract: 'projection_workflows:apply-completed-lifecycle',
    }),
    defineDomainEvent({
      type: 'workflow.lifecycle_fault',
      schema: workflowLifecycleFaultBodySchema,
      reducer: (db, event) => upsertProjectionWorkflow(db, event),
      materializerContract: 'projection_workflows:apply-faulted-lifecycle',
    }),
  ],
  appendValidators: [
    { contract: 'workflow:plan-declared-once', validate: validateWorkflowPlanDeclaredOnce },
    { contract: 'workflow:plan-structural-validity', validate: validateWorkflowPlanValidity },
    { contract: 'workflow:completed-once', validate: validateWorkflowCompletedOnce },
    { contract: 'workflow:lifecycle-transition-state-machine', validate: validateWorkflowLifecycle },
    { contract: 'workflow:job-owner-slot-generation-authority', validate: validateWorkflowJobAuthority },
  ],
};

export function workflowPlanDeclaredEvent(
  workflowId: string,
  plan: WorkflowPlan,
  providerScope: ProviderScope,
): CoralEventInput<WorkflowDeclaredBody> {
  return {
    type: 'workflow.plan.declared',
    stream: { kind: 'workflow', id: workflowId },
    refs: { workflowId },
    body: { plan, providerScope },
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
    body,
  };
}
