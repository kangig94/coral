import { decideSpeech, decideSpeechTimeout } from '../../state-machine.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import { buildSpeechPrompt } from '../prompts.js';
import { DEFAULT_DISCUSS_PROVIDER } from '../../command-schemas.js';
import {
  CONTINUE_TURN_INSTRUCTION,
  PURPOSE_SPEECH,
  currentAgentRun,
  executeAgentAttempt,
  isAttemptSuccess,
  normalizeModel,
  recordJobFinished,
} from '../runtime-build.js';
import { type DiscussContext } from '../types.js';
import { DiscussManagerError } from '../errors.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from '../persistence.js';
import {
  type SubflowResult,
  MAX_SPEECH_ATTEMPTS,
  SPEECH_TIMEOUT_MS,
  buildSpeechRetryPrompt,
  ctxTs,
  makeDecisionContext,
} from './primitives.js';

export async function collectSpeech(
  ctx: DiscussContext,
  sessionId: string,
  winnerName: string,
  invocationCtx: InvocationContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'speaking' || snapshot.state.current_speaker !== winnerName) {
    return { shouldResume: false };
  }

  const agentRun = currentAgentRun(snapshot, winnerName, DEFAULT_DISCUSS_PROVIDER, undefined);
  const basePrompt = buildSpeechPrompt({
    selfName: winnerName,
    state: snapshot.state,
    priorSpeech: null,
    mustAnswer: null,
  });
  let prompt = basePrompt;

  while (true) {
    const attempt = await executeAgentAttempt(ctx, {
      agentName: winnerName,
      sessionId,
      provider: agentRun.provider,
      model: normalizeModel(agentRun.model),
      prompt,
      instruction: CONTINUE_TURN_INSTRUCTION,
      cwd: ctx.projectRoot,
      invocationCtx,
      purpose: PURPOSE_SPEECH,
      timeoutMs: SPEECH_TIMEOUT_MS,
    });

    if (!isAttemptSuccess(attempt) || !(attempt.continuity?.resumable ?? true)) {
      if (isAttemptSuccess(attempt)) {
        await recordJobFinished(ctx, {
          sessionId,
          agentName: winnerName,
          purpose: PURPOSE_SPEECH,
          jobId: attempt.jobId,
          attempt: attempt.attempt,
          outcome: 'non_resumable',
        });
      }
      const committed = await commitDecision(ctx, sessionId, (current) =>
        decideSpeechTimeout(
          current.state,
          makeDecisionContext(ctx, sessionId, current.state.topic),
          current.lastAppliedSeq + 1,
          ctxTs(ctx),
        ),
      );
      if (!committed.ok && committed.error !== 'session_not_found') {
        throw new DiscussManagerError(committed.error, committed.detail);
      }
      return { shouldResume: committed.ok };
    }

    const speech = attempt.content.trim();
    if (speech.length === 0) {
      await recordJobFinished(ctx, {
        sessionId,
        agentName: winnerName,
        purpose: PURPOSE_SPEECH,
        jobId: attempt.jobId,
        attempt: attempt.attempt,
        outcome: 'retryable_parse_error',
      });
      if (attempt.attempt < MAX_SPEECH_ATTEMPTS) {
        prompt = buildSpeechRetryPrompt(basePrompt, attempt.content, 'Empty speech');
        continue;
      }
      const committed = await commitDecision(ctx, sessionId, (current) =>
        decideSpeechTimeout(
          current.state,
          makeDecisionContext(ctx, sessionId, current.state.topic),
          current.lastAppliedSeq + 1,
          ctxTs(ctx),
        ),
      );
      if (!committed.ok && committed.error !== 'session_not_found') {
        throw new DiscussManagerError(committed.error, committed.detail);
      }
      return { shouldResume: committed.ok };
    }

    await recordJobFinished(ctx, {
      sessionId,
      agentName: winnerName,
      purpose: PURPOSE_SPEECH,
      jobId: attempt.jobId,
      attempt: attempt.attempt,
      outcome: 'completed',
    });
    const committed = await commitDecision(ctx, sessionId, (current) =>
      decideSpeech(
        current.state,
        winnerName,
        speech,
        makeDecisionContext(ctx, sessionId, current.state.topic),
        current.lastAppliedSeq + 1,
        ctxTs(ctx),
      ),
    );
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
    return { shouldResume: committed.ok };
  }
}
