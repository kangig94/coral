import { z } from 'zod';
import { readProviderOperationForJob } from '../store/provider-operation-journal.js';

import { CoralSetupError } from '../runtime/errors.js';
import { decodeStoredBody } from '../store/body-codec.js';
import type { CoralEventInput } from '../store/envelope.js';
import {
  defineDomainEvent,
  type DomainAppendValidator,
  type DomainAppendValidationContext,
  type DomainEventRegistry,
} from '../store/reducers.js';
import {
  jobProgressBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
  jobContinuityCheckpointedBodySchema,
  jobArtifactRecordedBodySchema,
  jobRetentionDiscardRequestedBodySchema,
  jobRetentionDiscardCompletedBodySchema,
  jobRetentionDiscardFailedBodySchema,
  jobInterruptedBodySchema,
  jobProviderFailedBodySchema,
  jobAdapterUnparseableBodySchema,
} from './event-bodies.js';
import {
  executionOrdinalSchema,
  jobOpenedBodySchema,
  jobExecutionRequestedBodySchema,
  type JobOpenedBody,
} from './launch.js';
import { jobAbortedBodySchema } from './outcome.js';
import { jobExecutionOutcomeAcceptedBodySchema, jobExecutionEndedBodySchema } from './terminal/result.js';
import { readJobOpened, readExecutionLifecycleEvents } from './execution-journal.js';

import {
  reduceJobOpened,
  reduceJobExecutionRequested,
  reduceJobQueueQueued,
  reduceJobQueueAdmitted,
  reduceJobRuntimeStarted,
  reduceJobProgress,
  reduceJobOutcomeAccepted,
  reduceJobExecutionEnded,
  reduceJobContinuityCheckpointed,
  reduceJobRetentionDiscardFailed,
  reduceJobObservation,
} from './projections.js';

interface ExecutionOrderState {
  opened: JobOpenedBody | null;
  execution: number;
  open: boolean;
  acceptedSeq: number | null;
  retention: { attempt: number; handles: readonly string[]; closed: boolean } | null;
  messages: Set<string>;
}

function orderViolation(input: CoralEventInput, reason: string): never {
  throw new CoralSetupError({
    code: 'job_execution_order_violation',
    userMessage: `Job '${input.stream.id}' violates execution order: ${reason}.`,
    remediation:
      'Append an opened job, consecutive non-overlapping executions, and finish each accepted outcome before continuing.',
    context: { jobId: input.stream.id, type: input.type, reason },
  });
}

function readOrderState(ctx: DomainAppendValidationContext, jobId: string): ExecutionOrderState {
  const state: ExecutionOrderState = {
    opened: readJobOpened(ctx.db, jobId, ctx.readCtx),
    execution: 0,
    open: false,
    acceptedSeq: null,
    retention: null,
    messages: new Set(),
  };
  const rows = readExecutionLifecycleEvents(ctx.db, jobId);
  for (const row of rows) {
    const body = decodeStoredBody(row, ctx.readCtx);
    if (row.type === 'job.execution.requested') {
      const request = jobExecutionRequestedBodySchema.parse(body);
      state.execution = request.execution;
      state.open = true;
      state.acceptedSeq = null;
      state.retention = null;
      if (request.originatingClientMessageId !== undefined) state.messages.add(request.originatingClientMessageId);
    } else if (row.type === 'job.execution.outcome.accepted') {
      state.acceptedSeq = row.seq;
    } else if (row.type === 'job.execution.ended') {
      state.open = false;
    } else if (row.type === 'job.retention.discard.requested') {
      const request = jobRetentionDiscardRequestedBodySchema.parse(body);
      state.retention = { attempt: request.attempt, handles: request.handles, closed: false };
    } else if (state.retention !== null) {
      state.retention.closed = true;
    }
  }
  return state;
}

function validateOpened(ctx: DomainAppendValidationContext, input: CoralEventInput, opened: JobOpenedBody): void {
  if (opened.jobKind === 'kb') {
    if (opened.owner.kind !== 'system-task') orderViolation(input, 'KB jobs require a system-task owner');
    return;
  }
  if (opened.jobKind === 'workflow') {
    if (opened.owner.kind !== 'workflow' || opened.owner.id !== input.stream.id)
      orderViolation(input, 'workflow jobs must own themselves');
    return;
  }
  const { owner, conversation, workflowSlotId } = opened;
  if (owner.kind === 'system-task') orderViolation(input, 'provider jobs require a conversation owner');
  if (owner.kind === 'provider-session' && owner.id !== input.stream.id)
    orderViolation(input, 'the provider owner must name this job');
  if ((owner.kind === 'workflow') !== (workflowSlotId !== undefined))
    orderViolation(input, 'only workflow children carry a workflow slot');
  if (!ctx.providers.hasProvider(conversation.provider))
    orderViolation(input, 'the conversation provider is unavailable');
  const binding = ctx.providers.validatePersistedBinding(conversation.binding);
  if (!binding.ok) orderViolation(input, binding.message);
}

