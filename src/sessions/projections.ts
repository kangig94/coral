import { sqlParameterBatches, sqlPlaceholders, type Database } from '../store/db.js';

import type { ReadonlyDatabase } from '../store/read-port.js';
import { CoralSetupError } from '../runtime/errors.js';
import { isDeepStrictEqual } from 'node:util';
import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import {
  type RetentionDiscardAttempt,
  sessionControllerFromProfile,
  providerSessionSchema,
  providerSessionProvider,
  type ProviderSession,
} from './entry.js';
import type {
  SessionArtifactHandleRecordedBody,
  SessionClaimReleasedBody,
  SessionClaimedBody,
  SessionContinuationLeaseClaimedBody,
  SessionContinuationLeaseClearedBody,
  SessionContinuationLeaseExpiredBody,
  SessionContinuationLeaseRecordedBody,
  SessionContinuityCheckpointedBody,
  SessionRetentionDiscardCompletedBody,
  SessionRetentionDiscardFailedBody,
  SessionRetentionDiscardRequestedBody,
  SessionInterruptedBody,
  SessionOpenedBody,
} from './event-bodies.js';
import type { SessionAdapterUnparseableFault, SessionProviderFailedFault } from './fault.js';
import { z } from 'zod';

export const projectionSessionStoredRowSchema = z
  .object({
    session_id: z.string().min(1),
    controller: z.string().min(1),
    resumable: z.union([z.literal(0), z.literal(1)]),
    conversation_ref: z.string().min(1).nullable(),
    scope_key: z.string().min(1),
    entry: z.string(),
    last_seq: z.number().int().nonnegative(),
  })
  .strict();

export const projectionSessionDecoderContract = {
  entry: 'strict ProviderSession JSON',
  authority: [
    'entry.sessionId equals row.session_id',
    'controller equals controller derived from entry.controllerProfile',
    'resumable equals whether entry.state is ready',
    'conversation_ref equals entry.conversationRef or null',
  ],
} as const;

type ProjectionSessionStoredRow = z.infer<typeof projectionSessionStoredRowSchema>;

export type ProjectionSessionRow = {
  controller: string;
  provider: string;
  resumable: boolean;
  conversationRef: string | null;
  scopeKey: string;
  entry: ProviderSession;
  lastSeq: number;
};

type SessionProjectionPatch = Partial<Omit<ProjectionSessionRow, 'provider' | 'lastSeq'>>;

type SessionProjectionAuthority = {
  allowClaimTransition?: boolean;
};

export function readProjectionSession(db: ReadonlyDatabase, sessionId: string): ProjectionSessionRow | null {
  const rawRow = db
    .prepare(
      `SELECT controller, resumable, conversation_ref, scope_key, entry, last_seq
         FROM projection_sessions
        WHERE session_id = ?`,
    )
    .get(sessionId);

  if (rawRow === undefined) {
    return null;
  }
  const { row, entry } = decodeProjectionSessionAuthorityRow({ session_id: sessionId, ...(rawRow as object) });

  return {
    controller: row.controller,
    provider: providerSessionProvider(entry),
    resumable: row.resumable === 1,
    conversationRef: row.conversation_ref,
    scopeKey: row.scope_key,
    entry,
    lastSeq: row.last_seq,
  };
}

function decodeProjectionSessionStoredRow(raw: unknown): ProjectionSessionStoredRow {
  return projectionSessionStoredRowSchema.parse(raw);
}

function decodeProjectionSessionAuthorityRow(raw: unknown): {
  row: ProjectionSessionStoredRow;
  entry: ProviderSession;
} {
  const row = decodeProjectionSessionStoredRow(raw);
  const entry = parseProjectionProviderSession(row.session_id, row.entry);
  const expectedController = sessionControllerFromProfile(entry.controllerProfile);
  const expectedResumable = entry.state === 'ready' ? 1 : 0;
  const expectedConversationRef = entry.conversationRef ?? null;
  if (
    row.controller !== expectedController ||
    row.resumable !== expectedResumable ||
    row.conversation_ref !== expectedConversationRef
  ) {
    throw invalidProjectionProviderSession(
      row.session_id,
      new Error('Denormalized projection_sessions columns do not match the persisted ProviderSession entry.'),
    );
  }
  return { row, entry };
}

