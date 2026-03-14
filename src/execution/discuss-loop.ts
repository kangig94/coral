import { decideBidRoundClose, decideEnd } from '../discuss/state-machine.js';
import { nowIsoString } from '../discuss/util/time.js';
import type { CallerContext } from './request-context.js';
import {
  hasActiveBidWork,
  hasPendingAutoBidders,
  isManualParticipant,
} from './discuss-executor.js';
import { type DiscussContext, DiscussManagerError } from './discuss-context.js';
import { commitDecision } from './discuss-persistence.js';
import {
  collectBids,
  collectSpeech,
  handleEpochTransition,
  handleSynthesis,
  runFollowUpTurns,
} from './discuss-subflows.js';
import { getSession } from './discuss-registry.js';

async function waitForObserverBidWindow(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function forceEndAfterLoopFailure(
  ctx: DiscussContext,
  sessionId: string,
  error: unknown,
): Promise<void> {
  const session = getSession(ctx, sessionId);
  if (!session || session.snapshot.state.status === 'ended') {
    return;
  }

  const detail = error instanceof Error ? error.message : String(error);
  const committed = await commitDecision(ctx, sessionId, (current) =>
    decideEnd(
      current.state,
      { force: true, reason: detail },
      sessionId,
      ctx.projectRoot,
      current.state.topic,
      current.lastAppliedSeq + 1,
      nowIsoString(),
    ));
  if (!committed.ok && committed.error !== 'session_not_found') {
    throw new DiscussManagerError(committed.error, committed.detail);
  }
}

export function resumeLoop(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): void {
  const session = getSession(ctx, sessionId);
  if (!session || session.loopState.running || session.controller.signal.aborted) {
    return;
  }

  setTimeout(() => {
    void continueLoop(ctx, sessionId, callerCtx).catch((error: unknown) => {
      void forceEndAfterLoopFailure(ctx, sessionId, error);
    });
  }, 0);
}

export async function continueLoop(
  ctx: DiscussContext,
  sessionId: string,
  callerCtx: CallerContext,
): Promise<void> {
  const session = getSession(ctx, sessionId);
  if (!session || session.loopState.running) {
    return;
  }

  session.loopState.running = true;

  try {
    while (true) {
      const current = getSession(ctx, sessionId);
      if (!current || current.controller.signal.aborted) {
        return;
      }

      const snapshot = current.snapshot;

      if (snapshot.runtime.controlPhase === 'synthesize') {
        const result = await handleSynthesis(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'evaluate_epoch') {
        const result = await handleEpochTransition(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'collect_follow_up') {
        const result = await runFollowUpTurns(ctx, sessionId, callerCtx);
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
        const result = await collectSpeech(ctx, sessionId, snapshot.state.current_speaker, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      if (snapshot.runtime.controlPhase === 'observer_wait') {
        await waitForObserverBidWindow(snapshot.state.min_bid_delay_ms, current.controller.signal);
        const resolved = await commitDecision(ctx, sessionId, (latest) =>
          decideBidRoundClose(
            latest.state,
            latest.sessionId,
            ctx.projectRoot,
            latest.state.topic,
            latest.lastAppliedSeq + 1,
            nowIsoString(),
          ));
        if (!resolved.ok) {
          if (resolved.error === 'quorum_not_met') {
            const result = await collectBids(ctx, sessionId, callerCtx);
            if (!result.shouldResume) {
              return;
            }
            continue;
          }
          if (resolved.error === 'session_not_found') {
            return;
          }
          throw new DiscussManagerError(resolved.error, resolved.detail);
        }
        continue;
      }

      if (snapshot.state.status !== 'bidding') {
        return;
      }

      if (hasActiveBidWork(snapshot) || hasPendingAutoBidders(snapshot)) {
        const result = await collectBids(ctx, sessionId, callerCtx);
        if (!result.shouldResume) {
          return;
        }
        continue;
      }

      const resolved = await commitDecision(ctx, sessionId, (latest) =>
        decideBidRoundClose(
          latest.state,
          latest.sessionId,
          ctx.projectRoot,
          latest.state.topic,
          latest.lastAppliedSeq + 1,
          nowIsoString(),
        ));
      if (!resolved.ok) {
        if (resolved.error === 'quorum_not_met') {
          const result = await collectBids(ctx, sessionId, callerCtx);
          if (!result.shouldResume) {
            return;
          }
          continue;
        }
        if (resolved.error === 'session_not_found') {
          return;
        }
        throw new DiscussManagerError(resolved.error, resolved.detail);
      }
    }
  } finally {
    const current = getSession(ctx, sessionId);
    if (current) {
      current.loopState.running = false;
    }
  }
}
