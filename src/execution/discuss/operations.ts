import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../../discuss/events.js';
import {
  DEFAULT_MAX_EPOCHS,
  decideBid,
  decideEnd,
  decideSessionCreate,
  decideSpeech,
} from '../../discuss/state-machine.js';
import type { BidResult, DiscussCreateInput, Result, SpeechResult } from '../../discuss/types.js';
import { buildWatchEvents } from '../../discuss/projections.js';
import { nowIsoString } from '../../discuss/util/time.js';
import type { CallerContext } from '../request-context.js';
import { buildAgentExecutionConfig, hasActiveBidWork, hasPendingAutoBidders, isManualParticipant } from './executor.js';
import * as discussLoop from './loop.js';
import {
  ABORT_REASON,
  DiscussManagerError,
  type AgentConfig,
  type DiscussConfig,
  type DiscussContext,
  type LiveDiscussSession,
  type WatchState,
  unwrapResult,
} from './context.js';
import { attachSession, detachSession, getSession, getWatchState as getRegistryWatchState } from './registry.js';
import { appendRuntimeEvents, afterCommit, commitDecision, isAbortEnded, readSessionEvents } from './persistence.js';
import type { DiscussSessionStore } from './session-store.js';
import { backendLog } from '../../shared/backend-log.js';
import { collectBids } from './subflows.js';

function readDiscussMaxEpochs(): number {
  const raw = Number.parseInt(process.env.CORAL_DISCUSS_MAX_EPOCHS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 10) {
    return DEFAULT_MAX_EPOCHS;
  }
  return raw;
}

function requireLiveSession(ctx: DiscussContext, sessionId: string): LiveDiscussSession {
  const session = getSession(ctx, sessionId);
  if (!session) {
    throw new DiscussManagerError('session_not_found', { session: sessionId });
  }
  return session;
}

function isWithinLiveSessionBoundary(snapshot: PersistedDiscussSnapshot): boolean {
  return snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'idle';
}

function shouldAttachRecoveredSession(snapshot: PersistedDiscussSnapshot): boolean {
  return isWithinLiveSessionBoundary(snapshot);
}

function shouldResumeRecoveredSession(snapshot: PersistedDiscussSnapshot): boolean {
  if (snapshot.runtime.controlPhase === 'synthesize') {
    return true;
  }

  if (snapshot.runtime.controlPhase === 'evaluate_epoch') {
    return true;
  }

  if (snapshot.runtime.controlPhase === 'collect_follow_up') {
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

  if (snapshot.runtime.controlPhase === 'observer_wait') {
    return true;
  }

  if (snapshot.state.status !== 'bidding') {
    return false;
  }

  if (hasActiveBidWork(snapshot)) {
    return true;
  }

  if (hasPendingAutoBidders(snapshot)) {
    return true;
  }

  return true;
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
      nowIsoString(),
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

export async function startDiscussSession(
  ctx: DiscussContext,
  sessionId: string,
  topic: string,
  agents: AgentConfig[],
  config: DiscussConfig,
  callerCtx: CallerContext,
): Promise<LiveDiscussSession> {
  const input: DiscussCreateInput = {
    topic,
    agents: agents.map((agent) => ({
      name: agent.name,
      persona: agent.persona,
      participation: agent.participation ?? 'required',
    })),
    min_bid_delay_ms: config.min_bid_delay_ms ?? 0,
  };

  const created = unwrapResult(
    decideSessionCreate(input, sessionId, ctx.projectRoot, topic, 1, nowIsoString(), {
      maxEpochs: readDiscussMaxEpochs(),
      agentExecution: buildAgentExecutionConfig(agents),
    }),
  );

  const snapshot = await ctx.store.append(sessionId, null, created);
  const session = attachSession(ctx, snapshot);
  afterCommit(ctx, sessionId, snapshot, created);

  await collectBids(ctx, sessionId, callerCtx);
  discussLoop.resumeLoop(ctx, sessionId, callerCtx);
  return session;
}

export async function submitManualBid(
  ctx: DiscussContext,
  sessionId: string,
  agentName: string,
  score: number,
  thought: string,
  callerCtx: CallerContext,
): Promise<BidResult> {
  const session = requireLiveSession(ctx, sessionId);
  const snapshot = session.snapshot;

  if (snapshot.state.status === 'ended') {
    return {
      action: 'session_ended',
      reason: snapshot.state.end_reason_content ?? undefined,
      content: snapshot.state.end_reason_content ?? undefined,
    };
  }

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideBid(
      current.state,
      agentName,
      score,
      thought,
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      current.lastAppliedSeq + 1,
      nowIsoString(),
    ),
  );
  if (!committed.ok) {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  discussLoop.resumeLoop(ctx, sessionId, callerCtx);
  return {
    action: 'listen',
    speaker: null,
    content: 'Bid recorded.',
  };
}

export async function submitManualSpeech(
  ctx: DiscussContext,
  sessionId: string,
  agentName: string,
  content: string,
  callerCtx: CallerContext,
): Promise<SpeechResult> {
  const session = requireLiveSession(ctx, sessionId);
  const snapshot = session.snapshot;

  if (snapshot.state.status === 'ended') {
    return {
      action: 'session_ended',
      reason: snapshot.state.end_reason_content ?? undefined,
      content: snapshot.state.end_reason_content ?? undefined,
    };
  }

  if (snapshot.state.current_speaker !== agentName) {
    return {
      action: 'not_your_turn',
      current_speaker: snapshot.state.current_speaker,
    };
  }

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideSpeech(
      current.state,
      agentName,
      content,
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      current.lastAppliedSeq + 1,
      nowIsoString(),
    ),
  );
  if (!committed.ok) {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  discussLoop.resumeLoop(ctx, sessionId, callerCtx);
  return { action: 'speech_recorded' };
}

export async function abortDiscussSession(ctx: DiscussContext, sessionId: string): Promise<void> {
  const session = requireLiveSession(ctx, sessionId);

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideEnd(
      current.state,
      { force: true, reason: ABORT_REASON },
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      current.lastAppliedSeq + 1,
      nowIsoString(),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  session.controller.abort();
  detachSession(ctx, sessionId);
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

export function getWatchState(ctx: DiscussContext, sessionId: string, cursor?: number): WatchState {
  return getRegistryWatchState(ctx, sessionId, cursor);
}

export type RecoveredDiscussResume = {
  ctx: DiscussContext;
  sessionId: string;
  callerCtx: CallerContext;
};

export async function recoverPersistedSessionsFromStore(
  store: DiscussSessionStore,
  resolveContext: (snapshot: PersistedDiscussSnapshot) => DiscussContext,
  resolveCallerContext: (snapshot: PersistedDiscussSnapshot) => CallerContext,
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

    if (!shouldAttachRecoveredSession(snapshot)) {
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
        callerCtx: resolveCallerContext(snapshot),
      });
    }
  }

  return recovered;
}
