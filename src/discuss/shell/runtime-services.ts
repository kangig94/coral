import { backendLog } from '../../infra/backend-log.js';
import { formatError } from '../../infra/error-format.js';
import type { Database } from '../../store/db.js';
import type { Runtime } from '../../runtime/ports.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Principal } from '../../security/principal.js';
import type { JobExit, JobLaunch, JobStatus } from '../../jobs/records.js';
import type { DiscussContext, DiscussLaunchDecision, DiscussService, DiscussWaitResult } from './types.js';
import { clearAllDiscuss, getOrCreate as getOrCreateDiscussContext, hasRunningSessions } from './live-registry.js';
import * as discussLoop from './loop.js';
import * as discussRecovery from './recovery.js';
import type { RecoveredDiscussResume } from './recovery.js';
import { knownDiscussSources, type DiscussReadHelpersDeps } from './session-read-service.js';
import { DiscussSessionStore, type DiscussSessionJournal } from './session-store.js';
import { discussRegistry, toJournalInput } from '../event-registry.js';
import { listProjectionDiscussSnapshots, readProjectionDiscuss } from '../projections.js';
import { readDiscussEventLog } from '../read-queries.js';
import type { StoreReadContext } from '../../store/body-codec.js';
import { createEventBodyCodec } from '../../store/event-body-codec.js';
import { composeReducers } from '../../store/reducers.js';
import type { CommitClosureResult, CommitContext } from '../../store/append.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { JobLaunchRequest, JobResumeRequest, ProviderSessionLaunchDecision } from '../../jobs/launch.js';

type CreateDiscussRuntimeDeps = {
  world: {
    identity: { pluginRoot: string };
    discussRegistry: {
      contexts: Map<string, DiscussContext>;
    };
    resolveProjectSource: (projectRoot: string) => string;
    providerRegistry: ProviderBindingCatalog;
    eventBus: {
      emit(
        event: 'discuss:updated',
        payload: { projectRoot: string; sessionId: string; lastSeq: number; status: string },
      ): boolean;
    };
  };
  runtime: Runtime;
  getProgressStore: () => {
    readStatus(jobId: string): JobStatus | null;
    loadJobProjectionDetail(jobId: string): { exit: JobExit | null; launch: JobLaunch | null };
    listJobProjections(): Array<{ jobId: string; status: JobStatus }>;
    getDb(): Database;
    commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): unknown;
  };
  getExecutionService: (ctx: InvocationContext) => {
    start(provider: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<ProviderSessionLaunchDecision>;
    resume(provider: string, input: JobResumeRequest, ctx: InvocationContext): Promise<ProviderSessionLaunchDecision>;
    waitStreamOnce(jobId: string, timeoutMs?: number): Promise<DiscussWaitResult>;
  };
  discardSessionArtifacts?: (sessionId: string) => Promise<void>;
};

