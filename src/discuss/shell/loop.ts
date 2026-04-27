import { decideBidRoundClose, decideEnd } from '../state-machine.js';
import { nowIsoString } from '../../infra/time.js';
import { errorMessage } from '../../infra/error-format.js';
import { coordinatorLog } from '../../infra/coordinator-log.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { hasActiveBidWork, hasPendingAutoBidders, isManualParticipant } from './runtime-build.js';
import { type DiscussContext, DiscussManagerError } from './context.js';
import { commitDecision } from './persistence.js';
import { collectBids } from './bid-flow.js';
import { collectSpeech } from './speech-flow.js';
import { handleEpochTransition, runFollowUpTurns } from './followup-flow.js';
import { makeDecisionContext } from './flow-primitives.js';
import { handleSynthesis } from './synthesis-flow.js';
import { getSession } from './registry.js';

async function waitForObserverBidWindow(
  time: DiscussContext['runtime']['time'],
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof time.setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) {
        time.clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = time.setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function handleBidRoundClose(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
): Promise<{ shouldResume: boolean }> {
  const resolved = await commitDecision(ctx, sessionId, (latest) =>
    decideBidRoundClose(
      latest.state,
      makeDecisionContext(ctx, latest.sessionId, latest.state.topic),
      latest.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (resolved.ok) {
    return { shouldResume: true };
  }
  if (resolved.error === 'quorum_not_met') {
    return collectBids(ctx, sessionId, invocationCtx);
  }
  if (resolved.error === 'session_not_found') {
    return { shouldResume: false };
  }
  throw new DiscussManagerError(resolved.error, resolved.detail);
}

async function forceEndAfterLoopFailure(ctx: DiscussContext, sessionId: string, error: unknown): Promise<void> {
  const session = getSession(ctx, sessionId);
  if (!session || session.snapshot.state.status === 'ended') {
    return;
  }

  const detail = errorMessage(error);
  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideEnd(
      current.state,
      { force: true, reason: detail },
      makeDecisionContext(ctx, sessionId, current.state.topic),
      current.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }
}

export function resumeLoop(ctx: DiscussContext, sessionId: string, invocationCtx: InvocationContext): void {
  const session = getSession(ctx, sessionId);
  if (!session || session.loopState.running || session.controller.signal.aborted) {
    return;
  }

  const resumeScheduledAt = ctx.runtime.time.now();
  const timer = ctx.runtime.time.setTimeout(() => {
    void continueLoop(ctx, sessionId, invocationCtx, resumeScheduledAt).catch((error: unknown) => {
      void forceEndAfterLoopFailure(ctx, sessionId, error).catch((endErr: unknown) => {
        coordinatorLog.error(`Discuss session ${sessionId} force-end also failed`, endErr);
      });
    });
  }, 1);
  timer.unref?.();
}

export async function continueLoop(
  ctx: DiscussContext,
  sessionId: string,
  invocationCtx: InvocationContext,
  resumeScheduledAt?: number,
): Promise<void> {
  const session = getSession(ctx, sessionId);
  if (!session || session.loopState.running) {
    return;
  }

  session.loopState.running = true;
  let observerWaitResumeScheduledAt = resumeScheduledAt;

  try {
    while (true) {
      const current = getSession(ctx, sessionId);
      if (!current || current.controller.signal.aborted) {
        return;
      }

      const snapshot = current.snapshot;
      if (snapshot.runtime.controlPhase !== 'observer_wait') {
        observerWaitResumeScheduledAt = undefined;
      }

      if (snapshot.runtime.controlPhase === 'synthesize') {
        const result = await handleSynthesis(ctx, sessionId, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'evaluate_epoch') {
        const result = await handleEpochTransition(ctx, sessionId, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'collect_follow_up') {
        const result = await runFollowUpTurns(ctx, sessionId, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.state.status === 'ended') {
        return;
      }

      if (snapshot.state.status === 'speaking') {
        if (!snapshot.state.current_speaker) {
          return;
        }
        if (isManualParticipant(snapshot, snapshot.state.current_speaker)) {
          return;
        }
        const result = await collectSpeech(ctx, sessionId, snapshot.state.current_speaker, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'observer_wait') {
        const resumeElapsedMs =
          observerWaitResumeScheduledAt === undefined
            ? 0
            : Math.max(0, ctx.runtime.time.now() - observerWaitResumeScheduledAt);
        observerWaitResumeScheduledAt = undefined;
        await waitForObserverBidWindow(
          ctx.runtime.time,
          Math.max(0, snapshot.state.min_bid_delay_ms - resumeElapsedMs),
          current.controller.signal,
        );
        const result = await handleBidRoundClose(ctx, sessionId, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.state.status !== 'bidding') {
        return;
      }

      if (hasActiveBidWork(snapshot) || hasPendingAutoBidders(snapshot)) {
        const result = await collectBids(ctx, sessionId, invocationCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      const result = await handleBidRoundClose(ctx, sessionId, invocationCtx);
      if (!result.shouldResume) {
        return;
      }
    }
  } finally {
    const current = getSession(ctx, sessionId);
    if (current) {
      current.loopState.running = false;
    }
  }
}
