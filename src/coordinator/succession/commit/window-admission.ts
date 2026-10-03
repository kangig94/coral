import { formatError } from '../../../infra/error-format.js';
import { encodeResolvedStoreEpoch, inspectCurrentStore } from '../../../store/epoch/index.js';
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

  async function openCommitWindow(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    recovery: RecoveryContext | null,
  ): Promise<CommitWindow> {
    const pause = openPause(attempt.attemptId, preparation.admissionRevision);
    const deadlineAt = pause.deadlineAtMs - RECLAIM_RESERVE_MS;
    const deadlineMonotonicMs = pause.deadlineMonotonicMs - RECLAIM_RESERVE_MS;
    try {
      await attempt.setDeadline(deadlineAt, Math.max(0, deadlineMonotonicMs - Number(runtime.time.monotonicNow())));
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
      pauseDeadlineMonotonicMs: pause.deadlineMonotonicMs,
      deadlineMonotonicMs,
      deadlineAt,
      stopForwarding,
      writer: recovery?.writer ?? null,
      retirementStoreParked: recovery?.retirementStoreParked ?? false,
      hold: null,
    };
  }

  async function parkAndAuthorize(
    window: CommitWindow,
    plan: CommitPlan,
    custody: RetiringCustodyCertificate | null,
  ): Promise<SuccessionWriterEntitlement> {
    const { attempt, preparation, deadlineAt, deadlineMonotonicMs, recovering } = window;
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
      await parkIncumbentWriters(writers, deadlineMonotonicMs);
      await recertifyObligations(attempt.attemptId, deadlineMonotonicMs);
      state.attemptAbort.signal.throwIfAborted();
      if (Number(runtime.time.monotonicNow()) >= deadlineMonotonicMs)
        throw new Error('Writer park exceeded the commit deadline.');
      writer.park();
    }
    if (!recovering && ports.providerHosts.transfersHosts(preparation)) {
      try {
        await ports.providerHosts.releaseForTransfer(
          attempt.attemptId,
          AbortSignal.any([
            state.attemptAbort.signal,
            AbortSignal.timeout(Math.max(1, deadlineMonotonicMs - Number(runtime.time.monotonicNow()))),
          ]),
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
        deadlineMonotonicMs,
        (openerDrainMs) => {
          window.retirementStoreParked = true;
          return writers.protectRetiringStore(preparation.epochKey, openerDrainMs);
        },
      );
    }
    state.attemptAbort.signal.throwIfAborted();
    if (Number(runtime.time.monotonicNow()) >= deadlineMonotonicMs)
      throw new Error('Successor missed its commit deadline.');
    await attempt.allowCommittedOpen();
    return writer;
  }

  return { openCommitWindow, parkAndAuthorize };
}
