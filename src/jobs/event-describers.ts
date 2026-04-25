// Per-event describers for the `job/*` stream. Owned by the jobs domain and
// composed by `read-model/event-describers.ts` into the default
// `EventDescriberMap` consumed by `causality/render.ts`.

import type { EventDescriber, EventDescriberMap } from '../causality/render.js';
import { isRecord } from '../infra/json.js';
import {
  describeJobDomainProgress,
  describeJobProgressFault,
  describeLaunchRejected,
  describeTerminalOutcome,
} from './outcome.js';

const launchRequested: EventDescriber = () => 'Job launch requested.';

const launchRejected: EventDescriber = (event) =>
  isRecord(event.body)
    ? describeLaunchRejected(event.body as Parameters<typeof describeLaunchRejected>[0])
    : 'Job launch rejected.';

const queueQueued: EventDescriber = (event) =>
  isRecord(event.body) && typeof event.body.queuePosition === 'number'
    ? `Job queued at position ${event.body.queuePosition}.`
    : 'Job queued.';

const queueAdmitted: EventDescriber = () => 'Job admitted for launch.';

const runtimeStarted: EventDescriber = () => 'Job runtime started.';

const progressEmitted: EventDescriber = (event) => {
  if (!isRecord(event.body)) return 'Job progress emitted.';
  if (event.body.kind === 'message' && typeof event.body.message === 'string') return event.body.message;
  if (event.body.kind === 'domain' && typeof event.body.message === 'string') {
    return describeJobDomainProgress(event.body as Parameters<typeof describeJobDomainProgress>[0]);
  }
  return describeJobProgressFault(event.body as Parameters<typeof describeJobProgressFault>[0]);
};

const terminalRecorded: EventDescriber = (event) => {
  if (!isRecord(event.body) || !isRecord(event.body.terminal) || !isRecord(event.body.terminal.outcome)) {
    return 'Job terminal recorded.';
  }
  // Causality recurses on the next causeRef via extractCauseRef; here we
  // render only the local terminal sentence with a stable causeRef sketch.
  return describeTerminalOutcome(event.body.terminal.outcome as Parameters<typeof describeTerminalOutcome>[0], {
    describeCauseRef: (ref) => `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`,
  });
};

const aborted: EventDescriber = (event) =>
  isRecord(event.body) && typeof event.body.reason === 'string'
    ? `Job aborted: ${event.body.reason}.`
    : 'Job aborted.';

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
