import type { DiscussDomainEvent, PersistedDiscussSnapshot } from './events.js';
import { buildWatchEvents } from './projections.js';
import { DiscussWatchReadError, type WatchState } from './watch.js';

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
