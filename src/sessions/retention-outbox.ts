import type { AppendedEvent, CommitEventsFn } from '../store/append.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
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

export function readNextRetentionDiscardAttempt(db: ReadonlyDatabase, sessionId: string, minimumExclusive = 0): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(json_extract(CAST(body AS TEXT), '$.attempt')), 0) AS max_attempt
         FROM events
        WHERE stream_kind = 'session'
          AND stream_id = ?
          AND type IN (
            'session.retention.discard.requested',
            'session.retention.discard.completed',
            'session.retention.discard.failed'
          )`,
    )
    .get(sessionId) as { max_attempt: number | null } | undefined;
  const durableMax = row?.max_attempt ?? 0;
  return Math.max(durableMax, minimumExclusive) + 1;
}

export function hasTerminalRetentionDiscardOutcome(db: ReadonlyDatabase, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT seq
         FROM events
        WHERE stream_kind = 'session'
          AND stream_id = ?
          AND (
            type = 'session.retention.discard.failed'
            OR (
              type = 'session.retention.discard.completed'
              AND COALESCE(json_extract(CAST(body AS TEXT), '$.outcome'), '') != 'skipped_protected'
            )
          )
        LIMIT 1`,
    )
    .get(sessionId) as { seq: number } | undefined;
  return row !== undefined;
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
          bodyVersion: 1,
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
        bodyVersion: 1,
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
        bodyVersion: 1,
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
