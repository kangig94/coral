import {
  DEFAULT_MAX_EPOCHS,
  decideBid,
  decideEnd,
  decideSessionCreate,
  decideSpeech,
  resolveAgentName,
} from '../state-machine.js';
import type { BidResult, DiscussCreateInput, SpeechResult } from '../session-types.js';
import { nowIsoString } from '../../infra/time.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { buildAgentExecutionConfig } from './runtime-build.js';
import * as discussLoop from './loop.js';
import { type AgentConfig, type DiscussConfig, type DiscussContext, type LiveDiscussSession } from './types.js';
import { ABORT_REASON, DiscussManagerError, unwrapResult } from './errors.js';
import { attachSession, detachSession, getSession } from './registry.js';
import { afterCommit, commitDecision } from './persistence.js';
import { backendLog } from '../../infra/backend-log.js';
import { collectBids } from './flow/bid.js';
import { makeDecisionContext } from './flow/primitives.js';
import { persistAbortEndForShutdown } from './recovery.js';

function readDiscussMaxEpochs(ctx: DiscussContext): number {
  const raw = Number.parseInt(ctx.runtime.env.get('CORAL_DISCUSS_MAX_EPOCHS') ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 10) {
    return DEFAULT_MAX_EPOCHS;
  }
  return raw;
}

function readDiscussQuotaPerEpoch(config: DiscussConfig): number | undefined {
  const raw = (config as { quota_per_epoch?: unknown }).quota_per_epoch;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return undefined;
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
  invocationCtx: InvocationContext,
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
    decideSessionCreate(input, makeDecisionContext(ctx, sessionId, topic), 1, nowIsoString(ctx.runtime.time), {
      maxEpochs: readDiscussMaxEpochs(ctx),
      quotaPerEpoch: readDiscussQuotaPerEpoch(config),
      agentExecution: buildAgentExecutionConfig(agents),
    }),
  );

  const snapshot = await ctx.store.append(sessionId, null, created);
  const session = attachSession(ctx, snapshot);
  afterCommit(ctx, sessionId, snapshot, created);

  await collectBids(ctx, sessionId, invocationCtx);
  discussLoop.resumeLoop(ctx, sessionId, invocationCtx);
  return session;
}

export async function submitManualBid(
  ctx: DiscussContext,
  sessionId: string,
  agentName: string,
  score: number,
  thought: string,
  invocationCtx: InvocationContext,
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
      makeDecisionContext(ctx, sessionId, current.state.topic),
      current.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (!committed.ok) {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  discussLoop.resumeLoop(ctx, sessionId, invocationCtx);
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
  invocationCtx: InvocationContext,
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

  const resolvedAgentName = resolveAgentName(snapshot.state.agents, agentName);
  if (!resolvedAgentName || snapshot.state.current_speaker !== resolvedAgentName) {
    return {
      action: 'not_your_turn',
      current_speaker: snapshot.state.current_speaker,
    };
  }

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideSpeech(
      current.state,
      resolvedAgentName,
      content,
      makeDecisionContext(ctx, sessionId, current.state.topic),
      current.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (!committed.ok) {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  discussLoop.resumeLoop(ctx, sessionId, invocationCtx);
  return { action: 'speech_recorded' };
}

export async function abortDiscussSession(ctx: DiscussContext, sessionId: string): Promise<void> {
  const session = requireLiveSession(ctx, sessionId);

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideEnd(
      current.state,
      { force: true, reason: ABORT_REASON },
      makeDecisionContext(ctx, sessionId, current.state.topic),
      current.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  // Synthesize-window abort: ended session that has not yet synthesized; recovery would otherwise re-attach it, so persist an abort marker for shutdown-parity.
  if (
    committed.ok &&
    committed.previous.state.status === 'ended' &&
    committed.previous.runtime.controlPhase !== 'idle'
  ) {
    // Idle ended sessions are already synthesized, so skip the shutdown-parity abort marker append.
    try {
      await persistAbortEndForShutdown(ctx, sessionId, session);
    } catch (error: unknown) {
      backendLog.error(`Discuss shutdown persist failed for ${sessionId}`, error);
    }
  }

  session.controller.abort();
  detachSession(ctx, sessionId);
}
