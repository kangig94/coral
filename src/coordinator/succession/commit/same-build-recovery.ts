import { formatError } from '../../../infra/error-format.js';
import { readUpgradeIntent, type UpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { SuccessionWriterEntitlement } from '../../../store/succession-writer-generation.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { CommitOutcome, CommitState, FailedCommit, RecoveryContext, SuccessionCommitPorts } from './index.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitAttemptReaper } from './attempt-reaping.js';
import type { createCommitReclaim } from './reclaim.js';
import type { createCommitRunner } from './runner.js';

type SameBuildRecoveryDependencies = Pick<ReturnType<typeof createCommitAttemptRecorder>, 'updateAttempt'> &
  Pick<ReturnType<typeof createCommitAttemptReaper>, 'abortAndReap'> &
  Pick<ReturnType<typeof createCommitReclaim>, 'unservedMintOf'> &
  Pick<ReturnType<typeof createCommitRunner>, 'runCommit'> &
  Readonly<{
    incumbentOwner: () => NonNullable<UpgradeIntent['attemptOwner']>;
    childHoldBlockers: (childHold: string | null) => { owner: string; reason: string }[];
  }>;

export function createSameBuildRecovery(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: SameBuildRecoveryDependencies,
) {
  const { runtime } = ports;
  const runDir = runtime.paths.coral.coordinator.runDir;
  const { updateAttempt, unservedMintOf, incumbentOwner, childHoldBlockers, abortAndReap, runCommit } = dependencies;
  async function recordRecoveryAttempt(failure: FailedCommit): Promise<SuccessionPreparation> {
    const recoveryPreparation: SuccessionPreparation = {
      ...failure.preparation,
      attemptId: runtime.ids.uuid(),
      admissionRevision: ports.launchCoordinator.admissionRevision(),
      stage: 'prepared',
      ready: null,
    };
    await updateAttempt(failure.attempt?.attemptId ?? failure.preparation.attemptId, (intent) => ({
      ...intent,
      ...unservedMintOf(failure),
      attemptId: recoveryPreparation.attemptId,
      attemptChild: null,
      attemptDeadline: null,
      attemptOwner: incumbentOwner(),
      recoveryAttemptId: recoveryPreparation.attemptId,
      recoveryBuildSetId: ports.incumbent.build?.manifest.buildSetId ?? null,
      recoveryGrantAttemptId: failure.preparation.receipts[0]?.attemptId ?? failure.preparation.attemptId,
      recoveryRetry: failure.retry,
      successionPreparation: recoveryPreparation,
      disposition: 'deferred',
      blockers: [
        { owner: 'succession-commit', reason: `same-build recovery after ${failure.reason}` },
        ...childHoldBlockers(failure.childHold),
      ],
      retryCondition: { kind: 'target-change', evidence: 'same-build recovery in progress' },
    }));
    return recoveryPreparation;
  }

  async function runSameBuildRecovery(
    failure: FailedCommit,
    writer: SuccessionWriterEntitlement,
    bundleDir: string,
  ): Promise<CommitOutcome> {
    const recovery: RecoveryContext = {
      writer,
      retirementStoreParked: failure.retirementStoreParked,
    };
    let recoveryPreparation: SuccessionPreparation = failure.preparation;
    let attempt: SuccessionAttempt | null = null;
    const failed = async (reason: string): Promise<FailedCommit> => ({
      kind: 'failed',
      attempt,
      preparation: recoveryPreparation,
      reason,
      retry: failure.retry,
      ...recovery,
      pauseDeadlineMonotonicMs: Number(runtime.time.monotonicNow()),
      childHold: attempt === null ? null : await abortAndReap(attempt),
      unservedMintDiscard: failure.unservedMintDiscard,
    });
    try {
      recoveryPreparation = await recordRecoveryAttempt(failure);
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable' || observed.intent.attemptId !== recoveryPreparation.attemptId) {
        throw new Error('Same-build recovery attempt changed before launch.');
      }
      attempt = await ports.startAttempt({
        intent: observed.intent,
        preparation: recoveryPreparation,
        recoveryBundleDir: bundleDir,
      });
      const started = attempt;
      await updateAttempt(started.attemptId, (intent) => ({
        ...intent,
        attemptChild: {
          attemptId: started.attemptId,
          pid: started.childIdentity.pid,
          incarnation: started.childIdentity.incarnation,
        },
      }));
    } catch (error: unknown) {
      return failed(`same-build recovery launch failed: ${formatError(error)}`);
    }
    state.active = attempt;
    try {
      // A recovery child's failure never decides whether the target it stands in for may be retried.
      const outcome = await runCommit(attempt, recoveryPreparation, recovery);
      return outcome.kind === 'failed'
        ? { ...outcome, retry: failure.retry, unservedMintDiscard: failure.unservedMintDiscard }
        : outcome;
    } catch (error: unknown) {
      return failed(`same-build recovery failed: ${formatError(error)}`);
    }
  }

  return { recordRecoveryAttempt, runSameBuildRecovery };
}
