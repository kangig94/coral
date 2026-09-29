import { formatError } from '../../../infra/error-format.js';
import type { AttemptRetry } from '../../../infra/upgrade-intent.js';
import { observeSuccessionServing } from '../../../store/succession-writer-generation.js';
import { failedAttemptRetry } from '../attempt-retry.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { CommitOutcome, CommitState, IncumbentWriterPorts, SuccessionCommitPorts } from '../commit.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { SuccessionLaunchSettlement } from '../reconciler.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitAttemptReaper } from './attempt-reaping.js';
import type { createCommitReclaim } from './reclaim.js';
import type { createCommitRecoverySettlement } from './recovery-settlement.js';
import type { createCommitRunner } from './runner.js';

type SupervisionDependencies = Pick<
  ReturnType<typeof createCommitAttemptRecorder>,
  'recordReleasePending' | 'clearAttempt'
> &
  Pick<ReturnType<typeof createCommitAttemptReaper>, 'abortAndReap'> &
  Pick<ReturnType<typeof createCommitReclaim>, 'wakeForRetry'> &
  Pick<ReturnType<typeof createCommitRecoverySettlement>, 'releaseUnresolved' | 'settleFailedCommit'> &
  Pick<ReturnType<typeof createCommitRunner>, 'runCommit'> &
  Readonly<{
    retryAfterFailure: (error: unknown) => AttemptRetry;
    childHoldBlockers: (childHold: string | null) => { owner: string; reason: string }[];
    releaseToSuccessor: (attempt: SuccessionAttempt) => Promise<never>;
    writersOrThrow: () => IncumbentWriterPorts;
  }>;

export function createCommitSupervisor(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: SupervisionDependencies,
) {
  const { runtime } = ports;
  const {
    runCommit,
    retryAfterFailure,
    recordReleasePending,
    abortAndReap,
    clearAttempt,
    childHoldBlockers,
    wakeForRetry,
    releaseToSuccessor,
    releaseUnresolved,
    settleFailedCommit,
    writersOrThrow,
  } = dependencies;
  async function superviseCommit(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
  ): Promise<SuccessionLaunchSettlement> {
    let outcome: CommitOutcome;
    try {
      outcome = await runCommit(attempt, preparation, null);
    } catch (error: unknown) {
      const reason = formatError(error);
      const retry = retryAfterFailure(error);
      await recordReleasePending(attempt.attemptId, {
        blockers: [{ owner: 'succession-prepare', reason }],
        retryCondition: { kind: 'attempt-expiry', evidence: 'successor attempt exit' },
      });
      const childHold = await abortAndReap(attempt);
      const settlement = await clearAttempt(attempt.attemptId, (current) => ({
        ...current,
        disposition: 'deferred',
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        successionPreparation: null,
        blockers: [
          { owner: 'succession-prepare', reason: `incumbent retained authority after ${reason}` },
          ...childHoldBlockers(childHold),
        ],
        ...failedAttemptRetry(current, retry, 'successor readiness failure', runtime.time.now()),
      }));
      wakeForRetry(retry);
      return settlement;
    }
    if (outcome.kind === 'serving') return releaseToSuccessor(outcome.attempt);
    if (outcome.kind === 'unresolved') return releaseUnresolved(outcome);
    try {
      return await settleFailedCommit(outcome);
    } catch (error: unknown) {
      if (state.active !== null && observeSuccessionServing(runtime, state.active.attemptId) !== null) {
        return releaseToSuccessor(state.active);
      }
      ports.log(`Failed succession commit could not be settled in place: ${formatError(error)}\n`);
      return writersOrThrow().releaseAuthority({ kind: 'restart', reason: formatError(error) });
    }
  }

  return { superviseCommit };
}
