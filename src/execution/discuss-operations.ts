import { type PersistedDiscussSnapshot } from '../discuss/events.js';
import {
  DEFAULT_MAX_EPOCHS,
  decideBid,
  decideEnd,
  decideSessionCreate,
  decideSpeech,
} from '../discuss/state-machine.js';
import type {
  BidResult,
  DiscussCreateInput,
  Result,
  SpeechResult,
} from '../discuss/types.js';
import { buildWatchEvents } from '../discuss/projections.js';
import { nowIsoString } from '../discuss/util/time.js';
import type { CallerContext } from './request-context.js';
import {
  buildAgentExecutionConfig,
} from './discuss-executor.js';
import * as discussLoop from './discuss-loop.js';
import {
  DiscussManagerError,
  type AgentConfig,
  type DiscussConfig,
  type DiscussContext,
  type LiveDiscussSession,
  type WatchState,
  unwrapResult,
} from './discuss-context.js';
import { attachSession, detachSession, getSession, getWatchState as getRegistryWatchState } from './discuss-registry.js';
import {
  afterCommit,
  commitDecision,
  isAbortEnded,
  readSessionEvents,
} from './discuss-persistence.js';
import { collectBids } from './discuss-subflows.js';

export const ABORT_REASON = 'abort';

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
    decideSessionCreate(
      input,
      sessionId,
      ctx.projectRoot,
      topic,
      1,
      nowIsoString(),
      undefined,
      readDiscussMaxEpochs(),
      undefined,
      buildAgentExecutionConfig(agents),
    ),
    'create session',
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
    ));
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
    ));
  if (!committed.ok) {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  discussLoop.resumeLoop(ctx, sessionId, callerCtx);
  return { action: 'speech_recorded' };
}

export async function abortDiscussSession(
  ctx: DiscussContext,
  sessionId: string,
): Promise<void> {
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
    ));
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  session.controller.abort();
  detachSession(ctx, sessionId);
}

export function getWatchState(
  ctx: DiscussContext,
  sessionId: string,
  cursor?: number,
): WatchState {
  return getRegistryWatchState(ctx, sessionId, cursor);
}

export async function recoverPersistedSessions(
  ctx: DiscussContext,
  _callerCtx: CallerContext,
): Promise<void> {
  for (const candidate of ctx.store.listRecoveryCandidates()) {
    const snapshot = ctx.store.load(candidate.sessionId);
    if (!snapshot) {
      continue;
    }

    const events = readSessionEvents(ctx, candidate.sessionId);
    const abortEnded = isAbortEnded(events);
    if (abortEnded) {
      continue;
    }

    attachSession(ctx, snapshot, {
      baseCursor: 0,
      events: buildWatchEvents(events),
    }, abortEnded);
  }
}
