import type { PersistedDiscussAgentRun, PersistedDiscussSnapshot } from '../discuss/events.js';
import type { Result } from '../discuss/types.js';
import type { DiscussSessionStore } from './discuss-session-store.js';
import type { ExecutionService } from './service.js';

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

export type WatchEvent = {
  type: 'bid_resolved' | 'speech_done' | 'epoch_transition' | 'session_ended';
  data: Record<string, unknown>;
  ts: number;
};

export type WatchSubscriber = (event: WatchEvent) => void;

export type WatchBuffer = {
  baseCursor: number;
  events: WatchEvent[];
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

export function compactLiveWatchBuffer(session: LiveDiscussSession): void {
  const subscriberCursorMap = getSubscriberCursorMap(session);
  if (subscriberCursorMap.size === 0) {
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
