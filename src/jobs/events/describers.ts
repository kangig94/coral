// Per-event describers for the `job/*` stream. Owned by the jobs domain and
// composed by `read-model/event-describers.ts` into the default
// `EventDescriberMap` consumed by `causality/render.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../../causality/render.js';
import { jobLaunchRequestBodySchema } from '../launch.js';
import {
  describeJobDomainProgress,
  describeJobProgressFault,
  describeLaunchRejected,
  describeTerminalOutcome,
  jobAbortedBodySchema,
  jobLaunchRejectedSchema,
} from '../outcome.js';
import { jobTerminalRecordedBodySchema } from '../terminal/result.js';
import {
  jobProgressBodySchema,
  jobQueueAdmittedBodySchema,
  jobQueueQueuedBodySchema,
  jobRuntimeStartedBodySchema,
} from './bodies.js';

const launchRequested = typedDescriber(jobLaunchRequestBodySchema, () => 'Job launch requested.');

const launchRejected = typedDescriber(jobLaunchRejectedSchema, (body) => describeLaunchRejected(body));

const queueQueued = typedDescriber(jobQueueQueuedBodySchema, (body) => `Job queued at position ${body.queuePosition}.`);

const queueAdmitted = typedDescriber(jobQueueAdmittedBodySchema, () => 'Job admitted for launch.');

const runtimeStarted = typedDescriber(jobRuntimeStartedBodySchema, () => 'Job runtime started.');

const progressEmitted = typedDescriber(jobProgressBodySchema, (body) => {
  switch (body.kind) {
    case 'message':
      return body.message;
    case 'domain':
      return describeJobDomainProgress(body);
    case 'missing_launch_record':
    case 'recovery_parse_failed':
      return describeJobProgressFault(body);
  }
});

const terminalRecorded = typedDescriber(jobTerminalRecordedBodySchema, (body) =>
  // Causality recurses on the next causeRef via extractCauseRef; here we
  // render only the local terminal sentence with a stable causeRef sketch.
  describeTerminalOutcome(body.terminal.outcome, {
    describeCauseRef: (ref) => `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`,
  }),
);

const aborted = typedDescriber(jobAbortedBodySchema, (body) => `Job aborted: ${body.reason}.`);

export const jobsEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['job:job.launch.requested', launchRequested],
  ['job:job.launch.rejected', launchRejected],
  ['job:job.queue.queued', queueQueued],
  ['job:job.queue.admitted', queueAdmitted],
  ['job:job.runtime.started', runtimeStarted],
  ['job:job.progress.emitted', progressEmitted],
  ['job:job.terminal.recorded', terminalRecorded],
  ['job:job.aborted', aborted],
]);
