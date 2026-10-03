import { formatError } from '../../../infra/error-format.js';
import type { AttemptRetry } from '../../../infra/upgrade-intent.js';
import { discardUnservedRetirementMint } from '../../../store/epoch/index.js';
import type {
  CommitOutcome,
  CommitPlan,
  CommitState,
  CommitWindow,
  FailedCommit,
  SuccessionCommitPorts,
} from './index.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitAttemptReaper } from './attempt-reaping.js';
import type { createCommitServing } from './serving.js';

type FailedWindowDependencies = Pick<ReturnType<typeof createCommitAttemptRecorder>, 'recordReleasePending'> &
  Pick<ReturnType<typeof createCommitAttemptReaper>, 'abortAndReap'> &
  Pick<ReturnType<typeof createCommitServing>, 'successorServesBeforeRefusal'>;

export function createFailedCommitWindow(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: FailedWindowDependencies,
) {
  const { runtime } = ports;
  const { successorServesBeforeRefusal, recordReleasePending, abortAndReap } = dependencies;

  async function closeFailedWindow(
    window: CommitWindow,
    plan: CommitPlan,
    failure: unknown,
    retry: AttemptRetry,
  ): Promise<CommitOutcome> {
    const { attempt, preparation } = window;
    window.stopForwarding();
    state.stopWindowForwarding = null;
    if (window.writer !== null) ports.setLaunchFenceActive(true);
    const refusal = await successorServesBeforeRefusal(window);
    if (refusal === 'serving') return { kind: 'serving', attempt };
    if (refusal === 'unresolved') {
      return { kind: 'unresolved', attempt, reason: 'Failed successor could not be durably refused.' };
    }
    ports.waitHandover.renew();

    const reason = formatError(failure);
    await recordReleasePending(attempt.attemptId, {
      blockers: [{ owner: 'succession-commit', reason }],
      retryCondition: { kind: 'attempt-expiry', evidence: 'incumbent writer reclaim' },
    });
    const childHold = await abortAndReap(attempt);
    let unservedMintDiscard: FailedCommit['unservedMintDiscard'] = null;
    if (plan.formatChanging) {
      const discarded = discardUnservedRetirementMint(runtime, preparation.epochKey, attempt.attemptId);
      if (discarded.kind === 'serving') return { kind: 'serving', attempt };
      if (discarded.kind === 'held') {
        ports.log(`Unserved retirement mint could not be discarded yet: ${discarded.reason}\n`);
        unservedMintDiscard = { attemptId: attempt.attemptId, incumbentEpochKey: preparation.epochKey };
      }
    }
    return {
      kind: 'failed',
      attempt,
      preparation,
      reason,
      retry,
      writer: window.writer,
      retirementStoreParked: window.retirementStoreParked,
      pauseDeadlineMonotonicMs: window.pauseDeadlineMonotonicMs,
      childHold,
      unservedMintDiscard,
    };
  }

  return { closeFailedWindow };
}
