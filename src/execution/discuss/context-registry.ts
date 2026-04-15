import type { DiscussSessionStore } from './session-store.js';
import { backendLog } from '../../shared/backend-log.js';
import type { ExecutionService } from '../service.js';
import type { DiscussContext, DiscussJobStatusReader, DiscussRuntimePorts, LiveDiscussSession } from './context.js';
import { isWithinLiveSessionBoundary } from './operations.js';

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
  service: ExecutionService,
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
          backendLog.error(`Discuss shutdown persist failed for ${sessionId}: ${detail}`);
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
