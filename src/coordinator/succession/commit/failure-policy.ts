import type { AttemptRetry } from '../../../infra/upgrade-intent.js';
import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';
import type { CommitState } from './index.js';
import { TransientCommitFailure } from './failure.js';

export function createCommitFailurePolicy(state: CommitState) {
  /** An incumbent's own shutdown is no evidence against its target, so a failure alongside it decides nothing. */
  const retryAfterFailure = (error: unknown): AttemptRetry =>
    error instanceof TransientCommitFailure
      ? {
          kind: 'transient',
          retryAfterMs: error.retryAfterMs,
          ...(error.obligationChange ? { obligationChange: true } : {}),
        }
      : state.attemptAbort.signal.aborted
        ? { kind: 'transient', retryAfterMs: TRANSIENT_RETRY_BASE_MS }
        : { kind: 'target-change' };

  const childHoldBlockers = (childHold: string | null): { owner: string; reason: string }[] =>
    childHold === null ? [] : [{ owner: 'succession-attempt-child', reason: childHold }];

  return { retryAfterFailure, childHoldBlockers };
}