type ExecutionOrderTransition =
  | { kind: 'opened'; opened: JobOpenedBody }
  | { kind: 'requested'; request: z.infer<typeof jobExecutionRequestedBodySchema> }
  | { kind: 'accepted'; seq: number }
  | { kind: 'retention-requested'; request: z.infer<typeof jobRetentionDiscardRequestedBodySchema> }
  | { kind: 'retention-closed' }
  | { kind: 'ended' }
  | { kind: 'unchanged' };

function validateContinuationRequest(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  opened: JobOpenedBody,
  request: z.infer<typeof jobExecutionRequestedBodySchema>,
): void {
  if (request.execution > 1) {
    if (readProviderOperationForJob(ctx.db, input.stream.id) !== null)
      orderViolation(input, 'the preceding provider operation is not settled');
    if (opened.owner.kind === 'system-task') orderViolation(input, 'system-task owners cannot continue');
    if (opened.jobKind !== 'provider' || request.action !== 'resume')
      orderViolation(input, 'a continuation must resume its conversation');
    if (opened.owner.kind === 'provider-session' && request.originatingClientMessageId === undefined)
      orderViolation(input, 'provider continuation requires its jobs send message identity');
  }
}

function validateExecutionReferences(input: CoralEventInput, opened: JobOpenedBody): void {
  const workflowId = opened.owner.kind === 'workflow' ? opened.owner.id : undefined;
  const expected = {
    workflowId,
    parentJobId: opened.jobKind === 'provider' ? workflowId : undefined,
    workflowSlotId: opened.jobKind === 'provider' ? opened.workflowSlotId : undefined,
  };
  for (const key of ['workflowId', 'parentJobId', 'workflowSlotId'] as const) {
    const actual = input.refs?.[key];
    if (actual !== undefined && actual !== expected[key])
      orderViolation(input, 'execution references must match the opened job’s owner and slot');
  }
}

function validateRequestMessageIdentity(
  input: CoralEventInput,
  state: ExecutionOrderState,
  opened: JobOpenedBody,
  request: z.infer<typeof jobExecutionRequestedBodySchema>,
): void {
  if (request.originatingClientMessageId !== undefined) {
    if (opened.owner.kind !== 'provider-session')
      orderViolation(input, 'only jobs send owns a continuation message identity');
    if (state.messages.has(request.originatingClientMessageId))
      orderViolation(input, 'a message identity already has a committed request');
  }
}

function validateExecutionRequest(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  state: ExecutionOrderState,
  opened: JobOpenedBody,
  execution: number,
): ExecutionOrderTransition {
  const request = jobExecutionRequestedBodySchema.parse(input.body);
  validateExecutionReferences(input, opened);
  if (state.open) orderViolation(input, 'an execution is already open');
  if (execution !== state.execution + 1) orderViolation(input, 'ordinals must be consecutive from 1');
  if ((opened.jobKind === 'kb') !== (typeof request.input !== 'string'))
    orderViolation(input, 'input must match the job kind');
  if (opened.jobKind !== 'provider' && request.action !== 'exec')
    orderViolation(input, 'only provider jobs can resume');
  if ((opened.owner.kind === 'discussion') !== (request.discussionRun !== undefined))
    orderViolation(input, 'only discussion requests carry a run descriptor');
  validateContinuationRequest(ctx, input, opened, request);
  validateRequestMessageIdentity(input, state, opened, request);
  return { kind: 'requested', request };
}

function validateExecutionEndCause(input: CoralEventInput, state: ExecutionOrderState): void {
  const end = jobExecutionEndedBodySchema.parse(input.body);
  if (
    state.acceptedSeq === null ||
    end.causeRef.stream.kind !== 'job' ||
    end.causeRef.stream.id !== input.stream.id ||
    end.causeRef.seq !== state.acceptedSeq
  )
    orderViolation(input, 'ended must cite this execution’s accepted outcome');
}

