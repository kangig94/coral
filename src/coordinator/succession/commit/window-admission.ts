import { formatError } from '../../../infra/error-format.js';
import { encodeResolvedStoreEpoch, inspectCurrentStore } from '../../../store/epoch.js';
import {
  joinSuccessionWriterGeneration,
  type SuccessionWriterEntitlement,
} from '../../../store/succession-writer-generation.js';
import type { RetiringCustodyCertificate } from '../../services/recovery/epoch-closure.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type {
  CommitPlan,
  CommitState,
  CommitWindow,
  IncumbentWriterPorts,
  RecoveryContext,
  SuccessionCommitPorts,
} from './index.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitPause } from './pause.js';
import type { createCommitReadiness } from './readiness.js';
import type { createCommitWriterPreparation } from './writer-preparation.js';
import { TransientCommitFailure } from './failure.js';

/** Reserved inside the admission pause so a failed attempt still leaves the incumbent time to reclaim. */
const RECLAIM_RESERVE_MS = 2_500;

type WindowAdmissionDependencies = Pick<ReturnType<typeof createCommitPause>, 'openPause' | 'closePause'> &
  Pick<ReturnType<typeof createCommitAttemptRecorder>, 'updateAttempt'> &
  Pick<ReturnType<typeof createCommitReadiness>, 'recertifyObligations'> &
  Pick<ReturnType<typeof createCommitWriterPreparation>, 'parkIncumbentWriters' | 'authorizeRetirement'> &
  Readonly<{ writersOrThrow: () => IncumbentWriterPorts }>;

export function createCommitWindowAdmission(
  ports: SuccessionCommitPorts,
  state: CommitState,
  dependencies: WindowAdmissionDependencies,
) {
  const { runtime } = ports;
  const {
    openPause,
    closePause,
    updateAttempt,
    writersOrThrow,
    parkIncumbentWriters,
    recertifyObligations,
    authorizeRetirement,
  } = dependencies;
  /**
   * The successor parks connections only once it holds this window's deadline, which ends its parking; before
   * then it returns every connection it accepts, so this incumbent keeps answering while custody certifies.
   */
  async function openCommitWindow(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    recovery: RecoveryContext | null,
  ): Promise<CommitWindow> {
    const pauseDeadlineAtMs = openPause(attempt.attemptId, preparation.admissionRevision);
    const deadlineAt = pauseDeadlineAtMs - RECLAIM_RESERVE_MS;
    try {
      await attempt.setDeadline(deadlineAt);
    } catch (error: unknown) {
      closePause();
      throw error;
    }
    let stopForwarding: () => void;
    try {
      stopForwarding = attempt.forwardConnections(ports.listener());
    } catch (error: unknown) {
      closePause();
      throw error;
    }
    state.stopWindowForwarding = stopForwarding;
    // Only after forwarding starts: a wait that resubscribes must reach the successor, never this incumbent,
    // whose store reads fail once its writers park.
    ports.waitHandover.abort();
    return {
      attempt,
      preparation,
      recovering: recovery !== null,
      pauseDeadlineAtMs,
      deadlineAt,
      stopForwarding,
      writer: recovery?.writer ?? null,
      retirementStoreParked: recovery?.retirementStoreParked ?? false,
      hold: null,
    };
  }

  /** Parks this incumbent's writers and lets the successor open; the window records what a failure must reclaim. */
  async function parkAndAuthorize(
    window: CommitWindow,
    plan: CommitPlan,
    custody: RetiringCustodyCertificate | null,
  ): Promise<SuccessionWriterEntitlement> {
    const { attempt, preparation, deadlineAt, recovering } = window;
    await updateAttempt(attempt.attemptId, (intent) => ({
      ...intent,
      disposition: 'attempting',
      attemptDeadline: new Date(deadlineAt).toISOString(),
    }));
    const inspected = inspectCurrentStore(runtime);
    if (inspected.kind !== 'current' || encodeResolvedStoreEpoch(runtime, inspected.epoch) !== preparation.epochKey) {
      throw new TransientCommitFailure('Incumbent store epoch changed before writer park.');
    }
    const writer = joinSuccessionWriterGeneration(runtime, inspected.epoch);
    window.writer = writer;
    const writers = writersOrThrow();
    if (plan.formatChanging) {
      if (preparation.receipts.length > 0 || ports.liveJobIds().length > 0) {
        throw new Error('Format-changing retirement still has live obligations.');
      }
      ports.retiringEpoch.recoverLocations(preparation.epochKey);
    }
    if (!recovering) {
      ports.launchCoordinator.beginSuccessionWriterPark(attempt.attemptId);
      await parkIncumbentWriters(writers, deadlineAt);
      await recertifyObligations(attempt.attemptId, deadlineAt);
      writer.park();
    }
    if (!recovering && ports.providerHosts.transfersHosts(preparation)) {
      try {
        await ports.providerHosts.releaseForTransfer(
          attempt.attemptId,
          AbortSignal.timeout(Math.max(1, deadlineAt - runtime.time.now())),
        );
      } catch (error: unknown) {
        // A host that cannot be handed over now decides nothing about the target.
        throw new TransientCommitFailure(`Provider hosts were not released for the successor: ${formatError(error)}`);
      }
    }
    if (custody !== null) {
      await authorizeRetirement(
        attempt,
        preparation,
        custody,
        plan.successorFingerprint,
        deadlineAt,
        (openerDrainMs) => {
          window.retirementStoreParked = true;
          return writers.protectRetiringStore(preparation.epochKey, openerDrainMs);
        },
      );
    }
    await attempt.allowCommittedOpen();
    return writer;
  }

  return { openCommitWindow, parkAndAuthorize };
}
