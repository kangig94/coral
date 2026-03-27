import type { DiscussSessionStore } from './session-store.js';
import type { ExecutionService } from '../service.js';
import type { DiscussContext, LiveDiscussSession } from './context.js';

export type AttachedDiscussSession = {
  projectRoot: string;
  sessionId: string;
  session: LiveDiscussSession;
};

export type DiscussContextRegistry = {
  contexts: Map<string, DiscussContext>;
};

export function createDiscussContextRegistry(): DiscussContextRegistry {
  return {
    contexts: new Map<string, DiscussContext>(),
  };
}

export function getOrCreate(
  registry: DiscussContextRegistry,
  projectRoot: string,
  service: ExecutionService,
  store: DiscussSessionStore,
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
  };
  registry.contexts.set(projectRoot, context);
  return context;
}

export function get(
  registry: DiscussContextRegistry,
  projectRoot: string,
): DiscussContext | undefined {
  return registry.contexts.get(projectRoot);
}

export function listAttachedSessions(
  registry: DiscussContextRegistry,
): AttachedDiscussSession[] {
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
