import { decideSynthesis } from '../../state-machine.js';
import type { InvocationContext } from '../../../runtime/invocation-context.js';
import { backendLog } from '../../../infra/backend-log.js';
import { errorMessage } from '../../../infra/error-format.js';
import { PURPOSE_SYNTHESIS, runFacilitatorTurn } from '../runtime-build.js';
import { type DiscussContext } from '../types.js';
import { DiscussManagerError } from '../errors.js';
import { commitDecision, loadAttachedOrPersistedSnapshot } from '../persistence.js';
import { detachSession } from '../registry.js';
import { writeDiscussRecord } from '../../transcript-export.js';
import {
  type SubflowResult,
  SPEECH_TIMEOUT_MS,
  ctxTs,
  makeDecisionContext,
  renderTranscriptText,
} from './primitives.js';

export async function handleSynthesis(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
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
      invocationCtx,
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
    if (committed.ok) {
      // Materialize the completed discussion as a markdown record in the project
      // data dir. Best-effort export of the journal's discuss stream — a write
      // failure must never break the discussion (the authoritative record lives
      // in the journal).
      try {
        writeDiscussRecord(ctx.runtime, committed.snapshot);
      } catch (error) {
        backendLog.warn(`Discuss record export failed for ${sessionId}: ${errorMessage(error)}`);
      }
    }
    detachSession(ctx, sessionId);
    return { shouldResume: false };
  } catch (error) {
    const detail = errorMessage(error);
    backendLog.warn(`Discuss synthesis failed for ${sessionId}: ${detail}`);
    return { shouldResume: false };
  }
}
