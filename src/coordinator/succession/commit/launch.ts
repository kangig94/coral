import { formatError } from '../../../infra/error-format.js';
import { type UpgradeIntent } from '../../../infra/upgrade-intent.js';
import { observeSuccessionServing } from '../../../store/succession-writer-generation.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { CommitState, IncumbentWriterPorts, SuccessionCommitPorts, SuccessionShutdownPort } from './index.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { SuccessionLaunch, SuccessionLaunchSettlement } from '../reconciler/index.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitAttemptReaper } from './attempt-reaping.js';
import type { createCommitSupervisor } from './supervision.js';

const SERVING_RECEIPT_ATTEMPTS = 20;
const SERVING_RECEIPT_RETRY_MS = 50;

type CommitLaunchDependencies = Pick<
  ReturnType<typeof createCommitAttemptRecorder>,
  'updateAttempt' | 'recordReleasePending'
> &
  Pick<ReturnType<typeof createCommitAttemptReaper>, 'abortAndReap'> &
  Pick<ReturnType<typeof createCommitSupervisor>, 'superviseCommit'> &
  Readonly<{
    releaseToSuccessor: (attempt: SuccessionAttempt) => Promise<never>;
    writersOrThrow: () => IncumbentWriterPorts;
    handOverOpenConnections: (attempt: SuccessionAttempt) => Promise<void>;
  }>;

export function createCommitLaunch(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: CommitLaunchDependencies,
) {
  const { runtime } = ports;
  const {
    updateAttempt,
    abortAndReap,
    superviseCommit,
    releaseToSuccessor,
    recordReleasePending,
    writersOrThrow,
    handOverOpenConnections,
  } = dependencies;
  async function launchPrepared(intent: UpgradeIntent, preparation: SuccessionPreparation): Promise<SuccessionLaunch> {
    if (state.active !== null) throw new Error('Another succession attempt is active.');
    const attempt = await ports.startAttempt({ intent, preparation });
    try {
      await updateAttempt(attempt.attemptId, (current) => ({
        ...current,
        attemptChild: {
          attemptId: attempt.attemptId,
          pid: attempt.childIdentity.pid,
          incarnation: attempt.childIdentity.incarnation,
        },
      }));
    } catch (error: unknown) {
      const childHold = await abortAndReap(attempt, false);
      if (childHold !== null) ports.log(`Succession launch cleanup left a hold: ${childHold}\n`);
      throw error;
    }
    state.active = attempt;
    state.attemptAbort = new AbortController();
    const settled = superviseCommit(attempt, preparation)
      .catch(async (error: unknown): Promise<SuccessionLaunchSettlement> => {
        const reason = formatError(error);
        ports.log(`Succession commit supervision failed: ${reason}\n`);
        try {
          if (observeSuccessionServing(runtime, attempt.attemptId) !== null) return releaseToSuccessor(attempt);
        } catch (observationError: unknown) {
          ports.log(`Succession serving could not be observed: ${formatError(observationError)}\n`);
        }
        ports.setLaunchFenceActive(true);
        await recordReleasePending(attempt.attemptId, {
          blockers: [{ owner: 'succession-commit', reason }],
          retryCondition: { kind: 'attempt-expiry', evidence: 'same-build restart after failed supervision' },
        }).catch((writeError: unknown) =>
          ports.log(`Succession restart hold could not be recorded: ${formatError(writeError)}\n`),
        );
        return writersOrThrow().releaseAuthority({ kind: 'restart', reason });
      })
      .finally(() => {
        state.active = null;
        state.supervision = null;
      });
    state.supervision = settled;
    return { settled };
  }

  /** The reconciler's cadence retries whatever these attempts leave unsettled, since serving is already final. */
  async function publishServing(attemptId: string, recovery: boolean): Promise<void> {
    for (let attempt = 0; attempt < SERVING_RECEIPT_ATTEMPTS; attempt++) {
      const decision = await ports.reconciler().commit(attemptId);
      if (decision.kind === (recovery ? 'registered' : 'committed')) return;
      await runtime.time.sleep(SERVING_RECEIPT_RETRY_MS);
    }
    ports.log('Durable succession serving could not publish its completion receipt.\n');
  }

  const shutdown: SuccessionShutdownPort = {
    committed: () => state.active !== null && observeSuccessionServing(runtime, state.active.attemptId) !== null,
    handOverOpenConnections: async () => {
      if (state.active !== null) await handOverOpenConnections(state.active);
    },
    settleUncommittedAttempt: async () => {
      const attempt = state.active;
      if (attempt === null) return;
      state.attemptAbort.abort();
      // A connection forwarded after the abort would bounce between the attempt returning it and this listener.
      state.stopWindowForwarding?.();
      await attempt.abort().catch(() => {});
      await state.supervision;
    },
  };

  return { launchPrepared, publishServing, shutdown };
}
