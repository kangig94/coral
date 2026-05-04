// Per-event describers for the `session/*` stream. Owned by the sessions
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import { assertNever } from '../infra/error-format.js';
import { ensureSentence } from '../infra/text.js';
import {
  sessionAdapterUnparseableBodySchema,
  sessionArtifactHandleRecordedBodySchema,
  sessionClaimReleasedBodySchema,
  sessionClaimedBodySchema,
  sessionContinuityCheckpointedBodySchema,
  sessionInterruptedBodySchema,
  sessionOpenedBodySchema,
  sessionProviderFailedBodySchema,
  sessionRetentionDiscardCompletedBodySchema,
  sessionRetentionDiscardFailedBodySchema,
  sessionRetentionDiscardRequestedBodySchema,
} from './event-bodies.js';
import { continuitySentenceFragment, type SessionContinuityState } from './fault.js';

// sessions/fault.ts is the canonical authority with exhaustive-switch +
// assertNever. Runtime-injected values are rendered as diagnostics instead of
// widening the type.
function safeContinuitySentenceFragment(value: SessionContinuityState): string {
  try {
    return continuitySentenceFragment(value);
  } catch {
    return 'continuity unavailable';
  }
}

function describeSessionUnavailable(provider: string, reason: string): string {
  const detail = ensureSentence(reason);
  switch (provider) {
    case 'codex':
      return `Codex session unavailable: ${detail} Start a new Coral session or resume without --session.`;
    case 'claude':
      return `Claude session unavailable: ${detail} Start a new Coral session before forking.`;
    default:
      return `${provider} session unavailable: ${detail}`;
  }
}

const opened = typedDescriber(sessionOpenedBodySchema, () => 'Session opened.');
const continuityCheckpointed = typedDescriber(
  sessionContinuityCheckpointedBodySchema,
  () => 'Session continuity checkpointed.',
);
const artifactHandleRecorded = typedDescriber(
  sessionArtifactHandleRecordedBodySchema,
  (body) => `Session artifact handle recorded for ${body.provider}.`,
);
const claimed = typedDescriber(sessionClaimedBodySchema, (body) => `Session claimed by job ${body.jobId}.`);
const claimReleased = typedDescriber(
  sessionClaimReleasedBodySchema,
  (body) => `Session claim released by job ${body.jobId}.`,
);
const retentionDiscardRequested = typedDescriber(
  sessionRetentionDiscardRequestedBodySchema,
  (body) => `Session retention discard attempt ${body.attempt} requested.`,
);
const retentionDiscardCompleted = typedDescriber(
  sessionRetentionDiscardCompletedBodySchema,
  (body) => `Session retention discard attempt ${body.attempt} completed with ${body.outcome}.`,
);
const retentionDiscardFailed = typedDescriber(
  sessionRetentionDiscardFailedBodySchema,
  (body) => `Session retention discard attempt ${body.attempt} failed: ${ensureSentence(body.reason)}`,
);

const interrupted = typedDescriber(sessionInterruptedBodySchema, (body) => {
  // sessionInterruptedBodySchema is a union of two shapes; both expose a
  // `trigger` and `continuity` reachable through the fault, so normalize first.
  const fault = 'fault' in body ? body.fault : body;
  const continuity = fault.continuity ?? 'unavailable';
  const triggerText =
    fault.trigger === 'restart'
      ? 'App-server restarted during the turn'
      : 'App-server handoff occurred during the turn';
  return `${triggerText}; ${safeContinuitySentenceFragment(continuity)}.`;
});

const providerFailed = typedDescriber(sessionProviderFailedBodySchema, (body) => {
  switch (body.reason) {
    case 'session_unavailable':
      return describeSessionUnavailable(body.provider, body.message);
    case 'request_failed':
      return `${body.provider} turn failed: ${ensureSentence(body.message)}`;
    default:
      return assertNever(body.reason);
  }
});

const adapterUnparseable = typedDescriber(
  sessionAdapterUnparseableBodySchema,
  (body) => `${body.provider} produced unparseable output: ${ensureSentence(body.parseError)}`,
);

export const sessionsEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['session:session.opened', opened],
  ['session:session.continuity.checkpointed', continuityCheckpointed],
  ['session:session.artifact.handle.recorded', artifactHandleRecorded],
  ['session:session.claimed', claimed],
  ['session:session.claim.released', claimReleased],
  ['session:session.retention.discard.requested', retentionDiscardRequested],
  ['session:session.retention.discard.completed', retentionDiscardCompleted],
  ['session:session.retention.discard.failed', retentionDiscardFailed],
  ['session:session.interrupted', interrupted],
  ['session:session.provider_failed', providerFailed],
  ['session:session.adapter_unparseable', adapterUnparseable],
]);
