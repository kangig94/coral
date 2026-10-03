import type { AttemptRetry, UpgradeIntent } from '../../../infra/upgrade-intent.js';
import {
  observeSuccessionWriterGeneration,
  type SuccessionWriterGeneration,
} from '../../../store/succession-writer-generation.js';
import { failedAttemptRetry } from '../attempt-retry.js';
import type { FailedCommit, IncumbentWriterPorts, SuccessionCommitPorts, reclaimIncumbentWriter } from './index.js';
import { recordControllerOpen } from '../controller-open.js';
import type { SuccessionLaunchSettlement } from '../reconciler/index.js';
import type { createCommitAttemptRecorder } from './attempt-recording.js';
import type { createCommitPause } from './pause.js';

const KB_WRITER_RECLAIM_ACK_MS = 500;

async function reclaimKbDaemonWriter(
  ports: SuccessionCommitPorts,
  generation: SuccessionWriterGeneration,
  signal: AbortSignal,
  recovering: boolean,
): Promise<void> {
  await ports.interposition.at('incumbent-reclaim', { recovery: recovering });
  const reclaim = ports.kbDaemon.reclaimWriterTurn?.(generation, signal);
  if (reclaim === undefined) throw new Error('KB daemon writer reclaim capability is unavailable.');
  let acknowledged: boolean;
  try {
    acknowledged = await Promise.race([
      reclaim.then(() => true),
      ports.runtime.time.sleep(KB_WRITER_RECLAIM_ACK_MS).then(() => false as const),
    ]);
  } catch {
    acknowledged = false;
  }
  if (acknowledged) return;
  const stopped = await ports.kbDaemon.stop('succession writer reclaim', { signal });
  if (stopped.pid !== null) throw new Error('KB daemon writer remained alive after bounded stop.');
}

type ReclaimDependencies = Pick<ReturnType<typeof createCommitAttemptRecorder>, 'clearAttempt'> &
  Pick<ReturnType<typeof createCommitPause>, 'closePause'> &
  Readonly<{
    writersOrThrow: () => IncumbentWriterPorts;
    childHoldBlockers: (childHold: string | null) => { owner: string; reason: string }[];
    reclaimIncumbentWriter: typeof reclaimIncumbentWriter;
  }>;

export function createCommitReclaim(ports: SuccessionCommitPorts, dependencies: ReclaimDependencies) {
  const { runtime } = ports;
  const { closePause, clearAttempt, writersOrThrow, childHoldBlockers, reclaimIncumbentWriter } = dependencies;

  function wakeForRetry(retry: AttemptRetry): void {
    if (retry.kind === 'transient') ports.reconciler().notifyObligationChange();
  }

  const unservedMintOf = (failure: FailedCommit): Partial<UpgradeIntent> =>
    failure.unservedMintDiscard === null ? {} : { unservedMintDiscard: failure.unservedMintDiscard };

  async function reclaimInPlace(
    failure: FailedCommit,
    recovering: boolean,
  ): Promise<SuccessionLaunchSettlement | null> {
    const attemptId = failure.attempt?.attemptId ?? failure.preparation.attemptId;
    if (failure.writer === null) {
      closePause();
      const settlement = await clearAttempt(attemptId, (intent) => ({
        ...intent,
        ...unservedMintOf(failure),
        disposition: 'deferred',
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        successionPreparation: null,
        blockers: [
          { owner: 'succession-commit', reason: `incumbent retained authority after ${failure.reason}` },
          ...childHoldBlockers(failure.childHold),
        ],
        ...failedAttemptRetry(intent, failure.retry, 'successor commit preparation failure', runtime.time.now()),
      }));
      wakeForRetry(failure.retry);
      return settlement;
    }
    const writers = writersOrThrow();
    const writer = failure.writer;
    const pauseRemainingMs = failure.pauseDeadlineMonotonicMs - Number(runtime.time.monotonicNow());
    const observed = observeSuccessionWriterGeneration(runtime);
    const failedGeneration =
      observed !== null && observed.generation > writer.generation.generation ? observed : undefined;
    const reclaimed = await reclaimIncumbentWriter({
      runtime,
      writer,
      ...(failedGeneration === undefined ? {} : { failedGeneration }),
      storeDb: ports.storeDb(),
      ...(failure.retirementStoreParked
        ? { reopenStore: () => writers.reopenRetiringStore(failure.preparation.epochKey) }
        : {}),
      incumbentInstanceId: ports.incumbent.instanceId,
      deadlineMs: Math.max(0, pauseRemainingMs),
      reclaimKbDaemonWriter: (generation, signal) => reclaimKbDaemonWriter(ports, generation, signal, recovering),
      reportReclaimFailure: (reason) => ports.log(`Same-build writer recovery required: ${reason}\n`),
    });
    if (reclaimed.kind !== 'reclaimed') return null;
    if (ports.incumbent.build !== null) {
      recordControllerOpen(
        runtime,
        failure.preparation.epochKey,
        ports.incumbent.instanceId,
        null,
        ports.incumbent.pluginRoot,
        ports.incumbent.build.manifest,
        reclaimed.generation.generation,
      );
    }
    writers.adoptProviderOperationAdmission(reclaimed.providerOperationAdmission);
    ports.providerHosts.reclaimTransferred();
    ports.setLaunchFenceActive(false);
    closePause();
    const settlement = await clearAttempt(attemptId, (intent) => ({
      ...intent,
      ...unservedMintOf(failure),
      disposition: 'deferred',
      attemptId: null,
      attemptChild: null,
      attemptOwner: null,
      attemptDeadline: null,
      recoveryAttemptId: null,
      recoveryBuildSetId: null,
      recoveryGrantAttemptId: null,
      recoveryRetry: null,
      successionPreparation: null,
      blockers: [
        { owner: 'succession-commit', reason: `incumbent reclaimed after ${failure.reason}` },
        ...childHoldBlockers(failure.childHold),
      ],
      ...failedAttemptRetry(intent, failure.retry, 'successor committed-open failure', runtime.time.now()),
    }));
    wakeForRetry(failure.retry);
    ports.log(`Succession attempt held and incumbent writer reclaimed: ${failure.reason}\n`);
    return settlement;
  }

  return { reclaimInPlace, wakeForRetry, unservedMintOf };
}