export function createDiscussRuntime({
  world,
  runtime,
  getProgressStore,
  getExecutionService,
  discardSessionArtifacts,
}: CreateDiscussRuntimeDeps): {
  getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readHelpersDeps: DiscussReadHelpersDeps;
  hooks: {
    onShutdown(mode: 'handoff' | 'hard', signal: AbortSignal): Promise<void>;
    onIdleCheck(): boolean;
    onRecoveryComplete(resumes: RecoveredDiscussResume[]): Promise<void>;
  };
  discussStores: Map<string, DiscussSessionStore>;
} {
  const discussStores = new Map<string, DiscussSessionStore>();
  const discussReducers = composeReducers(discussRegistry);
  const readCtx: StoreReadContext = {
    schemas: discussReducers.schemas,
    streamKinds: discussReducers.streamKinds,
    bodyCodec: createEventBodyCodec(),
  };

  function snapshotBelongsToSource(snapshot: { projectRoot: string }, source: string): boolean {
    return snapshot.projectRoot === source || world.resolveProjectSource(snapshot.projectRoot) === source;
  }

  function createJournal(): DiscussSessionJournal {
    return {
      append(_source, _snapshot, events) {
        getProgressStore().commit((c) => {
          for (const event of events) {
            c.append(toJournalInput(event));
          }
          return undefined;
        });
      },
      readSnapshot(sessionId) {
        return readProjectionDiscuss(getProgressStore().getDb(), sessionId)?.state ?? null;
      },
      readEvents(sessionId) {
        return readDiscussEventLog(getProgressStore().getDb(), sessionId, readCtx);
      },
      listSnapshots(source) {
        const snapshots: ReturnType<DiscussSessionJournal['listSnapshots']> = [];
        for (const row of listProjectionDiscussSnapshots(getProgressStore().getDb())) {
          if (snapshotBelongsToSource(row.state, source)) {
            snapshots.push(row.state);
          }
        }
        return snapshots;
      },
      listSources() {
        const sources = new Set<string>();
        for (const row of listProjectionDiscussSnapshots(getProgressStore().getDb())) {
          sources.add(world.resolveProjectSource(row.state.projectRoot));
        }
        return [...sources].sort();
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
    const requireProviderLaunch = async (
      decision: ReturnType<typeof executionService.start>,
    ): Promise<DiscussLaunchDecision> => {
      const resolved = await decision;
      return resolved;
    };
    const jobStatusReader = {
      read: (jobId: string) => getProgressStore().readStatus(jobId),
      readExit: (jobId: string) => getProgressStore().loadJobProjectionDetail(jobId).exit,
      listOwned: (discussionId: string) => {
        const owned: Array<{ launch: JobLaunch; status: JobStatus }> = [];
        for (const { jobId, status } of getProgressStore().listJobProjections()) {
          if (status.owner.kind !== 'discussion' || status.owner.id !== discussionId) continue;
          const launch = getProgressStore().loadJobProjectionDetail(jobId).launch;
          if (launch !== null) owned.push({ launch, status });
        }
        return owned;
      },
    };
    const discussService: DiscussService = {
      start: (...args) => requireProviderLaunch(executionService.start(...args)),
      resume: (...args) => requireProviderLaunch(executionService.resume(...args)),
      waitStreamOnce: (...args) => executionService.waitStreamOnce(...args),
    };
    return getOrCreateDiscussContext(world.discussRegistry, ctx.projectRoot, discussService, store, {
      runtime: {
        ids: runtime.ids,
        env: runtime.env,
        time: runtime.time,
        storage: runtime.storage,
        projectData: (projectRoot: string) => runtime.paths.projectData(projectRoot),
      },
      jobStatusReader,
      providerRegistry: world.providerRegistry,
      ...(discardSessionArtifacts !== undefined ? { discardSessionArtifacts } : {}),
    });
  }

  const readHelpersDeps: DiscussReadHelpersDeps = {
    discussRegistry: world.discussRegistry,
    getDiscussStoreForSource,
    resolveProjectSource: world.resolveProjectSource,
    readDiscussSources: () => createJournal().listSources(),
  };

  const hooks = {
    onShutdown: async (mode: 'handoff' | 'hard', signal: AbortSignal) => {
      const discussSourcesAtShutdown = mode === 'hard' ? [...knownDiscussSources(readHelpersDeps)] : [];

      await clearAllDiscuss(
        world.discussRegistry,
        mode,
        (ctx, sessionId, session) => discussRecovery.persistAbortEndForShutdown(ctx, sessionId, session, { signal }),
        { signal },
      );

      if (mode !== 'hard') {
        return;
      }

      await discussRecovery.persistAbortEndForPersistedShutdownCandidates(
        discussSourcesAtShutdown,
        getDiscussStoreForSource,
        (snapshot) => {
          const principal: Principal = {
            subject: 'system',
            transport: 'internal',
            credential: { kind: 'internal', id: 'discuss-shutdown' },
            binding: { kind: 'project', root: snapshot.projectRoot },
          };
          return getDiscussContext({
            projectRoot: snapshot.projectRoot,
            pluginRoot: world.identity.pluginRoot,
            coralEnv: {},
            principal,
          });
        },
        { signal },
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
