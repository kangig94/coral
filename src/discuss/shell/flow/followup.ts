import { makeEvent, type FollowUpQueueItem } from '../../events.js';
import { decideEnd, decideEpochSummary } from '../../state-machine.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import {
  FOLLOW_UP_TURN_INSTRUCTION,
  DEFAULT_DISCUSS_PROVIDER,
  PURPOSE_EPOCH_EVALUATION,
  PURPOSE_FOLLOW_UP,
  currentAgentRun,
  executeAgentAttempt,
  isAttemptSuccess,
  normalizeModel,
  recordJobFinished,
  runFacilitatorTurn,
} from '../runtime-build.js';
import { type DiscussContext } from '../types.js';
import { DiscussManagerError, unwrapResult } from '../errors.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from '../persistence.js';
import {
  type EpochEvaluation,
  type SubflowResult,
  CONVERGENCE_THRESHOLD,
  EPOCH_EVAL_TIMEOUT_MS,
  MAX_FOLLOW_UP_ATTEMPTS,
  SPEECH_TIMEOUT_MS,
  buildFollowUpPrompt,
  buildFollowUpRetryPrompt,
  ctxTs,
  emptyEpochEvaluation,
  encodeCarryForward,
  normalizeFollowUpAnswer,
  makeDecisionContext,
  parseEpochEvaluation,
  renderTranscriptText,
} from './primitives.js';

async function collectFollowUpAnswer(
  ctx: DiscussContext,
  sessionId: string,
  item: FollowUpQueueItem,
  invocationCtx: InvocationContext,
): Promise<string> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot) {
    return '';
  }

  const run = currentAgentRun(snapshot, item.agent, DEFAULT_DISCUSS_PROVIDER, undefined);
  const latestRun = snapshot.runtime.agentRuns[item.agent] ?? run;
  if (
    latestRun.currentJobId === undefined &&
    latestRun.lastAttemptOutcome === 'retryable_parse_error' &&
    (latestRun.currentAttempt ?? 0) >= MAX_FOLLOW_UP_ATTEMPTS
  ) {
    return '';
  }

  const basePrompt = buildFollowUpPrompt(snapshot.state, item.agent, item.question);
  let prompt = basePrompt;

  while (true) {
    const attempt = await executeAgentAttempt(ctx, {
      agentName: item.agent,
      sessionId,
      provider: run.provider,
      model: normalizeModel(run.model),
      prompt,
      instruction: FOLLOW_UP_TURN_INSTRUCTION,
      cwd: ctx.projectRoot,
      invocationCtx,
      purpose: PURPOSE_FOLLOW_UP,
      timeoutMs: SPEECH_TIMEOUT_MS,
    });

    if (!isAttemptSuccess(attempt)) {
      return attempt.message;
    }

    if (!(attempt.continuity?.resumable ?? true)) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: item.agent,
        purpose: PURPOSE_FOLLOW_UP,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'non_resumable',
      });
      return '';
    }

    const answer = normalizeFollowUpAnswer(attempt.content);
    if (answer.length > 0) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: item.agent,
        purpose: PURPOSE_FOLLOW_UP,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'completed',
      });
      return answer;
    }

    await recordJobFinished(ctx, {
      sessionId,
      agentName: item.agent,
      purpose: PURPOSE_FOLLOW_UP,
      jobId: attempt.jobId,
      attempt: attempt.attempt,
      outcome: 'retryable_parse_error',
    });
    if (attempt.attempt >= MAX_FOLLOW_UP_ATTEMPTS) {
      return '';
    }
    prompt = buildFollowUpRetryPrompt(basePrompt, attempt.content, 'Empty answer');
  }
}

