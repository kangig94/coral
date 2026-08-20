// Discuss-owned watch surface — type contracts plus the projection-aware
// builder that materializes them. `WatchEvent` and `WatchState` describe the
// shape of watch data produced by projections and consumed by the execution
// runtime; `buildDiscussWatchState` is the canonical construction.

import type { DiscussDomainEvent, PersistedDiscussSnapshot } from './events.js';

export type WatchEvent = {
  type: 'bid_resolved' | 'speech_done' | 'epoch_transition' | 'session_ended';
  data: Record<string, unknown>;
  ts: number;
};

export type WatchState = {
  session: string;
  status: string;
  topic: string;
  epoch: number;
  step: number;
  events: WatchEvent[];
  cursor: number;
};

export type DiscussWatchReadErrorCode = 'session_not_found' | 'invalid_cursor';

export class DiscussWatchReadError extends Error {
  readonly code: DiscussWatchReadErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: DiscussWatchReadErrorCode, detail?: Record<string, unknown>) {
    super(code);
    this.name = 'DiscussWatchReadError';
    this.code = code;
    this.detail = detail;
  }
}

function parseWatchEventTs(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildWatchEvents(events: DiscussDomainEvent[]): WatchEvent[] {
  const watchEvents: WatchEvent[] = [];

  for (const event of events) {
    const ts = parseWatchEventTs(event.ts);

    switch (event.kind) {
      case 'bid.round.closed':
        if ('winner' in event.payload.outcome) {
          watchEvents.push({
            type: 'bid_resolved',
            data: {
              winner: event.payload.outcome.winner,
              speaker_type: event.payload.outcome.speaker_type,
            },
            ts,
          });
          break;
        }

        if (event.payload.outcome.reason !== 'epoch_transition') break;

        watchEvents.push({
          type: 'epoch_transition',
          data: {
            epoch: event.payload.stateMutations.epoch ?? null,
          },
          ts,
        });
        break;

      case 'speech.recorded':
        watchEvents.push({
          type: 'speech_done',
          data: {
            speaker: event.payload.agent,
            content: event.payload.content,
          },
          ts,
        });
        break;

      case 'session.ended':
        watchEvents.push({
          type: 'session_ended',
          data: event.payload.force
            ? {
                reason: 'force_end',
                detail: event.payload.reason ?? event.payload.endReasonContent ?? null,
              }
            : {
                reason: event.payload.endReason ?? null,
              },
          ts,
        });
        break;

      default:
        break;
    }
  }

  return watchEvents;
}

export function buildDiscussWatchState(
  sessionId: string,
  snapshot: PersistedDiscussSnapshot | null,
  events: DiscussDomainEvent[],
  cursor?: number,
): WatchState {
  if (!snapshot) {
    throw new DiscussWatchReadError('session_not_found', { session: sessionId });
  }

  const watchEvents = buildWatchEvents(events);
  const totalCursor = watchEvents.length;
  if (cursor !== undefined && cursor > totalCursor) {
    throw new DiscussWatchReadError('invalid_cursor', {
      cursor,
      max: totalCursor,
    });
  }

  return {
    session: sessionId,
    status: snapshot.state.status,
    topic: snapshot.state.topic,
    epoch: snapshot.state.epoch,
    step: snapshot.state.step,
    events: cursor === undefined ? watchEvents.slice() : watchEvents.slice(cursor),
    cursor: totalCursor,
  };
}
