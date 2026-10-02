import type { TimerHandle } from '../../../infra/port-types.js';
import { readUpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';
import type { CommitPlan, SuccessionCommitPorts } from './index.js';
import type { SuccessionPreparation } from '../protocol.js';
import { observeRetirementDisposition } from '../retirement-disposition.js';
import { waitForAttemptReady } from './attempt-readiness.js';
import { TransientCommitFailure } from './failure.js';

const LISTENER_TRANSFER_TIMEOUT_MS = 10_000;

export function createCommitReadiness(ports: SuccessionCommitPorts) {
  const { runtime } = ports;
  const runDir = runtime.paths.coral.coordinator.runDir;
  /**
   * Only evidence fixed before serving may decide this: a serving record is final, so a certificate or epoch address
   * that moves on after it would refuse the attempt's completion receipt forever.
   */
  function retirementServes(attemptId: string, incumbentEpochKey: string): boolean {
    const recorded = observeRetirementDisposition(runtime, attemptId);
    const observed = readUpgradeIntent(runDir);
    return (
      recorded.kind === 'recorded' &&
      recorded.disposition.incumbentEpochKey === incumbentEpochKey &&
      observed.kind === 'readable' &&
      observed.intent.attemptId === attemptId &&
      recorded.disposition.successorFingerprint === observed.intent.target.build.storeFormatFingerprint
    );
  }

  async function awaitListenerTransfer(attempt: SuccessionAttempt): Promise<void> {
    let transferTimeout: TimerHandle | null = null;
    try {
      await Promise.race([
        attempt.transferListeners(ports.listener()),
        new Promise<never>((_resolve, reject) => {
          transferTimeout = runtime.time.setTimeout(
            () => reject(new Error('Successor did not accept every listening address.')),
            LISTENER_TRANSFER_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      runtime.time.clearTimeout(transferTimeout);
    }
  }

  async function recertifyObligations(attemptId: string, deadlineAt: number): Promise<void> {
    let timeout: TimerHandle | null = null;
    try {
      const recertified = await Promise.race([
        ports.reconciler().recertify(attemptId),
        new Promise<never>((_resolve, reject) => {
          timeout = runtime.time.setTimeout(
            () =>
              reject(new TransientCommitFailure('Succession obligations were not re-certified before the deadline.')),
            Math.max(0, deadlineAt - runtime.time.now()),
          );
        }),
      ]);
      if (recertified.kind === 'prepared') return;
      const blockers =
        recertified.kind === 'deferred' && recertified.blockers !== undefined
          ? recertified.blockers.map(({ owner, reason }) => `${owner}: ${reason}`).join('; ')
          : recertified.kind;
      throw new TransientCommitFailure(
        `Succession obligations changed after preparation: ${blockers}`,
        TRANSIENT_RETRY_BASE_MS,
        recertified.kind === 'deferred',
      );
    } finally {
      runtime.time.clearTimeout(timeout);
    }
  }

  /** An attempt commits only against the intent it was launched for. */
  function planCommit(attempt: SuccessionAttempt, preparation: SuccessionPreparation, recovering: boolean): CommitPlan {
    const intentAtStart = readUpgradeIntent(runDir);
    if (intentAtStart.kind !== 'readable' || intentAtStart.intent.attemptId !== attempt.attemptId) {
      throw new Error('Succession intent changed before commit.');
    }
    const successorFingerprint = intentAtStart.intent.target.build.storeFormatFingerprint;
    return {
      successorFingerprint,
      formatChanging: !recovering && successorFingerprint !== ports.incumbent.storeFormatFingerprint,
    };
  }

  async function awaitAttemptReadiness(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    recovering: boolean,
  ): Promise<void> {
    const ready = await waitForAttemptReady(runtime, attempt);
    if (
      ready.epochKey !== preparation.epochKey ||
      JSON.stringify([...ready.receiptIds].sort()) !==
        JSON.stringify(preparation.receipts.map((receipt) => receipt.receiptId).sort())
    ) {
      throw new Error('Successor readiness does not match the prepared epoch and receipts.');
    }
    if (!recovering) {
      const reported = await ports.reconciler().reportReady({
        attemptId: preparation.attemptId,
        successorPid: attempt.childIdentity.pid,
        targetKey: preparation.targetKey,
        epochKey: preparation.epochKey,
        admissionRevision: preparation.admissionRevision,
        receiptIds: [...ready.receiptIds],
      });
      if (reported.kind === 'stale' && reported.cause === 'obligation-change') {
        throw new TransientCommitFailure(
          'Succession preparation was outdated by an admission or epoch change.',
          TRANSIENT_RETRY_BASE_MS,
          true,
        );
      }
      if (reported.kind !== 'ready') throw new Error(`Succession readiness was ${reported.kind}.`);
    }
    await awaitListenerTransfer(attempt);
  }

  return { retirementServes, recertifyObligations, planCommit, awaitAttemptReadiness };
}
