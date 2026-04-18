import { readDiscussSourcesWithStorage, readStatusRecordWithStorage } from '../../shared/persistence-readers.js';
import type { CallerContext } from '../../shared/request-context.js';
import { formatError } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import type { ExecutionServiceLike } from '../backend-contracts.js';
import type { DiscussContext } from '../../discuss/shell/context.js';
import {
  clearAllDiscuss,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
} from '../../discuss/shell/live-registry.js';
import * as discussLoop from '../../discuss/shell/loop.js';
import * as discussOperations from '../../discuss/shell/operations.js';
import { knownDiscussSources, type DiscussReadHelpersDeps } from '../../discuss/shell/read-helpers.js';
import { DiscussSessionStore } from '../../discuss/shell/session-store.js';
import type { LifecycleHooks } from '../lifecycle.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ExecutionService } from '../service.js';
import type { BackendWorld } from './backend-world.js';

type CreateDiscussRuntimeDeps = {
  world: BackendWorld;
  runtime: Runtime;
  getExecutionService: (ctx: CallerContext) => ExecutionServiceLike;
};

export function createDiscussRuntime({
  world,
  runtime,
  getExecutionService,
}: CreateDiscussRuntimeDeps): {
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readHelpersDeps: DiscussReadHelpersDeps;
  hooks: LifecycleHooks;
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
    const jobStatusReader = {
      read: (jobId: string) => readStatusRecordWithStorage(runtime.storage, runtime.paths, jobId),
    };
    return getOrCreateDiscussContext(
      world.discussRegistry,
      ctx.projectRoot,
      getExecutionService(ctx) as ExecutionService,
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

  const hooks: LifecycleHooks = {
    onShutdown: async (mode) => {
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
    onRecoveryComplete: async (resumes) => {
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