function validateExecutionEnd(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  state: ExecutionOrderState,
  opened: JobOpenedBody,
): void {
  validateExecutionEndCause(input, state);
  const owesRetention =
    opened.jobKind === 'provider' && opened.conversation.retention === 'discard_provider_artifacts_on_terminal';
  if ((owesRetention && state.retention === null) || state.retention?.closed === false)
    orderViolation(input, 'retention must close before ended');
  if (opened.jobKind === 'provider' && readProviderOperationForJob(ctx.db, input.stream.id) !== null)
    orderViolation(input, 'provider settlement must close before ended');
}

function validateRetentionTransition(input: CoralEventInput, state: ExecutionOrderState): ExecutionOrderTransition {
  if (input.type === 'job.retention.discard.requested') {
    if (state.acceptedSeq === null) orderViolation(input, 'retention requires an accepted outcome');
    if (state.retention !== null) orderViolation(input, 'retention already has a durable action');
    const request = jobRetentionDiscardRequestedBodySchema.parse(input.body);
    return { kind: 'retention-requested', request };
  }

  const result =
    input.type === 'job.retention.discard.completed'
      ? jobRetentionDiscardCompletedBodySchema.parse(input.body)
      : jobRetentionDiscardFailedBodySchema.parse(input.body);
  if (state.retention === null || state.retention.closed)
    orderViolation(input, 'retention must close one outstanding request');
  if (
    state.retention.attempt !== result.attempt ||
    JSON.stringify(state.retention.handles) !== JSON.stringify(result.handles)
  )
    orderViolation(input, 'retention outcome must identify the original action');
  return { kind: 'retention-closed' };
}

function validateOpeningTransition(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  state: ExecutionOrderState,
): ExecutionOrderTransition {
  if (state.opened !== null) orderViolation(input, 'job.opened may occur only once and first');
  const exists = ctx.db
    .prepare<
      [string],
      { found: number }
    >("SELECT 1 AS found FROM events WHERE stream_kind = 'job' AND stream_id = ? LIMIT 1")
    .get(input.stream.id);
  if (exists !== undefined) orderViolation(input, 'job.opened must be first');
  const opened = jobOpenedBodySchema.parse(input.body);
  validateOpened(ctx, input, opened);
  return { kind: 'opened', opened };
}

function validateOpenExecutionEvent(input: CoralEventInput, state: ExecutionOrderState, execution: number): void {
  if (!state.open || execution !== state.execution) orderViolation(input, 'event must name the open execution');
  const retentionEvent = input.type.startsWith('job.retention.discard.');
  if (state.acceptedSeq !== null && !retentionEvent && input.type !== 'job.execution.ended')
    orderViolation(input, 'only retention and ended may follow acceptance');
}

function validateOpenExecutionTransition(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  state: ExecutionOrderState,
  { execution, opened, index }: { execution: number; opened: JobOpenedBody; index: number },
): ExecutionOrderTransition {
  validateOpenExecutionEvent(input, state, execution);
  const retentionEvent = input.type.startsWith('job.retention.discard.');
  if (input.type === 'job.execution.outcome.accepted') {
    const seq = ctx.sequences[index];
    if (seq === undefined) throw new Error('Missing reserved sequence for accepted outcome.');
    return { kind: 'accepted', seq };
  }
  if (retentionEvent) return validateRetentionTransition(input, state);
  if (input.type === 'job.execution.ended') {
    validateExecutionEnd(ctx, input, state, opened);
    return { kind: 'ended' };
  }
  return { kind: 'unchanged' };
}

function validateOrderTransition(
  ctx: DomainAppendValidationContext,
  input: CoralEventInput,
  state: ExecutionOrderState,
  index: number,
): ExecutionOrderTransition {
  if (input.type === 'job.opened') return validateOpeningTransition(ctx, input, state);
  if (state.opened === null) orderViolation(input, 'job.opened must be first');
  const { execution } = z.object({ execution: executionOrdinalSchema }).parse(input.body);
  if (input.type === 'job.execution.requested')
    return validateExecutionRequest(ctx, input, state, state.opened, execution);
  return validateOpenExecutionTransition(ctx, input, state, { execution, opened: state.opened, index });
}

function applyOrderTransition(state: ExecutionOrderState, transition: ExecutionOrderTransition): void {
  switch (transition.kind) {
    case 'opened':
      state.opened = transition.opened;
      break;
    case 'requested':
      if (transition.request.originatingClientMessageId !== undefined)
        state.messages.add(transition.request.originatingClientMessageId);
      state.execution = transition.request.execution;
      state.open = true;
      state.acceptedSeq = null;
      state.retention = null;
      break;
    case 'accepted':
      state.acceptedSeq = transition.seq;
      break;
    case 'retention-requested':
      state.retention = { attempt: transition.request.attempt, handles: transition.request.handles, closed: false };
      break;
    case 'retention-closed':
      if (state.retention !== null) state.retention.closed = true;
      break;
    case 'ended':
      state.open = false;
      break;
    case 'unchanged':
      break;
  }
}