function parseProjectionProviderSession(sessionId: string, rawEntry: string): ProviderSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEntry) as unknown;
  } catch (error: unknown) {
    throw invalidProjectionProviderSession(sessionId, error);
  }

  const result = providerSessionSchema.safeParse(parsed);
  if (!result.success) {
    throw invalidProjectionProviderSession(sessionId, result.error);
  }
  if (result.data.sessionId !== sessionId) {
    throw invalidProjectionProviderSession(
      sessionId,
      new Error(`Projection entry sessionId '${result.data.sessionId}' does not match '${sessionId}'.`),
    );
  }
  return result.data;
}

function hasConversationRefPatch(
  patch: SessionProjectionPatch,
): patch is SessionProjectionPatch & { conversationRef: string | null } {
  return Object.prototype.hasOwnProperty.call(patch, 'conversationRef');
}

function prematureProjectionSessionEvent(sessionId: string): CoralSetupError {
  return new CoralSetupError({
    code: 'projection_sessions_premature_event',
    userMessage: `Session projection received a non-opened event before session.opened for ${sessionId}.`,
    remediation:
      'Append session.opened before any continuity, provider_failed, adapter_unparseable, or interrupted events for a session stream.',
    context: { sessionId },
  });
}

function invalidProjectionProviderSession(sessionId: string, cause: unknown): CoralSetupError {
  return new CoralSetupError({
    code: 'projection_sessions_invalid_entry',
    userMessage: `Session projection stored an invalid ProviderSession for ${sessionId}.`,
    remediation: 'Rebuild projection_sessions from Journal events after fixing the session reducer input.',
    context: {
      sessionId,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  });
}

function assertEventEntryMatchesStream(event: { stream: { id: string } }, entry: ProviderSession): void {
  if (entry.sessionId === event.stream.id) {
    return;
  }

  throw new CoralSetupError({
    code: 'projection_sessions_entry_stream_mismatch',
    userMessage: `Session event body entry ${entry.sessionId} does not match stream ${event.stream.id}.`,
    remediation: 'Append session events with the ProviderSession for the same stream id.',
    context: { streamId: event.stream.id, entrySessionId: entry.sessionId },
  });
}

function assertEventSessionIdMatchesStream(event: { stream: { id: string } }, sessionId: string): void {
  if (event.stream.id === sessionId) {
    return;
  }

  throw new CoralSetupError({
    code: 'projection_sessions_body_stream_mismatch',
    userMessage: `Session event body ${sessionId} does not match stream ${event.stream.id}.`,
    remediation: 'Append session events with stream.id equal to body.sessionId.',
    context: { streamId: event.stream.id, bodySessionId: sessionId },
  });
}

function upsertProjectionSession(
  db: Database,
  event: { type: string; stream: { id: string }; seq: number },
  patch: SessionProjectionPatch,
  authority: SessionProjectionAuthority = {},
): void {
  const previous = readProjectionSession(db, event.stream.id);
  const entry = patch.entry ?? previous?.entry;
  if (entry === undefined) {
    throw prematureProjectionSessionEvent(event.stream.id);
  }
  assertEventEntryMatchesStream(event, entry);
  if (
    patch.entry !== undefined &&
    !authority.allowClaimTransition &&
    previous?.entry.activeJobId !== entry.activeJobId
  ) {
    throw new CoralSetupError({
      code: 'provider_session_claim_transition_invalid',
      userMessage: `Session '${event.stream.id}' cannot change its active job claim through '${event.type}'.`,
      remediation:
        'Use only an exact session.claimed, session.claim.released, or continuation replacement claim transition to change activeJobId.',
      context: {
        sessionId: event.stream.id,
        eventType: event.type,
        priorActiveJobId: previous?.entry.activeJobId,
        nextActiveJobId: entry.activeJobId,
      },
    });
  }
  if (previous !== null) {
    if (!isDeepStrictEqual(previous.entry.binding, entry.binding)) {
      throw new CoralSetupError({
        code: 'provider_session_binding_mismatch',
        userMessage: `Provider session projection binding changed for ${event.stream.id}.`,
        remediation: 'Keep the provider binding immutable after session.opened.',
        context: { sessionId: event.stream.id },
      });
    }
  }

  const scopeKey = patch.scopeKey ?? previous?.scopeKey;
  if (scopeKey === undefined) {
    throw prematureProjectionSessionEvent(event.stream.id);
  }
  const next = {
    controller: patch.controller ?? previous?.controller ?? sessionControllerFromProfile(entry.controllerProfile),
    resumable: patch.resumable ?? previous?.resumable ?? entry.state === 'ready',
    conversationRef: hasConversationRefPatch(patch)
      ? patch.conversationRef
      : (entry.conversationRef ?? previous?.conversationRef ?? null),
    scopeKey,
    entry,
  };

  decodeProjectionSessionAuthorityRow({
    session_id: event.stream.id,
    controller: next.controller,
    resumable: next.resumable ? 1 : 0,
    conversation_ref: next.conversationRef,
    scope_key: next.scopeKey,
    entry: JSON.stringify(next.entry),
    last_seq: event.seq,
  });

  upsertProjection(db, {
    table: 'projection_sessions',
    pkColumn: 'session_id',
    pkValue: event.stream.id,
    columns: {
      controller: next.controller,
      resumable: next.resumable ? 1 : 0,
      conversation_ref: next.conversationRef,
      scope_key: next.scopeKey,
      entry: JSON.stringify(next.entry),
    },
    lastSeq: event.seq,
  });
}

export const reduceSessionOpened: Reducer<SessionOpenedBody> = (db, event) => {
  if (readProjectionSession(db, event.stream.id) !== null) {
    throw new Error(`Duplicate session.opened for '${event.stream.id}'.`);
  }
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
    controller: event.body.controller,
    resumable: false,
    conversationRef: null,
    scopeKey: event.body.scope_key,
  });
};

