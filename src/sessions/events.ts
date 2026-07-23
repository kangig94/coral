import { CoralSetupError } from '../runtime/errors.js';
import { isDeepStrictEqual } from 'node:util';
import type { CoralEventInput } from '../store/envelope.js';
import { rowToCoralEvent } from '../store/envelope.js';
import { decodeStoredBody } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import { defineDomainEvent, type DomainAppendValidator, type DomainEventRegistry } from '../store/reducers.js';
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
  type SessionRetentionDiscardCompletedBody,
  type SessionRetentionDiscardFailedBody,
  type SessionRetentionDiscardRequestedBody,
} from './event-bodies.js';
import {
  reduceSessionAdapterUnparseable,
  reduceSessionArtifactHandleRecorded,
  reduceSessionContinuationLeaseClaimed,
  reduceSessionContinuationLeaseCleared,
  reduceSessionContinuationLeaseExpired,
  reduceSessionContinuationLeaseRecorded,
  reduceSessionContinuityCheckpointed,
  reduceSessionInterrupted,
  reduceSessionClaimReleased,
  reduceSessionClaimed,
  reduceSessionOpened,
  reduceSessionProviderFailed,
  reduceSessionRetentionDiscardCompleted,
  reduceSessionRetentionDiscardFailed,
  reduceSessionRetentionDiscardRequested,
  readProjectionSessionEntriesById,
} from './projections.js';
import { providerSessionSchema, type ProviderSession } from './entry.js';

const RETENTION_DISCARD_DUPLICATE_ATTEMPT_CODE = 'session_retention_discard_duplicate_attempt';

type RetentionDiscardKind = 'requested' | 'completed' | 'failed';

type ParsedRetentionDiscardInput =
  | {
      readonly kind: 'requested';
      readonly type: 'session.retention.discard.requested';
      readonly sessionId: string;
      readonly attempt: number;
      readonly body: SessionRetentionDiscardRequestedBody;
    }
  | {
      readonly kind: 'completed';
      readonly type: 'session.retention.discard.completed';
      readonly sessionId: string;
      readonly attempt: number;
      readonly body: SessionRetentionDiscardCompletedBody;
    }
  | {
      readonly kind: 'failed';
      readonly type: 'session.retention.discard.failed';
      readonly sessionId: string;
      readonly attempt: number;
      readonly body: SessionRetentionDiscardFailedBody;
    };

type RetentionDiscardAttemptState = {
  requested: boolean;
  terminal: RetentionDiscardKind | null;
};

function retentionDiscardKey(sessionId: string, attempt: number): string {
  return `${sessionId}\u0000${attempt}`;
}

function retentionDiscardAttemptState(
  state: Map<string, RetentionDiscardAttemptState>,
  key: string,
): RetentionDiscardAttemptState {
  return state.get(key) ?? { requested: false, terminal: null };
}

function parseRetentionDiscardInput(input: CoralEventInput): ParsedRetentionDiscardInput | null {
  switch (input.type) {
    case 'session.retention.discard.requested': {
      const body = sessionRetentionDiscardRequestedBodySchema.parse(input.body);
      assertRetentionDiscardStream(input, body.sessionId);
      return { kind: 'requested', type: input.type, sessionId: body.sessionId, attempt: body.attempt, body };
    }
    case 'session.retention.discard.completed': {
      const body = sessionRetentionDiscardCompletedBodySchema.parse(input.body);
      assertRetentionDiscardStream(input, body.sessionId);
      return { kind: 'completed', type: input.type, sessionId: body.sessionId, attempt: body.attempt, body };
    }
    case 'session.retention.discard.failed': {
      const body = sessionRetentionDiscardFailedBodySchema.parse(input.body);
      assertRetentionDiscardStream(input, body.sessionId);
      return { kind: 'failed', type: input.type, sessionId: body.sessionId, attempt: body.attempt, body };
    }
    default:
      return null;
  }
}

function assertRetentionDiscardStream(input: CoralEventInput, sessionId: string): void {
  if (input.stream.kind === 'session' && input.stream.id === sessionId) {
    return;
  }

  throw new CoralSetupError({
    code: 'session_retention_discard_stream_mismatch',
    userMessage: `Retention discard event '${input.type}' must be appended on the matching session stream.`,
    remediation: 'Append retention discard events with stream.kind=session and stream.id equal to body.sessionId.',
    context: {
      type: input.type,
      streamKind: input.stream.kind,
      streamId: input.stream.id,
      sessionId,
    },
  });
}

