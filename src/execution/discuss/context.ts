import type { PersistedDiscussAgentRun, PersistedDiscussSnapshot } from '../../discuss/events.js';
import type { Result } from '../../discuss/types.js';
import type { WatchEvent } from '../../discuss/watch.js';
import type { DiscussSessionStore } from './session-store.js';
import type { ExecutionService } from '../service.js';

export type { WatchEvent, WatchState } from '../../discuss/watch.js';

export const ABORT_REASON = 'abort';

export type AgentConfig = {
  name: string;
  persona: string;
  participation?: 'required' | 'observer';
  provider?: string;
  model?: string;
};

export type DiscussConfig = {
  min_bid_delay_ms?: number;
};

export type WatchSubscriber = (event: WatchEvent) => void;

export type WatchBuffer = {
  baseCursor: number;
  events: WatchEvent[];
};

export type LiveDiscussSession = {
  snapshot: PersistedDiscussSnapshot;
  controller: AbortController;
  watchSubscribers: Set<WatchSubscriber>;
  watchBuffer: WatchBuffer;
  abortEnded: boolean;
  loopState: { running: boolean };
};

export type DiscussSession = LiveDiscussSession;
export type AgentRun = PersistedDiscussAgentRun;

export type DiscussContext = {
  projectRoot: string;
  sessions: Map<string, LiveDiscussSession>;
  service: ExecutionService;
  store: DiscussSessionStore;
};

export class DiscussManagerError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: string, detail?: Record<string, unknown>) {
    super(code);
    this.name = 'DiscussManagerError';
    this.code = code;
    this.detail = detail;
  }
}

const subscriberCursors = new WeakMap<LiveDiscussSession, Map<WatchSubscriber, number>>();

export function unwrapResult<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new DiscussManagerError(result.error, result.detail);
}

export function createWatchBuffer(events: WatchEvent[] = []): WatchBuffer {
  return {
    baseCursor: 0,
    events: events.slice(),
  };
}

export function watchBufferCursor(buffer: WatchBuffer): number {
  return buffer.baseCursor + buffer.events.length;
}

export function getSubscriberCursorMap(session: LiveDiscussSession): Map<WatchSubscriber, number> {
  const cursors = subscriberCursors.get(session);
  if (cursors) return cursors;

  const created = new Map<WatchSubscriber, number>();
  subscriberCursors.set(session, created);
  return created;
}

const WATCH_BUFFER_CAP = 500;

export function compactLiveWatchBuffer(session: LiveDiscussSession): void {
  const subscriberCursorMap = getSubscriberCursorMap(session);

  if (subscriberCursorMap.size === 0) {
    // No subscribers — trim to cap so buffer doesn't grow unbounded
    if (session.watchBuffer.events.length > WATCH_BUFFER_CAP) {
      const excess = session.watchBuffer.events.length - WATCH_BUFFER_CAP;
      session.watchBuffer = {
        baseCursor: session.watchBuffer.baseCursor + excess,
        events: session.watchBuffer.events.slice(excess),
      };
    }
    return;
  }

  let minCursor = Number.POSITIVE_INFINITY;
  for (const cursor of subscriberCursorMap.values()) {
    if (cursor < minCursor) {
      minCursor = cursor;
    }
  }

  const dropCount = minCursor - session.watchBuffer.baseCursor;
  if (dropCount <= 0) {
    return;
  }

  session.watchBuffer = {
    baseCursor: session.watchBuffer.baseCursor + dropCount,
    events: session.watchBuffer.events.slice(dropCount),
  };
}
