import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import { jobOpenedBodySchema, jobExecutionRequestedBodySchema } from './launch.js';
import { describeJobProgressFault, describeTerminalOutcome, jobAbortedBodySchema } from './outcome.js';
import { jobExecutionOutcomeAcceptedBodySchema, jobExecutionEndedBodySchema } from './terminal/result.js';
import {
  jobProgressBodySchema,
  jobContinuityCheckpointedBodySchema,
  jobArtifactRecordedBodySchema,
  jobRetentionDiscardRequestedBodySchema,
  jobRetentionDiscardCompletedBodySchema,
  jobRetentionDiscardFailedBodySchema,
  jobInterruptedBodySchema,
  jobProviderFailedBodySchema,
  jobAdapterUnparseableBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
} from './event-bodies.js';

const opened = typedDescriber(jobOpenedBodySchema, () => 'Job opened.');
const executionRequested = typedDescriber(
  jobExecutionRequestedBodySchema,
  (body) => `Execution #${body.execution} requested.`,
);

const queueQueued = typedDescriber(jobQueueQueuedBodySchema, (body) => `Job queued at position ${body.queuePosition}.`);

const queueAdmitted = typedDescriber(jobQueueAdmittedBodySchema, () => 'Job admitted for launch.');

const runtimeStarted = typedDescriber(jobRuntimeStartedBodySchema, () => 'Job runtime started.');

const progressEmitted = typedDescriber(jobProgressBodySchema, (body, event) => {
  switch (body.kind) {
    case 'message':
      return body.message;
    case 'domain':
      if (
        body.stage === 'provider_operation_failed' &&
        typeof body.detail === 'object' &&
        body.detail !== null &&
        'code' in body.detail &&
        body.detail.code === 'activation_indeterminate'
      ) {
        return (
          `${body.message} Activation indeterminate [activation_indeterminate]: the provider may have started. ` +
          `Run \`coral-cli jobs detail ${event.stream.id}\` to inspect the durable job record before deciding whether to retry.`
        );
      }
      return body.message;
    case 'missing_launch_record':
    case 'recovery_parse_failed':
      return describeJobProgressFault(body);
  }
});

const outcomeAccepted = typedDescriber(jobExecutionOutcomeAcceptedBodySchema, (body) =>
  describeTerminalOutcome(body.terminal.outcome, {
    describeCauseRef: (ref) => `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`,
  }),
);

const aborted = typedDescriber(jobAbortedBodySchema, (body) => `Job aborted: ${body.reason}.`);

export const jobsEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['job:job.opened', opened],
  ['job:job.execution.requested', executionRequested],
  ['job:job.execution.queued', queueQueued],
  ['job:job.execution.admitted', queueAdmitted],
  ['job:job.execution.started', runtimeStarted],
  ['job:job.execution.progress', progressEmitted],
  ['job:job.execution.outcome.accepted', outcomeAccepted],
  ['job:job.execution.aborted', aborted],
  [
    'job:job.execution.ended',
    typedDescriber(jobExecutionEndedBodySchema, (body) => `Execution #${body.execution} ended.`),
  ],
  [
    'job:job.continuity.checkpointed',
    typedDescriber(jobContinuityCheckpointedBodySchema, () => 'Conversation continuity checkpointed.'),
  ],
  [
    'job:job.artifact.recorded',
    typedDescriber(jobArtifactRecordedBodySchema, (body) => `Provider artifact recorded: ${body.handle}.`),
  ],
  [
    'job:job.retention.discard.requested',
    typedDescriber(jobRetentionDiscardRequestedBodySchema, () => 'Conversation retention requested.'),
  ],
  [
    'job:job.retention.discard.completed',
    typedDescriber(
      jobRetentionDiscardCompletedBodySchema,
      (body) => `Conversation retention completed: ${body.outcome}.`,
    ),
  ],
  [
    'job:job.retention.discard.failed',
    typedDescriber(jobRetentionDiscardFailedBodySchema, (body) => `Conversation retention failed: ${body.reason}`),
  ],
  [
    'job:job.interrupted',
    typedDescriber(
      jobInterruptedBodySchema,
      (body) => `Execution interrupted by ${body.trigger}; continuity ${body.continuity}.`,
    ),
  ],
  [
    'job:job.provider_failed',
    typedDescriber(jobProviderFailedBodySchema, (body) => `${body.provider} request failed: ${body.message}`),
  ],
  [
    'job:job.adapter_unparseable',
    typedDescriber(
      jobAdapterUnparseableBodySchema,
      (body) => `${body.provider} output could not be parsed: ${body.parseError}`,
    ),
  ],
]);
