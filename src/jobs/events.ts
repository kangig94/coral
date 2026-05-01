import { defineDomainEvent, type DomainEventRegistry } from '../store/reducers.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import { jobAbortedBodySchema, jobLaunchRejectedSchema } from './outcome.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import {
  jobProgressBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
} from './event-bodies.js';
import {
  reduceJobAborted,
  reduceJobLaunchRejected,
  reduceJobLaunchRequested,
  reduceJobProgress,
  reduceJobQueueAdmitted,
  reduceJobQueueQueued,
  reduceJobRuntimeStarted,
  reduceJobTerminal,
  validateJobTerminalOrder,
} from './projections.js';

export const jobsRegistry: DomainEventRegistry = {
  streamKind: 'job',
  entries: [
    defineDomainEvent({
      type: 'job.launch.requested',
      schema: jobLaunchRequestBodySchema,
      reducer: reduceJobLaunchRequested,
    }),
    defineDomainEvent({
      type: 'job.launch.rejected',
      schema: jobLaunchRejectedSchema,
      reducer: reduceJobLaunchRejected,
    }),
    defineDomainEvent({ type: 'job.queue.queued', schema: jobQueueQueuedBodySchema, reducer: reduceJobQueueQueued }),
    defineDomainEvent({
      type: 'job.queue.admitted',
      schema: jobQueueAdmittedBodySchema,
      reducer: reduceJobQueueAdmitted,
    }),
    defineDomainEvent({
      type: 'job.runtime.started',
      schema: jobRuntimeStartedBodySchema,
      reducer: reduceJobRuntimeStarted,
    }),
    defineDomainEvent({ type: 'job.progress.emitted', schema: jobProgressBodySchema, reducer: reduceJobProgress }),
    defineDomainEvent({
      type: 'job.terminal.recorded',
      schema: jobTerminalRecordedBodySchema,
      reducer: reduceJobTerminal,
    }),
    defineDomainEvent({ type: 'job.aborted', schema: jobAbortedBodySchema, reducer: reduceJobAborted }),
  ],
  appendValidators: [validateJobTerminalOrder],
};
