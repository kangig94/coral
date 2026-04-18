import { decideBidRoundClose, decideEnd } from '../state-machine.js';
import { nowIsoString } from '../util/time.js';
import { errorMessage } from '../../shared/utils.js';
import { backendLog } from '../../shared/backend-log.js';
import type { CallerContext } from '../../shared/request-context.js';
import { hasActiveBidWork, hasPendingAutoBidders, isManualParticipant } from './runtime-build.js';
import { type DiscussContext, DiscussManagerError } from './context.js';
import { commitDecision } from './persistence.js';
import * as discussSubflows from './subflows.js';
import { collectBids } from './bid-flow.js';
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
  callerCtx: CallerContext,
): Promise<{ shouldResume: boolean }> {
  const resolved = await commitDecision(ctx, sessionId, (latest) =>
    decideBidRoundClose(
      latest.state,
      { sessionId: latest.sessionId, projectRoot: ctx.projectRoot, topic: latest.state.topic },
      latest.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (resolved.ok) {
    return { shouldResume: true };
  }
  if (resolved.error === 'quorum_not_met') {
    return discussSubflows.collectBids(ctx, sessionId, callerCtx);
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
      { sessionId: sessionId, projectRoot: ctx.projectRoot, topic: current.state.topic },
      current.lastAppliedSeq + 1,
      nowIsoString(ctx.runtime.time),
    ),
  );
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }
}

export function resumeLoop(ctx: DiscussContext, sessionId: string, callerCtx: CallerContext): void {
  const session = getSession(ctx, sessionId);
  if (!session || session.loopState.running || session.controller.signal.aborted) {
    return;
  }

  const resumeScheduledAt = ctx.runtime.time.now();
  const timer = ctx.runtime.time.setTimeout(() => {
    void continueLoop(ctx, sessionId, callerCtx, resumeScheduledAt).catch((error: unknown) => {
      void forceEndAfterLoopFailure(ctx, sessionId, error).catch((endErr: unknown) => {
        backendLog.error(`Discuss session ${sessionId} force-end also failed`, endErr);
      });
    });
  }, 1);
  timer.unref?.();
}

export async function continueLoop(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
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
        const result = await discussSubflows.handleSynthesis(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'evaluate_epoch') {
        const result = await discussSubflows.handleEpochTransition(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'collect_follow_up') {
        const result = await discussSubflows.runFollowUpTurns(ctx, sessionId, callerCtx);
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
        const result = await discussSubflows.collectSpeech(ctx, sessionId, snapshot.state.current_speaker, callerCtx);
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
        const result = await handleBidRoundClose(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.state.status !== 'bidding') {
        return;
      }

      if (hasActiveBidWork(snapshot) || hasPendingAutoBidders(snapshot)) {
        const result = await discussSubflows.collectBids(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      const result = await handleBidRoundClose(ctx, sessionId, callerCtx);
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
