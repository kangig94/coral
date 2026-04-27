import type { DiscussSessionStore } from './session-store.js';
import { coordinatorLog } from '../../infra/coordinator-log.js';
import type {
  DiscussContext,
  DiscussJobStatusReader,
  DiscussRuntimePorts,
  DiscussService,
  LiveDiscussSession,
  WatchBuffer,
  WatchEvent,
  WatchSubscriber,
} from './types.js';
import { isWithinLiveSessionBoundary } from '../events.js';

const WATCH_BUFFER_CAP = 500;
const subscriberCursors = new WeakMap<LiveDiscussSession, Map<WatchSubscriber, number>>();

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

export type AttachedDiscussSession = {
  projectRoot: string;
  sessionId: string;
  session: LiveDiscussSession;
};

export type DiscussContextRegistry = {
  contexts: Map<string, DiscussContext>;
};

export type DiscussContextConstructionOptions = {
  runtime: DiscussRuntimePorts;
  jobStatusReader: DiscussJobStatusReader;
};

export function createDiscussContextRegistry(): DiscussContextRegistry {
  return {
    contexts: new Map<string, DiscussContext>(),
  };
}

export function getOrCreate(
  registry: DiscussContextRegistry,
  projectRoot: string,
  service: DiscussService,
  store: DiscussSessionStore,
  options: DiscussContextConstructionOptions,
): DiscussContext {
  const existing = registry.contexts.get(projectRoot);
  if (existing) {
    return existing;
  }

  const context: DiscussContext = {
    projectRoot,
    sessions: new Map<string, LiveDiscussSession>(),
    service,
    store,
    runtime: options.runtime,
    jobStatusReader: options.jobStatusReader,
  };
  registry.contexts.set(projectRoot, context);
  return context;
}

export function get(registry: DiscussContextRegistry, projectRoot: string): DiscussContext | undefined {
  return registry.contexts.get(projectRoot);
}

export function listAttachedSessions(registry: DiscussContextRegistry): AttachedDiscussSession[] {
  const sessions: AttachedDiscussSession[] = [];
  for (const [projectRoot, context] of registry.contexts.entries()) {
    for (const [sessionId, session] of context.sessions.entries()) {
      sessions.push({ projectRoot, sessionId, session });
    }
  }
  return sessions;
}

export function hasRunningSessions(registry: DiscussContextRegistry): boolean {
  for (const context of registry.contexts.values()) {
    for (const session of context.sessions.values()) {
      if (!session.controller.signal.aborted && session.snapshot.state.status !== 'ended') {
        return true;
      }
    }
  }
  return false;
}

/** Abort all live sessions and clear every context from the registry. */
export async function clearAllDiscuss(
  registry: DiscussContextRegistry,
  mode: 'handoff' | 'hard',
  persistAbortEnd: (ctx: DiscussContext, sessionId: string, session: LiveDiscussSession) => Promise<void>,
): Promise<void> {
  for (const context of registry.contexts.values()) {
    for (const [sessionId, session] of context.sessions.entries()) {
      if (mode === 'hard' && !session.abortEnded && isWithinLiveSessionBoundary(session.snapshot)) {
        try {
          await persistAbortEnd(context, sessionId, session);
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          coordinatorLog.error(`Discuss shutdown persist failed for ${sessionId}: ${detail}`);
        }
      }
      if (!session.controller.signal.aborted) {
        session.controller.abort();
      }
    }
    context.sessions.clear();
  }
  registry.contexts.clear();
}
