import type { AppendedEvent, CommitEventsFn } from '../store/append.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { decodeStoredBody, type StoreReadContext } from '../store/body-codec.js';
import { rowToCoralEvent, type CoralEvent } from '../store/envelope.js';
import type { EventsRow } from '../store/schema.js';
import { isRetentionDiscardDuplicateAttemptError } from './events.js';
import type {
  SessionRetentionDiscardCompletedBody,
  SessionRetentionDiscardFailedBody,
  SessionRetentionDiscardRequestedBody,
} from './event-bodies.js';
import type { RetentionDiscardCompletedOutcome } from './entry.js';

export type RetentionDiscardRequestedAppendResult =
  | { readonly kind: 'appended'; readonly appended: readonly AppendedEvent[] }
  | { readonly kind: 'duplicate' };

export type RetentionDiscardTerminalAppendResult = {
  readonly kind: 'appended';
  readonly appended: readonly AppendedEvent[];
};

function readRetentionDiscardEvents(db: ReadonlyDatabase, readCtx: StoreReadContext, sessionId: string): CoralEvent[] {
  return db
    .prepare<[string], EventsRow>(
      `SELECT * FROM events
        WHERE stream_id = ?
          AND type IN (
            'session.retention.discard.requested',
            'session.retention.discard.completed',
            'session.retention.discard.failed'
          )
        ORDER BY seq ASC`,
    )
    .all(sessionId)
    .map((row) => rowToCoralEvent(row, decodeStoredBody(row, readCtx)));
}

export function readNextRetentionDiscardAttempt(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  sessionId: string,
  minimumExclusive = 0,
): number {
  const durableMax = readRetentionDiscardEvents(db, readCtx, sessionId).reduce((maximum, event) => {
    const attempt = (event.body as { attempt: number }).attempt;
    return Math.max(maximum, attempt);
  }, 0);
  return Math.max(durableMax, minimumExclusive) + 1;
}

export function hasTerminalRetentionDiscardOutcome(
  db: ReadonlyDatabase,
  readCtx: StoreReadContext,
  sessionId: string,
): boolean {
  return readRetentionDiscardEvents(db, readCtx, sessionId).some(
    (event) =>
      event.type === 'session.retention.discard.failed' ||
      (event.type === 'session.retention.discard.completed' &&
        (event.body as SessionRetentionDiscardCompletedBody).outcome !== 'skipped_protected'),
  );
}

export function appendRetentionDiscardRequested(
  commitEvents: CommitEventsFn,
  body: SessionRetentionDiscardRequestedBody,
): RetentionDiscardRequestedAppendResult {
  try {
    const appended =
      commitEvents((c) => {
        c.append({
          type: 'session.retention.discard.requested',
          stream: { kind: 'session', id: body.sessionId },
          refs: { sessionId: body.sessionId },
          body: {
            sessionId: body.sessionId,
            attempt: body.attempt,
            handles: [...body.handles],
          },
        });
        return undefined;
      }) ?? [];
    return { kind: 'appended', appended };
  } catch (error: unknown) {
    if (isRetentionDiscardDuplicateAttemptError(error)) {
      return { kind: 'duplicate' };
    }
    throw error;
  }
}

export function appendRetentionDiscardCompleted(
  commitEvents: CommitEventsFn,
  body: Omit<SessionRetentionDiscardCompletedBody, 'outcome'> & {
    readonly outcome: RetentionDiscardCompletedOutcome;
  },
): RetentionDiscardTerminalAppendResult {
  const appended =
    commitEvents((c) => {
      c.append({
        type: 'session.retention.discard.completed',
        stream: { kind: 'session', id: body.sessionId },
        refs: { sessionId: body.sessionId },
        body: {
          sessionId: body.sessionId,
          attempt: body.attempt,
          handles: [...body.handles],
          outcome: body.outcome,
        },
      });
      return undefined;
    }) ?? [];
  return { kind: 'appended', appended };
}

export function appendRetentionDiscardFailed(
  commitEvents: CommitEventsFn,
  body: SessionRetentionDiscardFailedBody,
): RetentionDiscardTerminalAppendResult {
  const appended =
    commitEvents((c) => {
      c.append({
        type: 'session.retention.discard.failed',
        stream: { kind: 'session', id: body.sessionId },
        refs: { sessionId: body.sessionId },
        body: {
          sessionId: body.sessionId,
          attempt: body.attempt,
          handles: [...body.handles],
          reason: body.reason,
          ...(body.causeRef === undefined ? {} : { causeRef: body.causeRef }),
        },
      });
      return undefined;
    }) ?? [];
  return { kind: 'appended', appended };
}
