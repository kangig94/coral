import { makeEvent, type DiscussDomainEvent, type PersistedDiscussSnapshot } from '../events.js';
import { decideBid, decideEnd, decideExpel } from '../state-machine.js';
import type { CallerContext } from '../../transport/request-context.js';
import { buildBidPrompt, buildFirstTurnInstruction } from './prompts.js';
import {
  CONTINUE_TURN_INSTRUCTION,
  DEFAULT_DISCUSS_PROVIDER,
  PURPOSE_BID,
  currentAgentRun,
  executeAgentAttempt,
  isAttemptSuccess,
  isManualParticipant,
  normalizeModel,
  recordJobFinished,
} from './runtime-build.js';
import { DiscussManagerError, type DiscussContext, unwrapResult } from './context.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from './persistence.js';
import {
  type BidOutcome,
  type SubflowResult,
  BID_ATTEMPT_TIMEOUT_MS,
  MAX_BID_ATTEMPTS,
  applyEventsLocally,
  buildBidRetryPrompt,
  ctxTs,
  failedBidOutcome,
  formatTurnParseError,
  lastSpeech,
  makeDecisionContext,
  mustAnswerText,
  parseBidResponse,
  parseMustAnswerItem,
} from './flow-shared.js';

function buildBidBatch(
  ctx: DiscussContext,
  snapshot: PersistedDiscussSnapshot,
  outcomes: BidOutcome[],
): DiscussDomainEvent[] {
  if (snapshot.state.status !== 'bidding') {
    return [];
  }

  let working = snapshot;
  const events: DiscussDomainEvent[] = [];
  let nextSeq = snapshot.lastAppliedSeq + 1;
  const expelAgents: string[] = [];
  const answeredAgents = new Set<string>();

  for (const outcome of outcomes) {
    const bidDecision = decideBid(
      working.state,
      outcome.agentName,
      outcome.score,
      outcome.thought,
      makeDecisionContext(ctx, snapshot.sessionId, snapshot.state.topic),
      nextSeq,
      ctxTs(ctx),
    );

    if (!bidDecision.ok) {
      if (bidDecision.error === 'already_bid' || bidDecision.error === 'agent_not_found') {
        continue;
      }
      return [];
    }

    events.push(...bidDecision.value);
    working = applyEventsLocally(working, bidDecision.value);
    nextSeq += bidDecision.value.length;

    if (outcome.shouldExpel && !working.state.agents[outcome.agentName]?.banned) {
      expelAgents.push(outcome.agentName);
    }
    if (outcome.answeredCarryForward) {
      answeredAgents.add(outcome.agentName);
    }
  }

  if (expelAgents.length > 0) {
    const expelEvents = unwrapResult(
      decideExpel(
        working.state,
        expelAgents,
        makeDecisionContext(ctx, snapshot.sessionId, snapshot.state.topic),
        nextSeq,
        ctxTs(ctx),
      ),
    );
    events.push(...expelEvents);
    working = applyEventsLocally(working, expelEvents);
    nextSeq += expelEvents.length;
  }

  if (answeredAgents.size > 0 && snapshot.runtime.carryForwardMustAnswer.length > 0) {
    const remaining = snapshot.runtime.carryForwardMustAnswer.filter((item) => {
      const decoded = parseMustAnswerItem(item);
      return decoded === null || !answeredAgents.has(decoded.to);
    });

    if (remaining.length !== snapshot.runtime.carryForwardMustAnswer.length) {
      const clearEvent = makeEvent(
        snapshot.sessionId,
        snapshot.projectRoot,
        snapshot.state.topic,
        nextSeq,
        'must_answer.carry_forward.set',
        ctxTs(ctx),
        { items: remaining },
      );
      events.push(clearEvent);
      working = applyEventsLocally(working, [clearEvent]);
      nextSeq += 1;
    }
  }

  const hadExistingBid = Object.values(snapshot.state.current_bids).some((value) => value !== null);
  const allPendingAgentsFailed = outcomes.length > 0 && outcomes.every((outcome) => outcome.executionFailure);

  if (!hadExistingBid && allPendingAgentsFailed) {
    const endEvents = unwrapResult(
      decideEnd(
        working.state,
        { endReason: 'no_participants' },
        makeDecisionContext(ctx, snapshot.sessionId, snapshot.state.topic),
        nextSeq,
        ctxTs(ctx),
      ),
    );
    events.push(...endEvents);
  }

  return events;
}

