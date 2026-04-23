import { backendLog } from '../../infra/backend-log.js';
import { formatError } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import type { CallerContext } from '../../transport/request-context.js';
import type { JobStatus } from '../../jobs/records.js';
import type { DiscussContext, DiscussLaunchDecision, DiscussService, DiscussWaitResult } from './context.js';
import { clearAllDiscuss, getOrCreate as getOrCreateDiscussContext, hasRunningSessions } from './live-registry.js';
import * as discussLoop from './loop.js';
import * as discussOperations from './operations.js';
import type { RecoveredDiscussResume } from './operations.js';
import { knownDiscussSources, type DiscussReadHelpersDeps } from './session-read-service.js';
import { DiscussSessionStore } from './session-store.js';
import { readDiscussSourcesWithStorage } from './discuss-sources-catalog.js';

type CreateDiscussRuntimeDeps = {
  world: {
    identity: { pluginRoot: string };
    discussRegistry: {
      contexts: Map<string, DiscussContext>;
    };
    progressStore: {
      readStatus(jobId: string): JobStatus | null;
    };
    resolveProjectSource: (projectRoot: string) => string;
    eventBus: {
      emit(
        event: 'discuss:updated',
        payload: { projectRoot: string; sessionId: string; lastSeq: number; status: string },
      ): boolean;
    };
  };
  runtime: Runtime;
  getExecutionService: (ctx: CallerContext) => {
    start(...args: unknown[]): Promise<DiscussLaunchDecision>;
    resumeBySessionId(...args: unknown[]): Promise<DiscussLaunchDecision>;
    waitStreamOnce(...args: unknown[]): Promise<DiscussWaitResult>;
  };
};

export function createDiscussRuntime({
  world,
  runtime,
  getExecutionService,
}: CreateDiscussRuntimeDeps): {
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readHelpersDeps: DiscussReadHelpersDeps;
  hooks: {
    onShutdown(mode: 'handoff' | 'hard'): Promise<void>;
    onIdleCheck(): boolean;
    onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
  };
  discussStores: Map<string, DiscussSessionStore>;
} {
  const discussStores = new Map<string, DiscussSessionStore>();

  function getDiscussStoreForSource(source: string): DiscussSessionStore {
    const existing = discussStores.get(source);
    if (existing) return existing;
    const created = new DiscussSessionStore(source, {
      storage: runtime.storage,
      time: runtime.time,
      paths: runtime.paths,
      onCommit: (snapshot) => {
        world.eventBus.emit('discuss:updated', {
          projectRoot: snapshot.projectRoot,
          sessionId: snapshot.sessionId,
          lastSeq: snapshot.lastAppliedSeq,
          status: snapshot.state.status,
        });
      },
    });
    discussStores.set(source, created);
    return created;
  }

  function getDiscussStore(projectRoot: string): DiscussSessionStore {
    return getDiscussStoreForSource(world.resolveProjectSource(projectRoot));
  }

  function getDiscussContext(ctx: CallerContext): DiscussContext {
    const store = getDiscussStore(ctx.projectRoot);
    const executionService = getExecutionService(ctx);
    const jobStatusReader = {
      read: (jobId: string) => world.progressStore.readStatus(jobId),
    };
    const discussService: DiscussService = {
      start: (...args) => executionService.start(...args),
      resume: (...args) => executionService.resumeBySessionId(...args),
      waitStreamOnce: (...args) => executionService.waitStreamOnce(...args),
    };
    return getOrCreateDiscussContext(
      world.discussRegistry,
      ctx.projectRoot,
      discussService,
      store,
      {
        runtime: {
          ids: runtime.ids,
          env: runtime.env,
          time: runtime.time,
        },
        jobStatusReader,
      },
    );
  }

  const readHelpersDeps: DiscussReadHelpersDeps = {
    discussRegistry: world.discussRegistry,
    getDiscussStoreForSource,
    resolveProjectSource: world.resolveProjectSource,
    readDiscussSources: () => readDiscussSourcesWithStorage(runtime.storage, runtime.paths),
  };

  const hooks = {
    onShutdown: async (mode: 'handoff' | 'hard') => {
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources(readHelpersDeps)] : [];

      await clearAllDiscuss(world.discussRegistry, mode, discussOperations.persistAbortEndForShutdown);

      if (mode !== 'hard') {
        return;
      }

      await discussOperations.persistAbortEndForPersistedShutdownCandidates(
        discussSourcesAtShutdown,
        getDiscussStoreForSource,
        (snapshot) =>
          getDiscussContext({
            projectRoot: snapshot.projectRoot,
            pluginRoot: world.identity.pluginRoot,
            coralEnv: {},
          }),
      );
      world.discussRegistry.contexts.clear();
    },
    onIdleCheck: () => hasRunningSessions(world.discussRegistry),
    onRecoveryComplete: async (resumes: RecoveredDiscussResume[]) => {
      for (const recovered of resumes) {
        try {
          discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.callerCtx);
        } catch (error: unknown) {
          backendLog.warn(`Discuss resume failed for session ${recovered.sessionId}: ${formatError(error)}`);
        }
      }
    },
  };

  return {
    getDiscussStoreForSource,
    getDiscussContext,
    readHelpersDeps,
    hooks,
    discussStores,
  };
}
