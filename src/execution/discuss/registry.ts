import {
  DiscussManagerError,
  createWatchBuffer,
  type DiscussContext,
  type LiveDiscussSession,
  type WatchBuffer,
  type WatchState,
  type WatchSubscriber,
  watchBufferCursor,
} from './context.js';
import { buildPersistedWatchState } from './persistence.js';
import type { PersistedDiscussSnapshot } from '../../discuss/events.js';

export function attachSession(
  ctx: DiscussContext,
  snapshot: PersistedDiscussSnapshot,
  initialWatchBuffer: WatchBuffer = createWatchBuffer(),
  abortEnded = false,
): LiveDiscussSession {
  const existing = ctx.sessions.get(snapshot.sessionId);
  if (existing) {
    existing.snapshot = snapshot;
    existing.abortEnded = abortEnded;
    return existing;
  }

  const session: LiveDiscussSession = {
    snapshot,
    controller: new AbortController(),
    watchSubscribers: new Set<WatchSubscriber>(),
    watchBuffer: {
      baseCursor: initialWatchBuffer.baseCursor,
      events: initialWatchBuffer.events.slice(),
    },
    abortEnded,
    loopState: { running: false },
  };
  ctx.sessions.set(snapshot.sessionId, session);
  return session;
}

export function detachSession(ctx: DiscussContext, sessionId: string): void {
  ctx.sessions.delete(sessionId);
}

export function getSession(ctx: DiscussContext, sessionId: string): LiveDiscussSession | undefined {
  return ctx.sessions.get(sessionId);
}

export function listSessions(ctx: DiscussContext): Array<[string, LiveDiscussSession]> {
  return [...ctx.sessions.entries()];
}

export function getWatchState(ctx: DiscussContext, sessionId: string, cursor?: number): WatchState {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return buildPersistedWatchState(ctx, sessionId, cursor);
  }

  if (cursor === undefined && session.watchBuffer.baseCursor > 0) {
    return buildPersistedWatchState(ctx, sessionId);
  }

  const totalCursor = watchBufferCursor(session.watchBuffer);
  if (cursor !== undefined && cursor > totalCursor) {
    throw new DiscussManagerError('invalid_cursor', {
      cursor,
      max: totalCursor,
    });
  }

  if (cursor !== undefined && cursor < session.watchBuffer.baseCursor) {
    return buildPersistedWatchState(ctx, sessionId, cursor);
  }

  const startIndex = cursor === undefined ? 0 : cursor - session.watchBuffer.baseCursor;
  return {
    session: sessionId,
    status: session.snapshot.state.status,
    topic: session.snapshot.state.topic,
    epoch: session.snapshot.state.epoch,
    step: session.snapshot.state.step,
    events: session.watchBuffer.events.slice(startIndex),
    cursor: totalCursor,
  };
}

export { compactLiveWatchBuffer as compactWatchBuffer } from './context.js';
