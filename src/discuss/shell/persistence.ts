import { buildWatchEvents } from '../projections.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../events.js';
import type { Result } from '../types.js';
import { backendLog } from '../../shared/backend-log.js';
import { DiscussStaleWriteError } from './session-store.js';
import {
  ABORT_REASON,
  DiscussManagerError,
  compactLiveWatchBuffer,
  createWatchBuffer,
  getSubscriberCursorMap,
  type DiscussContext,
  type WatchState,
  watchBufferCursor,
} from './context.js';

function syncLiveSnapshot(ctx: DiscussContext, sessionId: string): void {
  const latest = ctx.store.load(sessionId);
  if (!latest) {
    return;
  }
  const live = ctx.sessions.get(sessionId);
  if (live) {
    live.snapshot = latest;
  }
}

export type CommitSuccess = {
  ok: true;
  previous: PersistedDiscussSnapshot;
  snapshot: PersistedDiscussSnapshot;
  events: DiscussDomainEvent[];
};

export type CommitFailure = {
  ok: false;
  error: string;
  detail?: Record<string, unknown>;
};

export type CommitResult = CommitSuccess | CommitFailure;

export function loadAttachedOrPersistedSnapshot(
  ctx: DiscussContext,
  sessionId: string,
): PersistedDiscussSnapshot | null {
  return ctx.sessions.get(sessionId)?.snapshot ?? ctx.store.load(sessionId);
}

export function readSessionEvents(ctx: DiscussContext, sessionId: string): DiscussDomainEvent[] {
  return ctx.store.readSessionEvents(sessionId);
}

export function isAbortEnded(events: DiscussDomainEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session.ended') {
      continue;
    }
    return event.payload.reason === ABORT_REASON;
  }
  return false;
}

export function afterCommit(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
  events: DiscussDomainEvent[],
): void {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    return;
  }

  session.snapshot = snapshot;
  session.abortEnded ||= isAbortEnded(events);
  const watchEvents = buildWatchEvents(events);
  if (watchEvents.length === 0) {
    return;
  }

  session.watchBuffer.events.push(...watchEvents);
  for (const event of watchEvents) {
    for (const subscriber of session.watchSubscribers) {
      subscriber(event);
    }
  }

  const nextCursor = watchBufferCursor(session.watchBuffer);
  const subscriberCursorMap = getSubscriberCursorMap(session);
  for (const subscriber of session.watchSubscribers) {
    subscriberCursorMap.set(subscriber, nextCursor);
  }
  compactLiveWatchBuffer(session);
}

export async function commitDecision(
  ctx: DiscussContext,
  sessionId: string,
  decide: (snapshot: PersistedDiscussSnapshot) => Result<DiscussDomainEvent[]>,
): Promise<CommitResult> {
  while (true) {
    const current = loadAttachedOrPersistedSnapshot(ctx, sessionId);
    if (!current) {
      return { ok: false, error: 'session_not_found', detail: { session: sessionId } };
    }

    const decided = decide(current);
    if (!decided.ok) {
      return { ok: false, error: decided.error, detail: decided.detail };
    }

    if (decided.value.length === 0) {
      return {
        ok: true,
        previous: current,
        snapshot: current,
        events: [],
      };
    }

    try {
      const snapshot = await ctx.store.append(sessionId, current.lastAppliedSeq, decided.value);
      afterCommit(ctx, sessionId, snapshot, decided.value);
      return {
        ok: true,
        previous: current,
        snapshot,
        events: decided.value,
      };
    } catch (error: unknown) {
      if (error instanceof DiscussStaleWriteError) {
        syncLiveSnapshot(ctx, sessionId);
        continue;
      }
      throw error;
    }
  }
}

const MAX_STALE_RETRIES = 5;

export async function appendRuntimeEvents(
  ctx: DiscussContext,
  sessionId: string,
  buildEvents: (snapshot: PersistedDiscussSnapshot) => DiscussDomainEvent[],
): Promise<PersistedDiscussSnapshot | null> {
  for (let attempt = 0; attempt < MAX_STALE_RETRIES; attempt++) {
    const current = loadAttachedOrPersistedSnapshot(ctx, sessionId);
    if (!current) {
      return null;
    }

    const events = buildEvents(current);
    if (events.length === 0) {
      return current;
    }

    try {
      const snapshot = await ctx.store.append(sessionId, current.lastAppliedSeq, events);
      afterCommit(ctx, sessionId, snapshot, events);
      return snapshot;
    } catch (error: unknown) {
      if (error instanceof DiscussStaleWriteError) {
        const seqBefore = ctx.sessions.get(sessionId)?.snapshot.lastAppliedSeq;
        syncLiveSnapshot(ctx, sessionId);
        const seqAfter = ctx.sessions.get(sessionId)?.snapshot.lastAppliedSeq;
        if (seqBefore !== undefined && seqAfter === seqBefore) {
          backendLog.warn(`appendRuntimeEvents: stale write for ${sessionId} not recoverable (seq stuck at ${seqBefore})`);
          return null;
        }
        continue;
      }
      throw error;
    }
  }

  backendLog.warn(`appendRuntimeEvents: exhausted ${MAX_STALE_RETRIES} retries for ${sessionId}`);
  return null;
}

export function buildPersistedWatchState(ctx: DiscussContext, sessionId: string, cursor?: number): WatchState {
  const snapshot = ctx.store.load(sessionId);
  if (!snapshot) {
    throw new DiscussManagerError('session_not_found', { session: sessionId });
  }

  const watchBuffer = createWatchBuffer(buildWatchEvents(readSessionEvents(ctx, sessionId)));
  const totalCursor = watchBufferCursor(watchBuffer);
  if (cursor !== undefined && cursor > totalCursor) {
    throw new DiscussManagerError('invalid_cursor', {
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
    events: cursor === undefined ? watchBuffer.events.slice() : watchBuffer.events.slice(cursor),
    cursor: totalCursor,
  };
}
