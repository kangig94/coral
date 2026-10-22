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
import { readJobOpened } from './execution-state.js';

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
  const rows = ctx.db
    .prepare<[string], { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }>(
      `SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ?
     AND type IN ('job.execution.requested', 'job.execution.outcome.accepted', 'job.execution.ended',
       'job.retention.discard.requested', 'job.retention.discard.completed', 'job.retention.discard.failed') ORDER BY seq`,
    )
    .all(jobId);
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
  if (owner.kind === 'provider-session' && owner.id !== input.stream.id)
    orderViolation(input, 'the provider owner must name this job');
  if ((owner.kind === 'workflow') !== (workflowSlotId !== undefined))
    orderViolation(input, 'only workflow children carry a workflow slot');
  if (!ctx.providers.hasProvider(conversation.provider))
    orderViolation(input, 'the conversation provider is unavailable');
  const binding = ctx.providers.validatePersistedBinding(conversation.binding);
  if (!binding.ok) orderViolation(input, binding.message);
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
    if (input.type === 'job.opened') {
      if (state.opened !== null) orderViolation(input, 'job.opened may occur only once and first');
      const exists = ctx.db
        .prepare<
          [string],
          { found: number }
        >("SELECT 1 AS found FROM events WHERE stream_kind = 'job' AND stream_id = ? LIMIT 1")
        .get(input.stream.id);
      if (exists !== undefined) orderViolation(input, 'job.opened must be first');
      state.opened = jobOpenedBodySchema.parse(input.body);
      validateOpened(ctx, input, state.opened);
      continue;
    }
    if (state.opened === null) orderViolation(input, 'job.opened must be first');
    const { execution } = z.object({ execution: executionOrdinalSchema }).parse(input.body);
    if (input.type === 'job.execution.requested') {
      const request = jobExecutionRequestedBodySchema.parse(input.body);
      if (state.open) orderViolation(input, 'an execution is already open');
      if (execution !== state.execution + 1) orderViolation(input, 'ordinals must be consecutive from 1');
      if ((state.opened.jobKind === 'kb') !== (typeof request.input !== 'string'))
        orderViolation(input, 'input must match the job kind');
      if (state.opened.jobKind !== 'provider' && request.action !== 'exec')
        orderViolation(input, 'only provider jobs can resume');
      if ((state.opened.owner.kind === 'discussion') !== (request.discussionRun !== undefined))
        orderViolation(input, 'only discussion requests carry a run descriptor');
      if (execution > 1) {
        if (readProviderOperationForJob(ctx.db, input.stream.id) !== null)
          orderViolation(input, 'the preceding provider operation is not settled');
        if (state.opened.owner.kind === 'system-task') orderViolation(input, 'system-task owners cannot continue');
        if (state.opened.jobKind !== 'provider' || request.action !== 'resume')
          orderViolation(input, 'a continuation must resume its conversation');
        if (state.opened.owner.kind === 'provider-session' && request.originatingClientMessageId === undefined)
          orderViolation(input, 'provider continuation requires its jobs send message identity');
      }
      if (request.originatingClientMessageId !== undefined) {
        if (state.opened.owner.kind !== 'provider-session')
          orderViolation(input, 'only jobs send owns a continuation message identity');
        if (state.messages.has(request.originatingClientMessageId))
          orderViolation(input, 'a message identity already has a committed request');
        state.messages.add(request.originatingClientMessageId);
      }
      state.execution = execution;
      state.open = true;
      state.acceptedSeq = null;
      state.retention = null;
      continue;
    }
    if (!state.open || execution !== state.execution) orderViolation(input, 'event must name the open execution');
    const retentionEvent = input.type.startsWith('job.retention.discard.');
    if (state.acceptedSeq !== null && !retentionEvent && input.type !== 'job.execution.ended')
      orderViolation(input, 'only retention and ended may follow acceptance');
    if (input.type === 'job.execution.outcome.accepted') {
      const seq = ctx.sequences[index];
      if (seq === undefined) throw new Error('Missing reserved sequence for accepted outcome.');
      state.acceptedSeq = seq;
    } else if (input.type === 'job.retention.discard.requested') {
      if (state.acceptedSeq === null) orderViolation(input, 'retention requires an accepted outcome');
      if (state.retention !== null) orderViolation(input, 'retention already has a durable action');
      const request = jobRetentionDiscardRequestedBodySchema.parse(input.body);
      state.retention = { attempt: request.attempt, handles: request.handles, closed: false };
    } else if (retentionEvent) {
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
      state.retention.closed = true;
    } else if (input.type === 'job.execution.ended') {
      const end = jobExecutionEndedBodySchema.parse(input.body);
      if (
        state.acceptedSeq === null ||
        end.causeRef.stream.kind !== 'job' ||
        end.causeRef.stream.id !== input.stream.id ||
        end.causeRef.seq !== state.acceptedSeq
      )
        orderViolation(input, 'ended must cite this execution’s accepted outcome');
      const owesRetention =
        state.opened.jobKind === 'provider' &&
        state.opened.conversation.retention === 'discard_provider_artifacts_on_terminal';
      if ((owesRetention && state.retention === null) || state.retention?.closed === false)
        orderViolation(input, 'retention must close before ended');
      if (state.opened.jobKind === 'provider' && readProviderOperationForJob(ctx.db, input.stream.id) !== null)
        orderViolation(input, 'provider settlement must close before ended');
      state.open = false;
    }
  }
};

export const jobsRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({ type: 'job.opened', schema: jobOpenedBodySchema }),
    defineDomainEvent({ type: 'job.execution.requested', schema: jobExecutionRequestedBodySchema }),
    defineDomainEvent({ type: 'job.execution.queued', schema: jobQueueQueuedBodySchema }),
    defineDomainEvent({ type: 'job.execution.admitted', schema: jobQueueAdmittedBodySchema }),
    defineDomainEvent({ type: 'job.execution.started', schema: jobRuntimeStartedBodySchema }),
    defineDomainEvent({ type: 'job.execution.progress', schema: jobProgressBodySchema }),
    defineDomainEvent({ type: 'job.execution.aborted', schema: jobAbortedBodySchema }),
    defineDomainEvent({ type: 'job.execution.outcome.accepted', schema: jobExecutionOutcomeAcceptedBodySchema }),
    defineDomainEvent({ type: 'job.execution.ended', schema: jobExecutionEndedBodySchema }),
    defineDomainEvent({ type: 'job.continuity.checkpointed', schema: jobContinuityCheckpointedBodySchema }),
    defineDomainEvent({ type: 'job.artifact.recorded', schema: jobArtifactRecordedBodySchema }),
    defineDomainEvent({ type: 'job.retention.discard.requested', schema: jobRetentionDiscardRequestedBodySchema }),
    defineDomainEvent({ type: 'job.retention.discard.completed', schema: jobRetentionDiscardCompletedBodySchema }),
    defineDomainEvent({ type: 'job.retention.discard.failed', schema: jobRetentionDiscardFailedBodySchema }),
    defineDomainEvent({ type: 'job.interrupted', schema: jobInterruptedBodySchema }),
    defineDomainEvent({ type: 'job.provider_failed', schema: jobProviderFailedBodySchema }),
    defineDomainEvent({ type: 'job.adapter_unparseable', schema: jobAdapterUnparseableBodySchema }),
  ],
  appendValidators: [{ contract: 'jobs:execution-order', validate: validateJobExecutionOrder }],
};