function retentionDiscardViolation(code: string, message: string, context: Record<string, unknown>): CoralSetupError {
  return new CoralSetupError({
    code,
    userMessage: message,
    remediation:
      'Retention discard outbox events must follow requested -> exactly one terminal outcome per session attempt.',
    context,
  });
}

function duplicateRetentionDiscardAttempt(event: {
  readonly type: string;
  readonly sessionId: string;
  readonly attempt: number;
}): CoralSetupError {
  return retentionDiscardViolation(
    RETENTION_DISCARD_DUPLICATE_ATTEMPT_CODE,
    `Retention discard attempt ${event.attempt} for session '${event.sessionId}' was already requested.`,
    { type: event.type, sessionId: event.sessionId, attempt: event.attempt },
  );
}

function missingRetentionDiscardRequest(event: ParsedRetentionDiscardInput): CoralSetupError {
  return retentionDiscardViolation(
    'session_retention_discard_missing_request',
    `Retention discard terminal event '${event.type}' has no requested event for session '${event.sessionId}' attempt ${event.attempt}.`,
    { type: event.type, sessionId: event.sessionId, attempt: event.attempt },
  );
}

function duplicateRetentionDiscardTerminal(event: ParsedRetentionDiscardInput): CoralSetupError {
  return retentionDiscardViolation(
    'session_retention_discard_terminal_duplicate',
    `Retention discard terminal event '${event.type}' repeats a terminal outcome for session '${event.sessionId}' attempt ${event.attempt}.`,
    { type: event.type, sessionId: event.sessionId, attempt: event.attempt },
  );
}

function contradictoryRetentionDiscardTerminal(
  event: ParsedRetentionDiscardInput,
  existing: RetentionDiscardKind,
): CoralSetupError {
  return retentionDiscardViolation(
    'session_retention_discard_terminal_contradiction',
    `Retention discard terminal event '${event.type}' contradicts existing ${existing} outcome for session '${event.sessionId}' attempt ${event.attempt}.`,
    { type: event.type, sessionId: event.sessionId, attempt: event.attempt, existing },
  );
}

export function isRetentionDiscardDuplicateAttemptError(error: unknown): boolean {
  return error instanceof CoralSetupError && error.code === RETENTION_DISCARD_DUPLICATE_ATTEMPT_CODE;
}

function readExistingRetentionDiscardState(
  ctx: Parameters<DomainAppendValidator>[0],
  sessionIds: readonly string[],
): Map<string, RetentionDiscardAttemptState> {
  const state = new Map<string, RetentionDiscardAttemptState>();
  if (sessionIds.length === 0) {
    return state;
  }

  const placeholders = sessionIds.map(() => '?').join(', ');
  const rows = ctx.db
    .prepare<unknown[], EventsRow>(
      `SELECT *
         FROM events
        WHERE type IN (
            'session.retention.discard.requested',
            'session.retention.discard.completed',
            'session.retention.discard.failed'
          )
          AND stream_id IN (${placeholders})
        ORDER BY seq ASC`,
    )
    .all(...sessionIds);

  for (const row of rows) {
    const event = parseRetentionDiscardInput(rowToCoralEvent(row, decodeStoredBody(row, ctx.readCtx)));
    if (event === null) throw new Error(`Unexpected retention discard event type '${row.type}'.`);

    const key = retentionDiscardKey(event.sessionId, event.attempt);
    const current = retentionDiscardAttemptState(state, key);
    if (event.kind === 'requested') {
      current.requested = true;
    } else {
      current.terminal = event.kind;
    }
    state.set(key, current);
  }

  return state;
}

const validateRetentionDiscardStateMachine: DomainAppendValidator = (ctx, inputs) => {
  const parsed: ParsedRetentionDiscardInput[] = [];
  const sessionIds = new Set<string>();
  for (const input of inputs) {
    const event = parseRetentionDiscardInput(input);
    if (event === null) {
      continue;
    }
    parsed.push(event);
    sessionIds.add(event.sessionId);
  }

  if (parsed.length === 0) {
    return;
  }

  const state = readExistingRetentionDiscardState(ctx, [...sessionIds]);

  for (const event of parsed) {
    if (event.kind !== 'requested') {
      continue;
    }
    const key = retentionDiscardKey(event.sessionId, event.attempt);
    const current = retentionDiscardAttemptState(state, key);
    if (current.requested) {
      throw duplicateRetentionDiscardAttempt(event);
    }
    state.set(key, { ...current, requested: true });
  }

  for (const event of parsed) {
    if (event.kind === 'requested') {
      continue;
    }
    const key = retentionDiscardKey(event.sessionId, event.attempt);
    const current = retentionDiscardAttemptState(state, key);
    if (!current.requested) {
      throw missingRetentionDiscardRequest(event);
    }
    if (current.terminal !== null) {
      if (current.terminal === event.kind) {
        throw duplicateRetentionDiscardTerminal(event);
      }
      throw contradictoryRetentionDiscardTerminal(event, current.terminal);
    }
    state.set(key, { ...current, terminal: event.kind });
  }
};