export async function evaluateEpoch(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
): Promise<EpochEvaluation> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot) {
    return emptyEpochEvaluation();
  }

  const prompt = [
    'Review the discussion transcript and provide an evaluation:',
    '',
    renderTranscriptText(snapshot.state),
    '',
    'Respond with ONLY valid JSON (no code fences):',
    '{"convergence": 0-10, "summary": "...", "must_answer": [{"to": "agent-name", "question": "..."}]}',
    '',
    'convergence: 0=highly divergent, 10=fully converged',
    'summary: brief synthesis of key positions and progress',
    'must_answer: list of critical questions that need answers before convergence',
  ].join('\n');

  try {
    const result = await runFacilitatorTurn(ctx, {
      sessionId,
      prompt,
      instruction:
        'You are evaluating convergence in a discussion. Return only valid JSON that matches the requested schema.',
      invocationCtx,
      timeoutMs: EPOCH_EVAL_TIMEOUT_MS,
      purpose: PURPOSE_EPOCH_EVALUATION,
    });
    return parseEpochEvaluation(result.content, snapshot.state);
  } catch {
    return emptyEpochEvaluation();
  }
}

export async function handleEpochTransition(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.runtime.controlPhase !== 'evaluate_epoch') {
    return { shouldResume: false };
  }

  const evaluation = await evaluateEpoch(ctx, sessionId, invocationCtx);
  const committed = await commitDecision(ctx, sessionId, (current) => {
    if (current.runtime.controlPhase !== 'evaluate_epoch' || current.state.status !== 'bidding') {
      return { ok: true, value: [] };
    }

    const nextSeq = current.lastAppliedSeq + 1;
    const ts = ctxTs(ctx);
    if (evaluation.convergence < CONVERGENCE_THRESHOLD) {
      const summaryEvents = unwrapResult(
        decideEpochSummary(
          current.state,
          evaluation.summary,
          makeDecisionContext(ctx, sessionId, current.state.topic),
          nextSeq,
          ts,
        ),
      );

      return {
        ok: true,
        value: [
          ...summaryEvents,
          makeEvent(
            sessionId,
            ctx.projectRoot,
            current.state.topic,
            nextSeq + summaryEvents.length,
            'must_answer.carry_forward.set',
            ts,
            {
              items: evaluation.mustAnswer.map(encodeCarryForward),
            },
          ),
        ],
      };
    }

    if (evaluation.mustAnswer.length > 0) {
      return {
        ok: true,
        value: [
          makeEvent(sessionId, ctx.projectRoot, current.state.topic, nextSeq, 'follow_up.queue.set', ts, {
            queue: evaluation.mustAnswer.map((item) => ({
              agent: item.to,
              question: item.question,
            })),
          }),
        ],
      };
    }

    return decideEnd(
      current.state,
      { force: true, reason: 'Discussion converged.' },
      makeDecisionContext(ctx, sessionId, current.state.topic),
      nextSeq,
      ts,
    );
  });
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }

  return { shouldResume: committed.ok };
}

export async function runFollowUpTurns(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
): Promise<SubflowResult> {
  while (true) {
    const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
    if (!snapshot || snapshot.runtime.controlPhase !== 'collect_follow_up') {
      return { shouldResume: false };
    }

    const queue = snapshot.runtime.followUpQueue.slice();
    if (queue.length === 0) {
      const ended = await commitDecision(ctx, sessionId, (current) =>
        decideEnd(
          current.state,
          { force: true, reason: 'Discussion converged after follow-ups.' },
          makeDecisionContext(ctx, sessionId, current.state.topic),
          current.lastAppliedSeq + 1,
          ctxTs(ctx),
        ),
      );
      if (!ended.ok && ended.error !== 'session_not_found') {
        throw new DiscussManagerError(ended.error, ended.detail);
      }
      return { shouldResume: ended.ok };
    }

    const answers = await Promise.all(
      queue.map(async (item) => ({
        item,
        answer: await collectFollowUpAnswer(ctx, sessionId, item, invocationCtx),
      })),
    );
    const committed = await commitDecision(ctx, sessionId, (current) => ({
      ok: true,
      value: answers
        .filter(({ item }) =>
          current.runtime.followUpQueue.some(
            (queued) => queued.agent === item.agent && queued.question === item.question,
          ),
        )
        .map(({ item, answer }, index) =>
          makeEvent(
            sessionId,
            ctx.projectRoot,
            current.state.topic,
            current.lastAppliedSeq + 1 + index,
            'follow_up.answered',
            ctxTs(ctx),
            {
              agent: item.agent,
              question: item.question,
              answer,
            },
          ),
        ),
    }));
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
  }
}