export const reduceSessionContinuityCheckpointed: Reducer<SessionContinuityCheckpointedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
    resumable: event.body.snapshot.resumable,
    conversationRef: event.body.snapshot.conversationRef,
  });
};

export const reduceSessionArtifactHandleRecorded: Reducer<SessionArtifactHandleRecordedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
  });
};

export const reduceSessionClaimed: Reducer<SessionClaimedBody> = (db, event) => {
  upsertProjectionSession(
    db,
    event,
    {
      entry: event.body.entry,
    },
    { allowClaimTransition: true },
  );
};

export const reduceSessionClaimReleased: Reducer<SessionClaimReleasedBody> = (db, event) => {
  upsertProjectionSession(
    db,
    event,
    {
      entry: event.body.entry,
    },
    { allowClaimTransition: true },
  );
};

function upsertContinuationLease(
  db: Database,
  event: { type: string; stream: { id: string }; seq: number },
  sessionId: string,
  entry: ProviderSession,
  authority: SessionProjectionAuthority = {},
): void {
  assertEventSessionIdMatchesStream(event, sessionId);
  upsertProjectionSession(
    db,
    event,
    {
      entry,
    },
    authority,
  );
}

export const reduceSessionContinuationLeaseRecorded: Reducer<SessionContinuationLeaseRecordedBody> = (db, event) => {
  upsertContinuationLease(db, event, event.body.sessionId, event.body.entry);
};

export const reduceSessionContinuationLeaseClaimed: Reducer<SessionContinuationLeaseClaimedBody> = (db, event) => {
  upsertContinuationLease(db, event, event.body.sessionId, event.body.entry, { allowClaimTransition: true });
};

export const reduceSessionContinuationLeaseCleared: Reducer<SessionContinuationLeaseClearedBody> = (db, event) => {
  upsertContinuationLease(db, event, event.body.sessionId, event.body.entry);
};

export const reduceSessionContinuationLeaseExpired: Reducer<SessionContinuationLeaseExpiredBody> = (db, event) => {
  upsertContinuationLease(db, event, event.body.sessionId, event.body.entry);
};

function upsertRetentionDiscardAttempt(
  db: Database,
  event: { type: string; stream: { id: string }; seq: number },
  attempt: RetentionDiscardAttempt,
): void {
  const previous = readProjectionSession(db, event.stream.id);
  if (previous === null) {
    throw prematureProjectionSessionEvent(event.stream.id);
  }

  const attempts = previous.entry.retentionDiscard.attempts.filter((entry) => entry.attempt !== attempt.attempt);
  upsertProjectionSession(db, event, {
    entry: {
      ...previous.entry,
      retentionDiscard: {
        attempts: [...attempts, attempt].sort((left, right) => left.attempt - right.attempt),
      },
      version: previous.entry.version + 1,
    },
  });
}

