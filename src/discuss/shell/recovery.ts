import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { DiscussContext, LiveDiscussSession } from './types.js';
import { ABORT_REASON } from './errors.js';
import type { DiscussSessionStore } from './session-store.js';
import {
  makeEvent,
  type DiscussDomainEvent,
  type PersistedDiscussSnapshot,
  isWithinLiveSessionBoundary,
} from '../events.js';
import { buildWatchEvents } from '../watch.js';
import { nowIsoString } from '../../infra/time.js';
import { isAbortError, throwIfAborted } from '../../runtime/abort.js';
import { isManualParticipant } from './runtime-build.js';
import { attachSession } from './registry.js';
import { appendRuntimeEvents, isAbortEnded, readSessionEvents } from './persistence.js';

export async function reconcileDiscussionOwnedJobs(
  ctx: DiscussContext,
  sessionId: string,
): Promise<PersistedDiscussSnapshot> {
  const owned = ctx.jobStatusReader
    .listOwned(sessionId)
    .slice()
    .sort((left, right) =>
      left.launch.createdAt === right.launch.createdAt
        ? left.launch.jobId.localeCompare(right.launch.jobId)
        : left.launch.createdAt.localeCompare(right.launch.createdAt),
    );
  const started = new Set(
    readSessionEvents(ctx, sessionId)
      .filter((event) => event.kind === 'agent.job.started')
      .map((event) => event.payload.jobId),
  );

  for (const { launch } of owned) {
    if (started.has(launch.jobId)) continue;
    if (launch.sessionId === null || launch.discussionRun === undefined) {
      throw new Error(`Discussion-owned job '${launch.jobId}' has no durable run descriptor.`);
    }
    const { agent, purpose, attempt } = launch.discussionRun;
    const executionSessionId = launch.sessionId;
    const reconciled = await appendRuntimeEvents(ctx, sessionId, (current) => {
      const run = current.runtime.agentRuns[agent];
      if (run === undefined) {
        throw new Error(`Discussion-owned job '${launch.jobId}' names unknown agent '${agent}'.`);
      }
      if (run.executionSessionId !== undefined && run.executionSessionId !== executionSessionId) {
        throw new Error(`Discussion agent '${agent}' is already bound to another provider session.`);
      }
      if (run.currentJobId !== undefined && run.currentJobId !== launch.jobId) {
        throw new Error(`Discussion agent '${agent}' already has active job '${run.currentJobId}'.`);
      }
      if (run.currentJobId === launch.jobId) return [];

      let seq = current.lastAppliedSeq + 1;
      const events: DiscussDomainEvent[] = [];
      if (run.executionSessionId === undefined) {
        events.push(
          makeEvent(
            current.sessionId,
            current.projectRoot,
            current.state.topic,
            seq++,
            'agent.run.bound',
            nowIsoString(ctx.runtime.time),
            { agent, executionSessionId },
          ),
        );
      }
      events.push(
        makeEvent(
          current.sessionId,
          current.projectRoot,
          current.state.topic,
          seq,
          'agent.job.started',
          nowIsoString(ctx.runtime.time),
          { agent, jobId: launch.jobId, purpose, attempt },
        ),
      );
      return events;
    });
    if (reconciled === null) {
      throw new Error(`Failed to reconcile discussion-owned job '${launch.jobId}'.`);
    }
    started.add(launch.jobId);
  }

  const reconciled = ctx.store.load(sessionId);
  if (reconciled === null) throw new Error(`Discuss session not found after job reconciliation: ${sessionId}`);
  return reconciled;
}

export type RecoveredDiscussResume = {
  ctx: DiscussContext;
  sessionId: string;
  invocationCtx: InvocationContext;
};

function shouldResumeRecoveredSession(snapshot: PersistedDiscussSnapshot): boolean {
  const { controlPhase } = snapshot.runtime;
  if (controlPhase === 'synthesize' || controlPhase === 'evaluate_epoch' || controlPhase === 'collect_follow_up') {
    return true;
  }

  if (snapshot.state.status === 'ended') {
    return false;
  }

  if (snapshot.state.status === 'speaking') {
    if (!snapshot.state.current_speaker) {
      return false;
    }
    return !isManualParticipant(snapshot, snapshot.state.current_speaker);
  }

  if (controlPhase === 'observer_wait') {
    return true;
  }

  return snapshot.state.status === 'bidding';
}

function buildAbortEndEventsForShutdown(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
): DiscussDomainEvent[] {
  if (!isWithinLiveSessionBoundary(snapshot) || isAbortEnded(readSessionEvents(ctx, sessionId))) {
    return [];
  }

  return [
    makeEvent(
      snapshot.sessionId,
      snapshot.projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 1,
      'session.ended',
      nowIsoString(ctx.runtime.time),
      {
        endReasonContent: ABORT_REASON,
        force: true,
        reason: ABORT_REASON,
      },
    ),
  ];
}

