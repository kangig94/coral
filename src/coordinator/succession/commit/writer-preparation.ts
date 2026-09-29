import { formatError } from '../../../infra/error-format.js';
import type { RetiringCustodyCertificate } from '../../services/recovery/epoch-closure.js';
import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { CommitState, IncumbentWriterPorts, RetiringStoreProtection, SuccessionCommitPorts } from '../commit.js';
import type { SuccessionPreparation } from '../protocol.js';
import { recordRetirementDisposition } from '../retirement-disposition.js';
import { TransientCommitFailure } from './failure.js';

/**
 * Sized for one local read: an opener outside the incumbent may never hold the epoch across a coordinator round trip.
 */
const RETIRING_OPENER_DRAIN_MS = 500;

export function createCommitWriterPreparation(ports: SuccessionCommitPorts, state: CommitState) {
  const { runtime } = ports;
  async function parkIncumbentWriters(writers: IncumbentWriterPorts, deadlineAt: number): Promise<void> {
    const parkAbort = new AbortController();
    const parkDeadline = runtime.time.setTimeout(
      () => parkAbort.abort(new Error('Writer park exceeded the commit deadline.')),
      Math.max(0, deadlineAt - runtime.time.now()),
    );
    try {
      await writers.parkProviderOperationMutations(parkAbort.signal);
      if (ports.kbDaemon.parkWriterTurn === undefined) {
        throw new Error('Incumbent writer park capabilities are unavailable.');
      }
      try {
        await ports.kbDaemon.parkWriterTurn(parkAbort.signal);
      } catch (error: unknown) {
        // A writer that cannot park yet decides nothing about the target.
        throw new TransientCommitFailure(
          `KB daemon writer turn did not park: ${formatError(error)}`,
          TRANSIENT_RETRY_BASE_MS,
          true,
        );
      }
      parkAbort.signal.throwIfAborted();
    } finally {
      runtime.time.clearTimeout(parkDeadline);
    }
  }

  async function authorizeRetirement(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    custody: RetiringCustodyCertificate,
    successorFingerprint: string,
    deadlineAt: number,
    protect: (openerDrainMs: number) => RetiringStoreProtection,
  ): Promise<void> {
    const certificate = ports.retiringEpoch.certificate(preparation.epochKey);
    if (certificate === null || !ports.retiringEpoch.resultsReleased(preparation.epochKey)) {
      throw new Error('Historical job inventory and result retention are not certified.');
    }
    const custodyHolds = await ports.retiringEpoch.confirmCustody(
      custody,
      AbortSignal.timeout(Math.max(1, deadlineAt - runtime.time.now())),
    );
    if (!custodyHolds) throw new TransientCommitFailure('Retiring epoch custody changed after its certification.');
    if (runtime.time.now() >= deadlineAt) throw new Error('Retirement certification exceeded the commit deadline.');
    await ports.interposition.at('retirement-protection', { recovery: false });
    const protection = protect(Math.max(0, Math.min(RETIRING_OPENER_DRAIN_MS, deadlineAt - runtime.time.now())));
    if (protection.kind === 'opener-held') throw new TransientCommitFailure(protection.reason);
    await ports.interposition.at('retirement-authorization', { recovery: false });
    recordRetirementDisposition(runtime, {
      version: 'v1',
      attemptId: attempt.attemptId,
      incumbentEpochKey: preparation.epochKey,
      incumbentFingerprint: ports.incumbent.storeFormatFingerprint,
      successorFingerprint,
      certificateRevision: certificate.revision,
      certificateJobIds: [...certificate.jobIds],
      custodySettled: true,
    });
  }

  /**
   * A process discharge can outlast the whole admission pause, so custody is certified before the pause opens and
   * the window only confirms that certificate. Shutdown's abort ends the wait without deciding the target.
   */
  async function certifyRetiringCustody(epochKey: string): Promise<RetiringCustodyCertificate> {
    let custody: RetiringCustodyCertificate | null = null;
    try {
      custody = await ports.retiringEpoch.certifyCustody(epochKey, state.attemptAbort.signal);
    } catch (error: unknown) {
      if (!state.attemptAbort.signal.aborted) throw error;
    }
    if (state.attemptAbort.signal.aborted) {
      throw new TransientCommitFailure('Incumbent shutdown aborted retiring custody certification.');
    }
    if (custody === null) throw new TransientCommitFailure('Retiring epoch custody has not settled.');
    return custody;
  }

  return { parkIncumbentWriters, authorizeRetirement, certifyRetiringCustody };
}