export const reduceSessionRetentionDiscardRequested: Reducer<SessionRetentionDiscardRequestedBody> = (db, event) => {
  upsertRetentionDiscardAttempt(db, event, {
    attempt: event.body.attempt,
    handles: event.body.handles,
    status: 'requested',
  });
};

export const reduceSessionRetentionDiscardCompleted: Reducer<SessionRetentionDiscardCompletedBody> = (db, event) => {
  upsertRetentionDiscardAttempt(db, event, {
    attempt: event.body.attempt,
    handles: event.body.handles,
    status: 'completed',
    outcome: event.body.outcome,
  });
};

export const reduceSessionRetentionDiscardFailed: Reducer<SessionRetentionDiscardFailedBody> = (db, event) => {
  upsertRetentionDiscardAttempt(db, event, {
    attempt: event.body.attempt,
    handles: event.body.handles,
    status: 'failed',
    reason: event.body.reason,
    ...(event.body.causeRef === undefined ? {} : { causeRef: event.body.causeRef }),
  });
};

export const reduceSessionInterrupted: Reducer<SessionInterruptedBody> = (db, event) => {
  upsertProjectionSession(db, event, {});
};

export const reduceSessionProviderFailed: Reducer<SessionProviderFailedFault> = (db, event) => {
  upsertProjectionSession(db, event, {});
};

export const reduceSessionAdapterUnparseable: Reducer<SessionAdapterUnparseableFault> = (db, event) => {
  upsertProjectionSession(db, event, {});
};

export function readProjectionProviderSession(db: ReadonlyDatabase, sessionId: string): ProviderSession | null {
  return readProjectionSession(db, sessionId)?.entry ?? null;
}

export function readProjectionSessionEntriesById(
  db: ReadonlyDatabase,
  sessionIds: readonly string[],
  onInvalidRow?: (sessionId: string | null, error: unknown) => void,
): Map<string, ProviderSession> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  if (uniqueSessionIds.length === 0) {
    return new Map();
  }

  const entries = new Map<string, ProviderSession>();
  for (const batch of sqlParameterBatches(uniqueSessionIds)) {
    const rows = db
      .prepare(
        `SELECT session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
           FROM projection_sessions
          WHERE session_id IN (${sqlPlaceholders(batch.length)})`,
      )
      .all(...batch);
    for (const rawRow of rows) {
      try {
        const { row, entry } = decodeProjectionSessionAuthorityRow(rawRow);
        entries.set(row.session_id, entry);
      } catch (error: unknown) {
        const sessionId =
          typeof rawRow === 'object' &&
          rawRow !== null &&
          typeof (rawRow as { session_id?: unknown }).session_id === 'string'
            ? (rawRow as { session_id: string }).session_id
            : null;
        onInvalidRow?.(sessionId, error);
      }
    }
  }
  return entries;
}

export function listProjectionSessionEntries(
  db: ReadonlyDatabase,
  provider?: string,
  scopeKey?: string,
  onInvalidRow?: (sessionId: string | null, error: unknown) => void,
): ProviderSession[] {
  const rows = db
    .prepare(
      `SELECT session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq
         FROM projection_sessions
        ORDER BY session_id ASC`,
    )
    .all();

  const decoded = rows.flatMap((raw) => {
    try {
      return [decodeProjectionSessionAuthorityRow(raw)];
    } catch (error: unknown) {
      if (onInvalidRow === undefined) {
        throw error;
      }
      const sessionId =
        typeof raw === 'object' && raw !== null && 'session_id' in raw && typeof raw.session_id === 'string'
          ? raw.session_id
          : null;
      onInvalidRow(sessionId, error);
      return [];
    }
  });
  const scoped = scopeKey === undefined ? decoded : decoded.filter(({ row }) => row.scope_key === scopeKey);
  const entries = scoped.map(({ entry }) => entry);
  return provider === undefined ? entries : entries.filter((entry) => providerSessionProvider(entry) === provider);
}
