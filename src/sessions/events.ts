import { CoralSetupError } from '../runtime/errors.js';
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
} from './projections.js';
import { sessionEntrySchema, type SessionEntry } from './entry.js';

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
        WHERE stream_kind = 'session'
          AND type IN (
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

function authorityIdentity(entry: SessionEntry): string {
  return JSON.stringify({ provider: entry.provider, authority: entry.sessionAuthority });
}

const validateSessionAuthority: DomainAppendValidator = (ctx, inputs) => {
  const entries = inputs.flatMap((input) => {
    if (input.stream.kind !== 'session' || typeof input.body !== 'object' || input.body === null) return [];
    const rawEntry = (input.body as { entry?: unknown }).entry;
    const parsed = sessionEntrySchema.safeParse(rawEntry);
    return parsed.success ? [{ input, entry: parsed.data }] : [];
  });
  if (entries.length === 0) return;

  const ids = [...new Set(entries.map(({ entry }) => entry.sessionId))];
  const existing = new Map<string, SessionEntry>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = ctx.db
      .prepare(`SELECT session_id, entry FROM projection_sessions WHERE session_id IN (${placeholders})`)
      .all(...ids) as Array<{ session_id: string; entry: string }>;
    for (const row of rows) existing.set(row.session_id, sessionEntrySchema.parse(JSON.parse(row.entry)));
  }

  for (const { input, entry } of entries) {
    if (input.stream.id !== entry.sessionId) {
      throw new CoralSetupError({
        code: 'session_authority_invalid',
        userMessage: `Session event stream does not match entry '${entry.sessionId}'.`,
        remediation: 'Write the session entry to its own session stream.',
      });
    }
    const prior = existing.get(entry.sessionId);
    if (prior === undefined) {
      if (input.type !== 'session.opened') {
        throw new CoralSetupError({
          code: 'session_authority_missing',
          userMessage: `Session '${entry.sessionId}' must be opened before later events.`,
          remediation: 'Append session.opened first in the same batch.',
        });
      }
      if (entry.sessionAuthority.kind === 'provider' && entry.sessionAuthority.binding.provider !== entry.provider) {
        throw new CoralSetupError({
          code: 'session_authority_mismatch',
          userMessage: `Session '${entry.sessionId}' provider does not match its binding.`,
          remediation: 'Use the provider binding projected for the selected provider.',
        });
      }
      existing.set(entry.sessionId, entry);
      continue;
    }
    if (input.type === 'session.opened') {
      throw new CoralSetupError({
        code: 'session_authority_invalid',
        userMessage: `Session '${entry.sessionId}' is already open.`,
        remediation: 'Do not append a second session.opened event.',
      });
    }
    if (authorityIdentity(prior) !== authorityIdentity(entry)) {
      throw new CoralSetupError({
        code: 'session_authority_mismatch',
        userMessage: `Session '${entry.sessionId}' authority is immutable.`,
        remediation: 'Resume with the original provider binding or start a new session.',
      });
    }
    existing.set(entry.sessionId, entry);
  }
};

export const sessionsRegistry: DomainEventRegistry = {
  streamKind: 'session',
  entries: [
    defineDomainEvent({ type: 'session.opened', schema: sessionOpenedBodySchema, reducer: reduceSessionOpened }),
    defineDomainEvent({
      type: 'session.continuity.checkpointed',
      schema: sessionContinuityCheckpointedBodySchema,
      reducer: reduceSessionContinuityCheckpointed,
    }),
    defineDomainEvent({
      type: 'session.artifact.handle.recorded',
      schema: sessionArtifactHandleRecordedBodySchema,
      reducer: reduceSessionArtifactHandleRecorded,
    }),
    defineDomainEvent({ type: 'session.claimed', schema: sessionClaimedBodySchema, reducer: reduceSessionClaimed }),
    defineDomainEvent({
      type: 'session.claim.released',
      schema: sessionClaimReleasedBodySchema,
      reducer: reduceSessionClaimReleased,
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.recorded',
      schema: sessionContinuationLeaseRecordedBodySchema,
      reducer: reduceSessionContinuationLeaseRecorded,
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.claimed',
      schema: sessionContinuationLeaseClaimedBodySchema,
      reducer: reduceSessionContinuationLeaseClaimed,
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.cleared',
      schema: sessionContinuationLeaseClearedBodySchema,
      reducer: reduceSessionContinuationLeaseCleared,
    }),
    defineDomainEvent({
      type: 'session.continuation_lease.expired',
      schema: sessionContinuationLeaseExpiredBodySchema,
      reducer: reduceSessionContinuationLeaseExpired,
    }),
    defineDomainEvent({
      type: 'session.retention.discard.requested',
      schema: sessionRetentionDiscardRequestedBodySchema,
      reducer: reduceSessionRetentionDiscardRequested,
    }),
    defineDomainEvent({
      type: 'session.retention.discard.completed',
      schema: sessionRetentionDiscardCompletedBodySchema,
      reducer: reduceSessionRetentionDiscardCompleted,
    }),
    defineDomainEvent({
      type: 'session.retention.discard.failed',
      schema: sessionRetentionDiscardFailedBodySchema,
      reducer: reduceSessionRetentionDiscardFailed,
    }),
    defineDomainEvent({
      type: 'session.interrupted',
      schema: sessionInterruptedBodySchema,
      reducer: reduceSessionInterrupted,
    }),
    defineDomainEvent({
      type: 'session.provider_failed',
      schema: sessionProviderFailedBodySchema,
      reducer: reduceSessionProviderFailed,
    }),
    defineDomainEvent({
      type: 'session.adapter_unparseable',
      schema: sessionAdapterUnparseableBodySchema,
      reducer: reduceSessionAdapterUnparseable,
    }),
  ],
  appendValidators: [validateRetentionDiscardStateMachine, validateSessionAuthority],
};
