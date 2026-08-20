import { decideSynthesis } from '../../state-machine.js';
import type { PersistedDiscussSnapshot } from '../../events.js';
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

async function finalizeSynthesizedSession(
  ctx: DiscussContext,
  sessionId: string,
  snapshot: PersistedDiscussSnapshot,
): Promise<void> {
  // Materialize the completed discussion as a markdown record in the project
  // data dir. Best-effort export of the journal's discuss stream — a write
  // failure must never break the discussion (the authoritative record lives
  // in the journal).
  let exportedRecord = false;
  try {
    writeDiscussRecord(ctx.runtime, snapshot);
    exportedRecord = true;
  } catch (error) {
    backendLog.warn(`Discuss record export failed for ${sessionId}: ${errorMessage(error)}`);
  }
  if (!exportedRecord) {
    detachSession(ctx, sessionId);
    return;
  }
  // The discussion is fully synthesized. Participant (and facilitator) provider
  // sessions were retained across turns for multi-turn resume and handoff
  // recovery, which no longer applies — discard each one's native session log so
  // it does not accumulate as noise. Best-effort: a failure must never break the
  // already-recorded discussion.
  for (const run of Object.values(snapshot.runtime.agentRuns)) {
    if (run.executionSessionId === undefined) {
      continue;
    }
    try {
      await ctx.discardSessionArtifacts?.(run.executionSessionId);
    } catch (error) {
      backendLog.warn(`Discuss artifact cleanup failed for session ${run.executionSessionId}: ${errorMessage(error)}`);
    }
  }
  detachSession(ctx, sessionId);
}

function fallbackSynthesisText(snapshot: PersistedDiscussSnapshot, detail: string): string {
  const endReason = snapshot.state.end_reason_content ?? 'The discussion ended before a final synthesis was available.';
  return [
    'Automatic final synthesis could not be generated.',
    `Reason: ${detail}`,
    `End state: ${endReason}`,
    'The full discussion transcript remains available in the audit view.',
  ].join('\n');
}

async function commitFallbackSynthesis(ctx: DiscussContext, sessionId: string, detail: string): Promise<boolean> {
  const snapshot = loadAttachedOrPersistedSnapshot(ctx, sessionId);
  if (!snapshot || snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'synthesize') {
    return false;
  }
  if (ctx.sessions.get(sessionId)?.abortEnded ?? false) {
    return false;
  }

  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideSynthesis(
      current.state,
      fallbackSynthesisText(current, detail),
      makeDecisionContext(ctx, sessionId, current.state.topic),
      current.lastAppliedSeq + 1,
      ctxTs(ctx),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }
  if (!committed.ok) {
    return false;
  }
  await finalizeSynthesizedSession(ctx, sessionId, committed.snapshot);
  return true;
}

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
      await commitFallbackSynthesis(ctx, sessionId, 'The synthesis provider returned non-resumable continuity.');
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
      await finalizeSynthesizedSession(ctx, sessionId, committed.snapshot);
    }
    return { shouldResume: false };
  } catch (error) {
    const detail = errorMessage(error);
    backendLog.warn(`Discuss synthesis failed for ${sessionId}: ${detail}`);
    try {
      await commitFallbackSynthesis(ctx, sessionId, detail);
    } catch (fallbackError) {
      backendLog.warn(`Discuss fallback synthesis failed for ${sessionId}: ${errorMessage(fallbackError)}`);
    }
    return { shouldResume: false };
  }
}
