import { formatError } from '../../../infra/error-format.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type {
  CommitOutcome,
  CommitState,
  FailedCommit,
  IncumbentWriterPorts,
  SuccessionCommitPorts,
} from '../commit.js';
import type { SuccessionLaunchSettlement } from '../reconciler.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitReclaim } from './reclaim.js';
import type { createSameBuildRecovery } from './same-build-recovery.js';

const SAME_BUILD_RECOVERY_ATTEMPTS = 2;

type RecoverySettlementDependencies = Pick<ReturnType<typeof createCommitAttemptRecorder>, 'recordReleasePending'> &
  Pick<ReturnType<typeof createCommitReclaim>, 'reclaimInPlace'> &
  Pick<ReturnType<typeof createSameBuildRecovery>, 'recordRecoveryAttempt' | 'runSameBuildRecovery'> &
  Readonly<{
    writersOrThrow: () => IncumbentWriterPorts;
    releaseToSuccessor: (attempt: SuccessionAttempt) => Promise<never>;
  }>;

export function createCommitRecoverySettlement(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: RecoverySettlementDependencies,
) {
  const {
    reclaimInPlace,
    recordRecoveryAttempt,
    runSameBuildRecovery,
    recordReleasePending,
    writersOrThrow,
    releaseToSuccessor,
  } = dependencies;
  /**
   * Every failed commit ends in one of three named exits: the incumbent reclaims in place, a same-build
   * successor it launched serves, or the incumbent records a same-build recovery grant and exits so the next
   * startup of this build serves from it. A parked incumbent that stays alive is never one of them.
   */
  async function settleFailedCommit(initial: FailedCommit): Promise<SuccessionLaunchSettlement> {
    let failure = initial;
    for (let relaunches = 0; ; relaunches++) {
      const reclaimed = await reclaimInPlace(failure, relaunches > 0);
      if (reclaimed !== null) return reclaimed;
      ports.setLaunchFenceActive(true);
      const writer = failure.writer;
      const bundleDir = ports.incumbent.build?.bundleDir;
      if (
        writer === null ||
        bundleDir === undefined ||
        state.attemptAbort.signal.aborted ||
        relaunches >= SAME_BUILD_RECOVERY_ATTEMPTS
      ) {
        await recordRecoveryAttempt(failure).catch((error: unknown) =>
          ports.log(`Same-build restart grant could not be recorded: ${formatError(error)}\n`),
        );
        ports.log(`Incumbent exits for a same-build restart after ${failure.reason}\n`);
        return writersOrThrow().releaseAuthority({ kind: 'restart', reason: failure.reason });
      }
      const outcome = await runSameBuildRecovery(failure, writer, bundleDir);
      if (outcome.kind === 'serving') return releaseToSuccessor(outcome.attempt);
      if (outcome.kind === 'unresolved') return releaseUnresolved(outcome);
      failure = outcome;
    }
  }

  async function releaseUnresolved(outcome: Extract<CommitOutcome, { kind: 'unresolved' }>): Promise<never> {
    ports.setLaunchFenceActive(true);
    await recordReleasePending(outcome.attempt.attemptId, {
      blockers: [{ owner: 'succession-commit', reason: outcome.reason }],
      retryCondition: { kind: 'attempt-expiry', evidence: 'unresolved successor refusal' },
    });
    return writersOrThrow().releaseAuthority({ kind: 'restart', reason: outcome.reason });
  }

  return { settleFailedCommit, releaseUnresolved };
}
