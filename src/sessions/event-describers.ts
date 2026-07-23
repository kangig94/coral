// Per-event describers for the `session/*` stream. Owned by the sessions
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import { assertNever } from '../infra/error-format.js';
import { ensureSentence, truncate } from '../infra/text.js';
import {
  sessionAdapterUnparseableBodySchema,
  sessionArtifactHandleRecordedBodySchema,
  sessionClaimReleasedBodySchema,
  sessionClaimedBodySchema,
  sessionContinuationLeaseClaimedBodySchema,
  sessionContinuationLeaseClearedBodySchema,
  sessionContinuationLeaseExpiredBodySchema,
  sessionContinuationLeaseRecordedBodySchema,
  sessionContinuityCheckpointedBodySchema,
  sessionInterruptedBodySchema,
  sessionOpenedBodySchema,
  sessionProviderFailedBodySchema,
  sessionRetentionDiscardCompletedBodySchema,
  sessionRetentionDiscardFailedBodySchema,
  sessionRetentionDiscardRequestedBodySchema,
} from './event-bodies.js';
import {
  continuitySentenceFragment,
  type SessionContinuityState,
  type SessionProviderFailureDiagnostic,
} from './fault.js';
import { providerSessionProvider } from './entry.js';

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
      return `Codex session unavailable: ${detail} Start a new Coral session.`;
    case 'claude':
      return `Claude session unavailable: ${detail} Start a new Coral session.`;
    default:
      return `${provider} session unavailable: ${detail}`;
  }
}

function describeProviderFailureDiagnostic(diagnostic: SessionProviderFailureDiagnostic | undefined): string {
  if (diagnostic === undefined) {
    return '';
  }

  const childOutputTail =
    diagnostic.childOutputTail.length === 0
      ? ''
      : ` childOutputTail=${JSON.stringify(truncate(diagnostic.childOutputTail, 120))};`;
  const transcriptTail =
    diagnostic.transcriptTail.length === 0
      ? ''
      : ` transcriptTail=${JSON.stringify(truncate(diagnostic.transcriptTail, 120))};`;
  return ` Diagnostic: reason=${diagnostic.reason}; phase=${diagnostic.phase}; idleMs=${diagnostic.idleMs}; attempts=${diagnostic.attempts}; sessionId=${diagnostic.sessionId ?? 'null'}; conversationRef=${diagnostic.conversationRef ?? 'null'};${childOutputTail}${transcriptTail}`;
}

const opened = typedDescriber(sessionOpenedBodySchema, () => 'Session opened.');
const continuityCheckpointed = typedDescriber(
  sessionContinuityCheckpointedBodySchema,
  () => 'Session continuity checkpointed.',
);
const artifactHandleRecorded = typedDescriber(
  sessionArtifactHandleRecordedBodySchema,
  (body) => `Session artifact handle recorded for ${providerSessionProvider(body.entry)}.`,
);
const claimed = typedDescriber(sessionClaimedBodySchema, (body) => `Session claimed by job ${body.jobId}.`);
const claimReleased = typedDescriber(
  sessionClaimReleasedBodySchema,
  (body) => `Session claim released by job ${body.jobId}.`,
);
const continuationLeaseRecorded = typedDescriber(
  sessionContinuationLeaseRecordedBodySchema,
  (body) => `Session continuation lease recorded for stale job ${body.lease.staleJobId}.`,
);
const continuationLeaseClaimed = typedDescriber(
  sessionContinuationLeaseClaimedBodySchema,
  (body) => `Session continuation lease claimed by resumed job ${body.lease.resumedJobId}.`,
);
const continuationLeaseCleared = typedDescriber(
  sessionContinuationLeaseClearedBodySchema,
  (body) => `Session continuation lease cleared with ${body.lease.outcome}.`,
);
const continuationLeaseExpired = typedDescriber(
  sessionContinuationLeaseExpiredBodySchema,
  (body) => `Session continuation lease expired for stale job ${body.lease.staleJobId}.`,
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
  const continuity = body.continuity ?? 'unavailable';
  const triggerText =
    body.trigger === 'restart' ? 'App-server restarted during the turn' : 'App-server handoff occurred during the turn';
  return `${triggerText}; ${safeContinuitySentenceFragment(continuity)}.`;
});

const providerFailed = typedDescriber(sessionProviderFailedBodySchema, (body) => {
  const diagnostic = describeProviderFailureDiagnostic(body.diagnostic);
  switch (body.reason) {
    case 'session_unavailable':
      return `${describeSessionUnavailable(body.provider, body.message)}${diagnostic}`;
    case 'request_failed':
      return `${body.provider} turn failed: ${ensureSentence(body.message)}${diagnostic}`;
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
  ['session:session.continuation_lease.recorded', continuationLeaseRecorded],
  ['session:session.continuation_lease.claimed', continuationLeaseClaimed],
  ['session:session.continuation_lease.cleared', continuationLeaseCleared],
  ['session:session.continuation_lease.expired', continuationLeaseExpired],
  ['session:session.retention.discard.requested', retentionDiscardRequested],
  ['session:session.retention.discard.completed', retentionDiscardCompleted],
  ['session:session.retention.discard.failed', retentionDiscardFailed],
  ['session:session.interrupted', interrupted],
  ['session:session.provider_failed', providerFailed],
  ['session:session.adapter_unparseable', adapterUnparseable],
]);
