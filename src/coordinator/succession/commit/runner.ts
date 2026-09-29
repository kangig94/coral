import { formatError } from '../../../infra/error-format.js';
import type { AttemptRetry } from '../../../infra/upgrade-intent.js';
import { observeSuccessionServing } from '../../../store/succession-writer-generation.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { CommitOutcome, RecoveryContext, SuccessionCommitPorts } from '../commit.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { createCommitAttemptReaper } from './attempt-reaping.js';
import type { createCommitReadiness } from './readiness.js';
import type { createCommitWriterPreparation } from './writer-preparation.js';
import type { createCommitWindowAdmission } from './window-admission.js';
import type { createCommitServing } from './serving.js';
import type { createFailedCommitWindow } from './failed-window.js';
import { TransientCommitFailure } from './failure.js';

type CommitRunnerDependencies = Pick<ReturnType<typeof createCommitAttemptReaper>, 'abortAndReap'> &
  Pick<ReturnType<typeof createCommitReadiness>, 'planCommit' | 'awaitAttemptReadiness'> &
  Pick<ReturnType<typeof createCommitWriterPreparation>, 'certifyRetiringCustody'> &
  Pick<ReturnType<typeof createCommitWindowAdmission>, 'openCommitWindow' | 'parkAndAuthorize'> &
  Pick<ReturnType<typeof createCommitServing>, 'awaitServing' | 'retryAfterWindowFailure'> &
  Pick<ReturnType<typeof createFailedCommitWindow>, 'closeFailedWindow'> &
  Readonly<{ retryAfterFailure: (error: unknown) => AttemptRetry }>;

export function createCommitRunner(ports: SuccessionCommitPorts, dependencies: CommitRunnerDependencies) {
  const { runtime } = ports;
  const {
    planCommit,
    awaitAttemptReadiness,
    retryAfterFailure,
    abortAndReap,
    certifyRetiringCustody,
    openCommitWindow,
    awaitServing,
    parkAndAuthorize,
    retryAfterWindowFailure,
    closeFailedWindow,
  } = dependencies;
  /**
   * A failure before the first commit window opens leaves nothing parked; every later failure must return the
   * parked state it leaves.
   */
  async function runCommit(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    recovery: RecoveryContext | null,
  ): Promise<CommitOutcome> {
    const recovering = recovery !== null;
    const plan = planCommit(attempt, preparation, recovering);
    try {
      await awaitAttemptReadiness(attempt, preparation, recovering);
    } catch (error: unknown) {
      if (!recovering) {
        throw error instanceof TransientCommitFailure ? error : new Error(formatError(error), { cause: error });
      }
      return {
        kind: 'failed',
        attempt,
        preparation,
        reason: formatError(error),
        retry: retryAfterFailure(error),
        ...recovery,
        pauseDeadlineAtMs: runtime.time.now(),
        childHold: await abortAndReap(attempt),
        unservedMintDiscard: null,
      };
    }
    const custody = plan.formatChanging ? await certifyRetiringCustody(preparation.epochKey) : null;
    const window = await openCommitWindow(attempt, preparation, recovery);
    const unsubscribe = attempt.onAcknowledgment((acknowledgment) => {
      if (acknowledgment.kind === 'hold') window.hold = acknowledgment.reason;
    });
    let failure: unknown;
    let retry: AttemptRetry = { kind: 'target-change' };
    try {
      await awaitServing(window, await parkAndAuthorize(window, plan, custody));
    } catch (error: unknown) {
      failure = error;
      retry = retryAfterWindowFailure(window, error);
    } finally {
      unsubscribe();
    }
    if (observeSuccessionServing(runtime, attempt.attemptId) !== null) return { kind: 'serving', attempt };
    return closeFailedWindow(window, plan, failure, retry);
  }

  return { runCommit };
}
