import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { DiscussContext, LiveDiscussSession } from './context.js';
import { ABORT_REASON } from './context.js';
import type { DiscussSessionStore } from './session-store.js';
import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../events.js';
import { buildWatchEvents } from '../projections.js';
import { nowIsoString } from '../../infra/time.js';
import { isManualParticipant } from './runtime-build.js';
import { attachSession } from './registry.js';
import { appendRuntimeEvents, isAbortEnded, readSessionEvents } from './persistence.js';
import { isWithinLiveSessionBoundary } from '../events.js';

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

export function buildAbortEndEventsForShutdown(
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
): Promise<void> {
  await appendRuntimeEvents(ctx, sessionId, (current) => buildAbortEndEventsForShutdown(ctx, sessionId, current));
}

export async function persistAbortEndForPersistedShutdownCandidates(
  sources: readonly string[],
  getDiscussStoreForSource: (source: string) => DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
): Promise<void> {
  for (const source of sources) {
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
      } catch (error: unknown) {
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
    const events = readSessionEvents(ctx, candidate.sessionId);
    const abortEnded = isAbortEnded(events);
    if (abortEnded) {
      continue;
    }

    if (!isWithinLiveSessionBoundary(snapshot)) {
      continue;
    }

    attachSession(
      ctx,
      snapshot,
      {
        baseCursor: 0,
        events: buildWatchEvents(events),
      },
      abortEnded,
    );

    if (shouldResumeRecoveredSession(snapshot)) {
      recovered.push({
        ctx,
        sessionId: snapshot.sessionId,
        invocationCtx: resolveInvocationContext(snapshot),
      });
    }
  }

  return recovered;
}

export type DiscussStartupDeps = {
  readonly knownDiscussSources: () => Set<string>;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly getDiscussContext: (ctx: InvocationContext) => DiscussContext;
  readonly createInvocationContext: (projectRoot: string) => InvocationContext;
  readonly assertStartupStillActive: () => void;
};

export type DiscussRunStartup = (deps: DiscussStartupDeps) => Promise<RecoveredDiscussResume[]>;

export const runStartup: DiscussRunStartup = async (deps) => {
  const recoveredDiscussResumes: RecoveredDiscussResume[] = [];

  for (const source of deps.knownDiscussSources()) {
    try {
      recoveredDiscussResumes.push(
        ...(await recoverPersistedSessionsFromStore(
          deps.getDiscussStoreForSource(source),
          (snapshot) => deps.getDiscussContext(deps.createInvocationContext(snapshot.projectRoot)),
          (snapshot) => deps.createInvocationContext(snapshot.projectRoot),
        )),
      );
    } catch (error: unknown) {
      backendLog.warn(`Discuss recovery failed for source ${source}: ${errorMessage(error)}`);
    }
    deps.assertStartupStillActive();
  }

  return recoveredDiscussResumes;
};