function bindingIdentity(entry: ProviderSession): string {
  return JSON.stringify(entry.binding);
}

function withoutClaimTransitionFields(
  entry: ProviderSession,
): Omit<ProviderSession, 'activeJobId' | 'lastUsedAt' | 'version' | 'continuationLease'> {
  const {
    activeJobId: _activeJobId,
    lastUsedAt: _lastUsedAt,
    version: _version,
    continuationLease: _continuationLease,
    ...unchanged
  } = entry;
  return unchanged;
}

function claimTransitionViolation(input: CoralEventInput, jobId: string, message: string): never {
  throw new CoralSetupError({
    code: 'provider_session_claim_transition_invalid',
    userMessage: `Session '${input.stream.id}' ${message}.`,
    remediation: 'Append a complete next ProviderSession snapshot for exactly one claim transition.',
    context: { sessionId: input.stream.id, jobId, eventType: input.type },
  });
}

function validateClaimAuthority(
  input: CoralEventInput,
  prior: ProviderSession | undefined,
  next: ProviderSession,
): void {
  if (input.type === 'session.opened') {
    if (next.activeJobId !== undefined) {
      claimTransitionViolation(input, next.activeJobId, 'cannot open with an active job claim');
    }
    if (next.version !== 1) {
      claimTransitionViolation(input, '<none>', 'must open at durable version one');
    }
    return;
  }
  if (
    input.type === 'session.claimed' ||
    input.type === 'session.claim.released' ||
    input.type === 'session.continuation_lease.claimed' ||
    prior === undefined
  )
    return;
  if (prior.activeJobId !== next.activeJobId) {
    claimTransitionViolation(
      input,
      next.activeJobId ?? prior.activeJobId ?? '<none>',
      `cannot change its active job claim through '${input.type}'`,
    );
  }
}

function sameContinuationLeaseForClaim(prior: ProviderSession, next: ProviderSession, jobId: string): boolean {
  if (isDeepStrictEqual(prior.continuationLease, next.continuationLease)) return true;
  const before = prior.continuationLease;
  const after = next.continuationLease;
  if (before?.status !== 'pending' || after?.status !== 'claimed' || after.resumedJobId !== jobId) return false;
  const { status: _beforeStatus, ...beforeBase } = before;
  const { status: _afterStatus, resumedJobId: _resumedJobId, claimedAt: _claimedAt, ...afterBase } = after;
  return isDeepStrictEqual(beforeBase, afterBase);
}

function sameContinuationLeaseForRelease(prior: ProviderSession, next: ProviderSession, jobId: string): boolean {
  if (isDeepStrictEqual(prior.continuationLease, next.continuationLease)) return true;
  const before = prior.continuationLease;
  const after = next.continuationLease;
  if (
    before?.status !== 'claimed' ||
    before.resumedJobId !== jobId ||
    after?.status !== 'cleared' ||
    after.clearedByJobId !== jobId ||
    after.outcome !== 'resumed_released'
  ) {
    return false;
  }
  const { status: _beforeStatus, resumedJobId: _beforeResumed, claimedAt: _beforeClaimedAt, ...beforeBase } = before;
  const {
    status: _afterStatus,
    resumedJobId: _afterResumed,
    claimedAt: _afterClaimedAt,
    clearedAt: _clearedAt,
    clearedByJobId: _clearedByJobId,
    outcome: _outcome,
    ...afterBase
  } = after;
  return isDeepStrictEqual(beforeBase, afterBase);
}

function validateClaimTransition(input: CoralEventInput, prior: ProviderSession, next: ProviderSession): void {
  const body = sessionClaimedBodySchema.parse(input.body);
  if (
    input.refs?.sessionId !== next.sessionId ||
    input.refs.jobId !== body.jobId ||
    prior.activeJobId !== undefined ||
    next.activeJobId !== body.jobId ||
    next.version !== prior.version + 1 ||
    !isDeepStrictEqual(withoutClaimTransitionFields(prior), withoutClaimTransitionFields(next)) ||
    !sameContinuationLeaseForClaim(prior, next, body.jobId)
  ) {
    claimTransitionViolation(input, body.jobId, 'has an invalid claim transition');
  }
}

