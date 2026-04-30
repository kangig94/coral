import type { Database } from 'better-sqlite3';

import type { ReadonlyDatabase } from '../kb/read-port.js';
import { CoralSetupError } from '../runtime/errors.js';
import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import {
  DEFAULT_SESSION_CONTROLLER,
  sessionControllerFromProfile,
  sessionEntrySchema,
  type SessionEntry,
} from './entry.js';
import type {
  SessionClaimedBody,
  SessionContinuityCheckpointedBody,
  SessionInterruptedBody,
  SessionOpenedBody,
} from './event-bodies.js';
import type { SessionAdapterUnparseableFault, SessionProviderFailedFault } from './fault.js';

export type ProjectionSessionRow = {
  controller: string;
  provider: string;
  resumable: boolean;
  conversationRef: string | null;
  scopeKey: string;
  entry: SessionEntry;
  lastSeq: number;
};

type SessionProjectionPatch = {
  entry?: SessionEntry;
  controller?: string;
  provider?: string;
  resumable?: boolean;
  conversationRef?: string | null;
  scopeKey?: string;
};

export function readProjectionSession(db: ReadonlyDatabase, sessionId: string): ProjectionSessionRow | null {
  const row = db
    .prepare(
      `SELECT controller, provider, resumable, conversation_ref, scope_key, entry, last_seq
         FROM projection_sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        controller: string;
        provider: string;
        resumable: number;
        conversation_ref: string | null;
        scope_key: string;
        entry: string;
        last_seq: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  const parsed = parseProjectionSessionEntry(sessionId, row.entry);

  return {
    controller: row.controller,
    provider: row.provider,
    resumable: row.resumable === 1,
    conversationRef: row.conversation_ref,
    scopeKey: row.scope_key,
    entry: parsed,
    lastSeq: row.last_seq,
  };
}

function parseProjectionSessionEntry(sessionId: string, rawEntry: string): SessionEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEntry) as unknown;
  } catch (error: unknown) {
    throw invalidProjectionSessionEntry(sessionId, error);
  }

  const result = sessionEntrySchema.safeParse(parsed);
  if (!result.success) {
    throw invalidProjectionSessionEntry(sessionId, result.error);
  }
  if (result.data.sessionId !== sessionId) {
    throw invalidProjectionSessionEntry(
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

function invalidProjectionSessionEntry(sessionId: string, cause: unknown): CoralSetupError {
  return new CoralSetupError({
    code: 'projection_sessions_invalid_entry',
    userMessage: `Session projection stored an invalid SessionEntry for ${sessionId}.`,
    remediation: 'Rebuild projection_sessions from Journal events after fixing the session reducer input.',
    context: {
      sessionId,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
  });
}

function assertEventEntryMatchesStream(event: { stream: { id: string } }, entry: SessionEntry): void {
  if (entry.sessionId === event.stream.id) {
    return;
  }

  throw new CoralSetupError({
    code: 'projection_sessions_entry_stream_mismatch',
    userMessage: `Session event body entry ${entry.sessionId} does not match stream ${event.stream.id}.`,
    remediation: 'Append session events with the SessionEntry for the same stream id.',
    context: { streamId: event.stream.id, entrySessionId: entry.sessionId },
  });
}

function upsertProjectionSession(
  db: Database,
  event: { stream: { id: string }; seq: number },
  patch: SessionProjectionPatch,
): void {
  const previous = readProjectionSession(db, event.stream.id);
  const entry = patch.entry ?? previous?.entry;
  if (entry === undefined) {
    throw prematureProjectionSessionEvent(event.stream.id);
  }
  assertEventEntryMatchesStream(event, entry);

  const scopeKey = patch.scopeKey ?? previous?.scopeKey;
  if (scopeKey === undefined) {
    throw prematureProjectionSessionEvent(event.stream.id);
  }
  const next = {
    controller:
      patch.controller ??
      previous?.controller ??
      sessionControllerFromProfile(entry.controllerProfile) ??
      DEFAULT_SESSION_CONTROLLER,
    provider: patch.provider ?? previous?.provider ?? entry.provider,
    resumable: patch.resumable ?? previous?.resumable ?? entry.state === 'ready',
    conversationRef: hasConversationRefPatch(patch)
      ? patch.conversationRef
      : (entry.conversationRef ?? previous?.conversationRef ?? null),
    scopeKey,
    entry,
  };

  upsertProjection(db, {
    table: 'projection_sessions',
    pkColumn: 'session_id',
    pkValue: event.stream.id,
    columns: {
      controller: next.controller,
      provider: next.provider,
      resumable: next.resumable ? 1 : 0,
      conversation_ref: next.conversationRef,
      scope_key: next.scopeKey,
      entry: JSON.stringify(next.entry),
    },
    lastSeq: event.seq,
  });
}

export const reduceSessionOpened: Reducer<SessionOpenedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
    controller: event.body.controller,
    provider: event.body.provider,
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

export const reduceSessionClaimed: Reducer<SessionClaimedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
  });
};

export const reduceSessionClaimReleased: Reducer<SessionClaimedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    entry: event.body.entry,
  });
};

export const reduceSessionInterrupted: Reducer<SessionInterruptedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    ...('fault' in event.body && event.body.entry !== undefined ? { entry: event.body.entry } : {}),
  });
};

export const reduceSessionProviderFailed: Reducer<SessionProviderFailedFault> = (db, event) => {
  upsertProjectionSession(db, event, {
    provider: event.body.provider,
  });
};

export const reduceSessionAdapterUnparseable: Reducer<SessionAdapterUnparseableFault> = (db, event) => {
  upsertProjectionSession(db, event, {
    provider: event.body.provider,
  });
};

export function readProjectionSessionEntry(db: ReadonlyDatabase, sessionId: string): SessionEntry | null {
  return readProjectionSession(db, sessionId)?.entry ?? null;
}

export function listProjectionSessionEntries(
  db: ReadonlyDatabase,
  provider?: string,
  scopeKey?: string,
): SessionEntry[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (provider !== undefined) {
    clauses.push('provider = ?');
    params.push(provider);
  }
  if (scopeKey !== undefined) {
    clauses.push('scope_key = ?');
    params.push(scopeKey);
  }

  const rows = db
    .prepare(
      `SELECT session_id, entry
         FROM projection_sessions
        ${clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`}
        ORDER BY session_id ASC`,
    )
    .all(...params) as Array<{ session_id: string; entry: string }>;

  return rows.map((row) => parseProjectionSessionEntry(row.session_id, row.entry));
}