function logShutdownPersistFailure(scope: string, error: unknown): void {
  backendLog.error(`Discuss shutdown persist failed for ${scope}`, error);
}

export async function persistAbortEndForShutdown(
  ctx: DiscussContext,
  sessionId: string,
  _session: LiveDiscussSession,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (options.signal !== undefined) {
    throwIfAborted(options.signal, 'discuss_shutdown_persist_live');
  }
  await appendRuntimeEvents(ctx, sessionId, (current) => buildAbortEndEventsForShutdown(ctx, sessionId, current));
}

export async function persistAbortEndForPersistedShutdownCandidates(
  sources: readonly string[],
  getDiscussStoreForSource: (source: string) => DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal;
  for (const source of sources) {
    if (signal !== undefined) {
      throwIfAborted(signal, 'discuss_shutdown_source');
    }
    let store: DiscussSessionStore;
    try {
      store = getDiscussStoreForSource(source);
    } catch (error: unknown) {
      logShutdownPersistFailure(`source ${source}`, error);
      continue;
    }

    let candidates: Array<{ sessionId: string }>;
    try {
      candidates = store.listRecoveryCandidates();
    } catch (error: unknown) {
      logShutdownPersistFailure(`source ${source}`, error);
      continue;
    }

    for (const candidate of candidates) {
      if (signal !== undefined) {
        throwIfAborted(signal, 'discuss_shutdown_candidate');
      }
      try {
        const snapshot = store.load(candidate.sessionId);
        if (!snapshot || !isWithinLiveSessionBoundary(snapshot)) {
          continue;
        }

        const ctx = resolveContext(snapshot);
        const events = readSessionEvents(ctx, candidate.sessionId);
        if (isAbortEnded(events)) {
          continue;
        }

        await appendRuntimeEvents(ctx, candidate.sessionId, (current) =>
          buildAbortEndEventsForShutdown(ctx, candidate.sessionId, current),
        );
        if (signal !== undefined) {
          throwIfAborted(signal, 'discuss_shutdown_candidate_persist');
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          throw error;
        }
        logShutdownPersistFailure(candidate.sessionId, error);
      }
    }
  }
}

export async function recoverPersistedSessionsFromStore(
  store: DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  resolveInvocationContext: (snapshot: PersistedDiscussSnapshot) => InvocationContext,
): Promise<RecoveredDiscussResume[]> {
  const recovered: RecoveredDiscussResume[] = [];

  for (const candidate of store.listRecoveryCandidates()) {
    const snapshot = store.load(candidate.sessionId);
    if (!snapshot) {
      continue;
    }

    const ctx = resolveContext(snapshot);
    let events = readSessionEvents(ctx, candidate.sessionId);
    const abortEnded = isAbortEnded(events);
    if (abortEnded) {
      continue;
    }

    if (!isWithinLiveSessionBoundary(snapshot)) {
      continue;
    }

    const reconciledSnapshot = await reconcileDiscussionOwnedJobs(ctx, candidate.sessionId);
    events = readSessionEvents(ctx, candidate.sessionId);

    attachSession(
      ctx,
      reconciledSnapshot,
      {
        baseCursor: 0,
        events: buildWatchEvents(events),
      },
      abortEnded,
    );

    if (shouldResumeRecoveredSession(reconciledSnapshot)) {
      recovered.push({
        ctx,
        sessionId: reconciledSnapshot.sessionId,
        invocationCtx: resolveInvocationContext(reconciledSnapshot),
      });
    }
  }

  return recovered;
}

type DiscussStartupDeps = {
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
  readonly signal: AbortSignal;
};

export type DiscussRunStartup = (deps: DiscussStartupDeps) => Promise<RecoveredDiscussResume[]>;

export const runStartup: DiscussRunStartup = async (deps) => {
  const recoveredDiscussResumes: RecoveredDiscussResume[] = [];

  for (const source of deps.knownDiscussSources()) {
    try {
      const recovered = await recoverPersistedSessionsFromStore(
        deps.getDiscussStoreForSource(source),
        (snapshot) => {
          const base = deps.createInvocationContext(snapshot.projectRoot);
          return deps.getDiscussContext({
            ...base,
            providerScope: snapshot.providerScope,
          });
        },
        (snapshot) => {
          const base = deps.createInvocationContext(snapshot.projectRoot);
          return {
            ...base,
            providerScope: snapshot.providerScope,
          };
        },
      );
      for (const resume of recovered) {
        recoveredDiscussResumes.push(resume);
      }
    } catch (error: unknown) {
      backendLog.warn(`Discuss recovery failed for source ${source}: ${errorMessage(error)}`);
    }
    deps.signal.throwIfAborted();
  }

  return recoveredDiscussResumes;
};