function validateClaimReleaseTransition(input: CoralEventInput, prior: ProviderSession, next: ProviderSession): void {
  const body = sessionClaimReleasedBodySchema.parse(input.body);
  if (
    input.refs?.sessionId !== next.sessionId ||
    input.refs.jobId !== body.jobId ||
    prior.activeJobId !== body.jobId ||
    next.activeJobId !== undefined ||
    next.version !== prior.version + 1 ||
    !isDeepStrictEqual(withoutClaimTransitionFields(prior), withoutClaimTransitionFields(next)) ||
    !sameContinuationLeaseForRelease(prior, next, body.jobId)
  ) {
    claimTransitionViolation(input, body.jobId, 'has an invalid claim release transition');
  }
}

function validateContinuationLeaseClaimTransition(
  input: CoralEventInput,
  prior: ProviderSession,
  next: ProviderSession,
): void {
  const body = sessionContinuationLeaseClaimedBodySchema.parse(input.body);
  const jobId = body.lease.resumedJobId;
  if (
    input.refs?.sessionId !== next.sessionId ||
    input.refs.jobId !== jobId ||
    prior.activeJobId !== undefined ||
    next.activeJobId !== jobId ||
    next.version !== prior.version + 1 ||
    !isDeepStrictEqual(withoutClaimTransitionFields(prior), withoutClaimTransitionFields(next)) ||
    !sameContinuationLeaseForClaim(prior, next, jobId)
  ) {
    claimTransitionViolation(input, jobId, 'has an invalid continuation replacement claim transition');
  }
}

const validateProviderSessionBinding: DomainAppendValidator = (ctx, inputs) => {
  const entries = inputs.flatMap((input) => {
    if (input.stream.kind !== 'session' || typeof input.body !== 'object' || input.body === null) return [];
    const rawEntry = (input.body as { entry?: unknown }).entry;
    const parsed = providerSessionSchema.safeParse(rawEntry);
    return parsed.success ? [{ input, entry: parsed.data }] : [];
  });
  if (entries.length === 0) return;

  const ids = [...new Set(entries.map(({ entry }) => entry.sessionId))];
  const existing = new Map<string, ProviderSession>();
  if (ids.length > 0) {
    for (const [sessionId, entry] of readProjectionSessionEntriesById(ctx.db, ids)) existing.set(sessionId, entry);
  }

  for (const { input, entry } of entries) {
    if (input.stream.id !== entry.sessionId) {
      throw new CoralSetupError({
        code: 'provider_session_stream_mismatch',
        userMessage: `Session event stream does not match entry '${entry.sessionId}'.`,
        remediation: 'Write the session entry to its own session stream.',
      });
    }
    const prior = existing.get(entry.sessionId);
    if (prior === undefined) {
      if (input.type !== 'session.opened') {
        throw new CoralSetupError({
          code: 'provider_session_missing',
          userMessage: `Session '${entry.sessionId}' must be opened before later events.`,
          remediation: 'Append session.opened first in the same batch.',
        });
      }
      const provider = entry.binding.provider;
      if (!ctx.providers.hasProvider(provider)) {
        throw new CoralSetupError({
          code: 'provider_session_provider_unregistered',
          userMessage: `Provider session '${entry.sessionId}' names unregistered provider '${provider}'.`,
          remediation: 'Register the provider and append a binding produced by its current binding codec.',
          context: { sessionId: entry.sessionId, provider },
        });
      }
      const bindingValidation = ctx.providers.validatePersistedBinding(entry.binding);
      if (!bindingValidation.ok) {
        throw new CoralSetupError({
          code: 'provider_session_binding_invalid',
          userMessage: `Provider session '${entry.sessionId}' binding was rejected by provider '${provider}'.`,
          remediation: bindingValidation.message,
          context: { sessionId: entry.sessionId, provider },
        });
      }
      validateClaimAuthority(input, undefined, entry);
      existing.set(entry.sessionId, entry);
      continue;
    }
    if (input.type === 'session.opened') {
      throw new CoralSetupError({
        code: 'provider_session_already_open',
        userMessage: `Session '${entry.sessionId}' is already open.`,
        remediation: 'Do not append a second session.opened event.',
      });
    }
    if (entry.version !== prior.version + 1) {
      claimTransitionViolation(
        input,
        entry.activeJobId ?? prior.activeJobId ?? '<none>',
        `must advance its durable version by exactly one through '${input.type}' (prior ${prior.version}, next ${entry.version})`,
      );
    }
    if (input.type === 'session.claimed') {
      validateClaimTransition(input, prior, entry);
    } else if (input.type === 'session.claim.released') {
      validateClaimReleaseTransition(input, prior, entry);
    } else if (input.type === 'session.continuation_lease.claimed') {
      validateContinuationLeaseClaimTransition(input, prior, entry);
    } else {
      validateClaimAuthority(input, prior, entry);
    }
    if (bindingIdentity(prior) !== bindingIdentity(entry)) {
      throw new CoralSetupError({
        code: 'provider_session_binding_mismatch',
        userMessage: `Provider session '${entry.sessionId}' binding is immutable.`,
        remediation: 'Resume with the original provider binding or start a new session.',
      });
    }
    existing.set(entry.sessionId, entry);
  }
};

