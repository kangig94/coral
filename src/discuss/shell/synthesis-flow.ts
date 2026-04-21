import { decideSynthesis } from '../state-machine.js';
import type { CallerContext } from '../../shared/request-context.js';
import { PURPOSE_SYNTHESIS, runFacilitatorTurn } from './runtime-build.js';
import { DiscussManagerError, type DiscussContext } from './context.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from './persistence.js';
import { detachSession } from './registry.js';
import { type SubflowResult, SPEECH_TIMEOUT_MS, ctxTs, makeDecisionContext, renderTranscriptText } from './flow-shared.js';

export async function handleSynthesis(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<SubflowResult> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'synthesize') {
    return { shouldResume: false };
  }
  if (ctx.sessions.get(sessionId)?.abortEnded ?? false) {
    return { shouldResume: false };
  }

  const prompt = [
    'Write the final synthesis for this discussion.',
    '',
    renderTranscriptText(snapshot.state),
    '',
    snapshot.state.transcript.some((entry) => entry.type === 'follow_up')
      ? 'The transcript includes moderator follow-up answers. Incorporate them into the final synthesis.'
      : null,
    'Respond with the final synthesis text only. Do not use markdown or code fences.',
  ]
    .filter((section): section is string => section !== null)
    .join('\n');

  try {
    const result = await runFacilitatorTurn(ctx, {
      sessionId,
      prompt,
      instruction: 'You are writing the final synthesis for a discussion. Return only the synthesis text.',
      callerCtx,
      timeoutMs: SPEECH_TIMEOUT_MS,
      purpose: PURPOSE_SYNTHESIS,
    });

    if (!(result.continuity?.resumable ?? true)) {
      return { shouldResume: false };
    }

    const committed = await commitDecision(ctx, sessionId, (current) =>
      decideSynthesis(
        current.state,
        result.content,
        makeDecisionContext(ctx, sessionId, current.state.topic),
        current.lastAppliedSeq + 1,
        ctxTs(ctx),
      ),
    );
    if (!committed.ok && committed.error !== 'session_not_found') {
      throw new DiscussManagerError(committed.error, committed.detail);
    }
    detachSession(ctx, sessionId);
    return { shouldResume: false };
  } catch {
    return { shouldResume: false };
  }
}
