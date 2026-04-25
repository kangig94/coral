import { backendLog } from '../../infra/backend-log.js';
import { formatError } from '../../infra/error-format.js';
import type { Database } from 'better-sqlite3';
import type { Runtime } from '../../runtime/ports.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { JobStatus } from '../../jobs/records.js';
import type { DiscussContext, DiscussLaunchDecision, DiscussService, DiscussWaitResult } from './context.js';
import { clearAllDiscuss, getOrCreate as getOrCreateDiscussContext, hasRunningSessions } from './live-registry.js';
import * as discussLoop from './loop.js';
import * as discussRecovery from './recovery.js';
import type { RecoveredDiscussResume } from './recovery.js';
import { knownDiscussSources, type DiscussReadHelpersDeps } from './session-read-service.js';
import { DiscussSessionStore, type DiscussSessionJournal } from './session-store.js';
import { toJournalInput } from '../store-registry.js';
import { listProjectionDiscussSnapshots, readProjectionDiscuss } from '../projections.js';
import { readDiscussEventLog } from '../read-queries.js';
import type { StoreReadContext } from '../../store/body-codec.js';
import { createEmptyRegistry } from '../../store/envelope.js';

type CreateDiscussRuntimeDeps = {
  world: {
    identity: { pluginRoot: string };
    discussRegistry: {
      contexts: Map<string, DiscussContext>;
    };
    progressStore: {
      readStatus(jobId: string): JobStatus | null;
      getDb(): Database;
      appendEventsWithResult(inputs: ReturnType<typeof toJournalInput>[]): unknown;
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
  getExecutionService: (ctx: InvocationContext) => {
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
  getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readHelpersDeps: DiscussReadHelpersDeps;
  hooks: {
    onShutdown(mode: 'handoff' | 'hard'): Promise<void>;
    onIdleCheck(): boolean;
    onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
  };
  discussStores: Map<string, DiscussSessionStore>;
} {
  const discussStores = new Map<string, DiscussSessionStore>();
  const readCtx: StoreReadContext = {
    schemas: new Map(),
    upcasters: createEmptyRegistry(),
  };

  function snapshotBelongsToSource(snapshot: { projectRoot: string }, source: string): boolean {
    return snapshot.projectRoot === source || world.resolveProjectSource(snapshot.projectRoot) === source;
  }

  function createJournal(): DiscussSessionJournal {
    return {
      append(_source, _snapshot, events) {
        world.progressStore.appendEventsWithResult(events.map((event) => toJournalInput(event)));
      },
      readSnapshot(sessionId) {
        return readProjectionDiscuss(world.progressStore.getDb(), sessionId)?.state ?? null;
      },
      readEvents(sessionId) {
        return readDiscussEventLog(world.progressStore.getDb(), sessionId, readCtx);
      },
      listSnapshots(source) {
        return listProjectionDiscussSnapshots(world.progressStore.getDb())
          .map((row) => row.state)
          .filter((snapshot) => snapshotBelongsToSource(snapshot, source));
      },
      listSources() {
        return [
          ...new Set(
            listProjectionDiscussSnapshots(world.progressStore.getDb()).map((row) =>
              world.resolveProjectSource(row.state.projectRoot),
            ),
          ),
        ].sort();
      },
    };
  }

  function getDiscussStoreForSource(source: string): DiscussSessionStore {
    const existing = discussStores.get(source);
    if (existing) return existing;
    const created = new DiscussSessionStore(source, {
      journal: createJournal(),
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

  function getDiscussContext(ctx: InvocationContext): DiscussContext {
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
    readDiscussSources: () => createJournal().listSources(),
  };

  const hooks = {
    onShutdown: async (mode: 'handoff' | 'hard') => {
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources(readHelpersDeps)] : [];

      await clearAllDiscuss(world.discussRegistry, mode, discussRecovery.persistAbortEndForShutdown);

      if (mode !== 'hard') {
        return;
      }

      await discussRecovery.persistAbortEndForPersistedShutdownCandidates(
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
          discussLoop.resumeLoop(recovered.ctx, recovered.sessionId, recovered.invocationCtx);
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