export const validateJobExecutionOrder: DomainAppendValidator = (ctx, inputs) => {
  const states = new Map<string, ExecutionOrderState>();
  for (const [index, input] of inputs.entries()) {
    if (input.stream.kind !== 'job') continue;
    z.string().uuid().parse(input.stream.id);
    let state = states.get(input.stream.id);
    if (state === undefined) {
      state = readOrderState(ctx, input.stream.id);
      states.set(input.stream.id, state);
    }
    applyOrderTransition(state, validateOrderTransition(ctx, input, state, index));
  }
};

export const jobsRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({
      type: 'job.opened',
      schema: jobOpenedBodySchema,
      reducer: reduceJobOpened,
      materializerContract: 'projection_jobs:job.opened',
    }),
    defineDomainEvent({
      type: 'job.execution.requested',
      schema: jobExecutionRequestedBodySchema,
      reducer: reduceJobExecutionRequested,
      materializerContract: 'projection_jobs:job.execution.requested',
    }),
    defineDomainEvent({
      type: 'job.execution.queued',
      schema: jobQueueQueuedBodySchema,
      reducer: reduceJobQueueQueued,
      materializerContract: 'projection_jobs:job.execution.queued',
    }),
    defineDomainEvent({
      type: 'job.execution.admitted',
      schema: jobQueueAdmittedBodySchema,
      reducer: reduceJobQueueAdmitted,
      materializerContract: 'projection_jobs:job.execution.admitted',
    }),
    defineDomainEvent({
      type: 'job.execution.started',
      schema: jobRuntimeStartedBodySchema,
      reducer: reduceJobRuntimeStarted,
      materializerContract: 'projection_jobs:job.execution.started',
    }),
    defineDomainEvent({
      type: 'job.execution.progress',
      schema: jobProgressBodySchema,
      reducer: reduceJobProgress,
      materializerContract: 'projection_jobs:job.execution.progress',
    }),
    defineDomainEvent({
      type: 'job.execution.aborted',
      schema: jobAbortedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.execution.aborted',
    }),
    defineDomainEvent({
      type: 'job.execution.outcome.accepted',
      schema: jobExecutionOutcomeAcceptedBodySchema,
      reducer: reduceJobOutcomeAccepted,
      materializerContract: 'projection_jobs:job.execution.outcome.accepted',
    }),
    defineDomainEvent({
      type: 'job.execution.ended',
      schema: jobExecutionEndedBodySchema,
      reducer: reduceJobExecutionEnded,
      materializerContract: 'projection_jobs:job.execution.ended',
    }),
    defineDomainEvent({
      type: 'job.continuity.checkpointed',
      schema: jobContinuityCheckpointedBodySchema,
      reducer: reduceJobContinuityCheckpointed,
      materializerContract: 'projection_jobs:job.continuity.checkpointed',
    }),
    defineDomainEvent({
      type: 'job.artifact.recorded',
      schema: jobArtifactRecordedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.artifact.recorded',
    }),
    defineDomainEvent({
      type: 'job.retention.discard.requested',
      schema: jobRetentionDiscardRequestedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.retention.discard.requested',
    }),
    defineDomainEvent({
      type: 'job.retention.discard.completed',
      schema: jobRetentionDiscardCompletedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.retention.discard.completed',
    }),
    defineDomainEvent({
      type: 'job.retention.discard.failed',
      schema: jobRetentionDiscardFailedBodySchema,
      reducer: reduceJobRetentionDiscardFailed,
      materializerContract: 'projection_jobs:job.retention.discard.failed',
    }),
    defineDomainEvent({
      type: 'job.interrupted',
      schema: jobInterruptedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.interrupted',
    }),
    defineDomainEvent({
      type: 'job.provider_failed',
      schema: jobProviderFailedBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.provider_failed',
    }),
    defineDomainEvent({
      type: 'job.adapter_unparseable',
      schema: jobAdapterUnparseableBodySchema,
      reducer: reduceJobObservation,
      materializerContract: 'projection_jobs:job.adapter_unparseable',
    }),
  ],
  appendValidators: [{ contract: 'jobs:execution-order', validate: validateJobExecutionOrder }],
};