export const sessionsRegistry: DomainEventRegistry = {
  streamKind: 'session',
  entries: [
    defineDomainEvent({
      type: 'session.opened',
      schema: sessionOpenedBodySchema,
      reducer: reduceSessionOpened,
      materializerContract: 'projection_sessions:insert-opened-provider-session',
    }),
    defineDomainEvent({
      type: 'session.continuity.checkpointed',
      schema: sessionContinuityCheckpointedBodySchema,
      reducer: reduceSessionContinuityCheckpointed,
      materializerContract: 'projection_sessions:replace-continuity-snapshot',
    }),
    defineDomainEvent({
      type: 'session.artifact.handle.recorded',
      schema: sessionArtifactHandleRecordedBodySchema,
      reducer: reduceSessionArtifactHandleRecorded,
      materializerContract: 'projection_sessions:append-artifact-handle',
    }),
    defineDomainEvent({
      type: 'session.claimed',
      schema: sessionClaimedBodySchema,
      reducer: reduceSessionClaimed,
      materializerContract: 'projection_sessions:acquire-active-job-claim',
    }),
    defineDomainEvent({
      type: 'session.claim.released',
      schema: sessionClaimReleasedBodySchema,
      reducer: reduceSessionClaimReleased,
      materializerContract: 'projection_sessions:release-active-job-claim',
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.recorded',
      schema: sessionContinuationLeaseRecordedBodySchema,
      reducer: reduceSessionContinuationLeaseRecorded,
      materializerContract: 'projection_sessions:record-pending-continuation-lease',
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.claimed',
      schema: sessionContinuationLeaseClaimedBodySchema,
      reducer: reduceSessionContinuationLeaseClaimed,
      materializerContract: 'projection_sessions:claim-continuation-lease',
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.cleared',
      schema: sessionContinuationLeaseClearedBodySchema,
      reducer: reduceSessionContinuationLeaseCleared,
      materializerContract: 'projection_sessions:clear-continuation-lease',
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.expired',
      schema: sessionContinuationLeaseExpiredBodySchema,
      reducer: reduceSessionContinuationLeaseExpired,
      materializerContract: 'projection_sessions:expire-continuation-lease',
    }),
    defineDomainEvent({
      type: 'session.retention.discard.requested',
      schema: sessionRetentionDiscardRequestedBodySchema,
      reducer: reduceSessionRetentionDiscardRequested,
      materializerContract: 'projection_sessions:record-retention-discard-request',
    }),
    defineDomainEvent({
      type: 'session.retention.discard.completed',
      schema: sessionRetentionDiscardCompletedBodySchema,
      reducer: reduceSessionRetentionDiscardCompleted,
      materializerContract: 'projection_sessions:complete-retention-discard',
    }),
    defineDomainEvent({
      type: 'session.retention.discard.failed',
      schema: sessionRetentionDiscardFailedBodySchema,
      reducer: reduceSessionRetentionDiscardFailed,
      materializerContract: 'projection_sessions:fail-retention-discard',
    }),
    defineDomainEvent({
      type: 'session.interrupted',
      schema: sessionInterruptedBodySchema,
      reducer: reduceSessionInterrupted,
      materializerContract: 'projection_sessions:record-interruption-fault',
    }),
    defineDomainEvent({
      type: 'session.provider_failed',
      schema: sessionProviderFailedBodySchema,
      reducer: reduceSessionProviderFailed,
      materializerContract: 'projection_sessions:record-provider-fault',
    }),
    defineDomainEvent({
      type: 'session.adapter_unparseable',
      schema: sessionAdapterUnparseableBodySchema,
      reducer: reduceSessionAdapterUnparseable,
      materializerContract: 'projection_sessions:record-adapter-fault',
    }),
  ],
  appendValidators: [
    { contract: 'sessions:retention-discard-state-machine', validate: validateRetentionDiscardStateMachine },
    {
      contract: 'sessions:binding-immutability-provider-codec-exact-single-event-claim-and-version-transitions',
      validate: validateProviderSessionBinding,
    },
  ],
};
