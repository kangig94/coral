import type { Database } from 'better-sqlite3';

import { upsertProjection } from '../store/projection-upsert.js';
import type { Reducer } from '../store/reducers.js';
import { DEFAULT_SESSION_CONTROLLER } from './entry.js';
import type { ContinuitySnapshot } from './continuity.js';
import type {
  SessionAdapterUnparseableFault,
  SessionCloseReason,
  SessionInterruptedFault,
  SessionProviderFailedFault,
} from './fault.js';

export type ProjectionSessionRow = {
  controller: string;
  provider: string;
  resumable: boolean;
  conversationRef: string | null;
  lastSeq: number;
};

type SessionOpenedBody = {
  controller: string;
  provider: string;
};

type SessionClosedBody = {
  reason: SessionCloseReason;
};

type SessionProjectionPatch = {
  controller?: string;
  provider?: string;
  resumable?: boolean;
  conversationRef?: string | null;
};

function readProjectionSession(
  db: Database,
  sessionId: string,
): Omit<ProjectionSessionRow, 'lastSeq'> | null {
  const row = db
    .prepare(
      `SELECT controller, provider, resumable, conversation_ref
         FROM projection_sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        controller: string;
        provider: string;
        resumable: number;
        conversation_ref: string | null;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    controller: row.controller,
    provider: row.provider,
    resumable: row.resumable === 1,
    conversationRef: row.conversation_ref,
  };
}

function hasConversationRefPatch(patch: SessionProjectionPatch): patch is SessionProjectionPatch & { conversationRef: string | null } {
  return Object.prototype.hasOwnProperty.call(patch, 'conversationRef');
}

function upsertProjectionSession(
  db: Database,
  event: { stream: { id: string }; seq: number },
  patch: SessionProjectionPatch,
): void {
  const previous = readProjectionSession(db, event.stream.id);
  const next = {
    controller: patch.controller ?? previous?.controller ?? DEFAULT_SESSION_CONTROLLER,
    provider: patch.provider ?? previous?.provider ?? 'unknown',
    resumable: patch.resumable ?? previous?.resumable ?? false,
    conversationRef: hasConversationRefPatch(patch) ? patch.conversationRef : (previous?.conversationRef ?? null),
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
    },
    lastSeq: event.seq,
  });
}

export const reduceSessionOpened: Reducer<SessionOpenedBody> = (db, event) => {
  upsertProjectionSession(db, event, {
    controller: event.body.controller,
    provider: event.body.provider,
    resumable: false,
    conversationRef: null,
  });
};

export const reduceSessionContinuityCheckpointed: Reducer<ContinuitySnapshot> = (db, event) => {
  upsertProjectionSession(db, event, {
    resumable: event.body.resumable,
    conversationRef: event.body.conversationRef,
  });
};

export const reduceSessionInterrupted: Reducer<SessionInterruptedFault> = (db, event) => {
  upsertProjectionSession(db, event, {});
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

export const reduceSessionClosed: Reducer<SessionClosedBody> = (db, event) => {
  upsertProjectionSession(db, event, {});
};