async function collectBidOutcome(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
  agentName: string,
  callerCtx: CallerContext,
): Promise<BidOutcome> {
  const run = currentAgentRun(snapshot, agentName, DEFAULT_DISCUSS_PROVIDER, undefined);
  const priorSpeech = lastSpeech(snapshot.state.transcript);
  const priorSpeechForAgent = priorSpeech !== null && priorSpeech.speaker !== agentName ? priorSpeech : null;
  const mustAnswer = mustAnswerText(snapshot, agentName);
  const basePrompt = buildBidPrompt({
    selfName: agentName,
    state: snapshot.state,
    priorSpeech: priorSpeechForAgent,
    mustAnswer,
  });
  const instruction =
    run.executionSessionId === undefined
      ? buildFirstTurnInstruction({
          selfName: agentName,
          state: snapshot.state,
          priorSpeech: priorSpeechForAgent,
          mustAnswer,
        })
      : CONTINUE_TURN_INSTRUCTION;

  const latestRun = loadAttachedOrPersistedSnapshot(ctx, sessionId)?.runtime.agentRuns[agentName] ?? run;
  if (
    latestRun.currentJobId === undefined &&
    latestRun.lastAttemptOutcome === 'retryable_parse_error' &&
    (latestRun.currentAttempt ?? 0) >= MAX_BID_ATTEMPTS
  ) {
    return failedBidOutcome(agentName, { executionFailure: false });
  }

  let prompt = basePrompt;

  while (true) {
    const attempt = await executeAgentAttempt(ctx, {
      agentName,
      sessionId,
      provider: run.provider,
      model: normalizeModel(run.model),
      prompt,
      instruction,
      cwd: ctx.projectRoot,
      callerCtx,
      purpose: PURPOSE_BID,
      timeoutMs: BID_ATTEMPT_TIMEOUT_MS,
    });

    if (!isAttemptSuccess(attempt)) {
      return failedBidOutcome(agentName, {
        executionFailure: true,
        shouldExpel:
          loadAttachedOrPersistedSnapshot(ctx, sessionId)?.state.agents[agentName]?.participation === 'required',
      });
    }

    if (!(attempt.continuity?.resumable ?? true)) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'non_resumable',
      });
      return failedBidOutcome(agentName, {
        executionFailure: true,
        shouldExpel: snapshot.state.agents[agentName]?.participation === 'required',
      });
    }

    try {
      const bid = parseBidResponse(attempt.content);
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'completed',
      });
      return {
        agentName,
        score: bid.score,
        thought: bid.thought,
        executionFailure: false,
        shouldExpel: false,
        answeredCarryForward: mustAnswer !== null,
      };
    } catch (error: unknown) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName,
        purpose: PURPOSE_BID,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'retryable_parse_error',
      });

      if (attempt.attempt >= MAX_BID_ATTEMPTS) {
        return failedBidOutcome(agentName, { executionFailure: false });
      }

      prompt = buildBidRetryPrompt(basePrompt, attempt.content, formatTurnParseError(error));
    }
  }
}

export async function collectBids(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'bidding') {
    return { shouldResume: false };
  }

  const bidders = Object.entries(snapshot.state.current_bids)
    .filter(
      ([agentName, score]) =>
        score === null && !snapshot.state.agents[agentName]?.banned && !isManualParticipant(snapshot, agentName),
    )
    .map(([agentName]) => agentName);

  if (bidders.length === 0) {
    return { shouldResume: false };
  }

  const outcomes = await Promise.all(
    bidders.map((agentName) => collectBidOutcome(ctx, sessionId, snapshot, agentName, callerCtx)),
  );

  const committed = await commitDecision(ctx, sessionId, (current) => ({
    ok: true,
    value: buildBidBatch(ctx, current, outcomes),
  }));
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  return { shouldResume: committed.ok };
}
