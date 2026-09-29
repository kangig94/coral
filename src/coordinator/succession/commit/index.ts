import { formatError } from '../../../infra/error-format.js';
import type { StrictBundleManifest } from '../../../infra/bundle-manifest.js';
import type { TimerHandle } from '../../../infra/port-types.js';
import type { AttemptRetry, UpgradeIntent } from '../../../infra/upgrade-intent.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { Database } from '../../../store/db.js';
import {
  acquireProviderOperationMutationAdmission,
  type ProviderOperationMutationAdmission,
} from '../../../store/provider-operation-journal.js';
import {
  handbackSuccessionWriterGeneration,
  SuccessionServingCommittedError,
  type SuccessionWriterEntitlement,
  type SuccessionWriterGeneration,
} from '../../../store/succession-writer-generation.js';
import type { IpcListener } from '../../../transport/ipc/server.js';
import type { ChildPrincipalRegistry } from '../../child-principal-registry.js';
import type { KbDaemonSupervisor } from '../../live/kb-daemon-supervisor/index.js';
import type { LaunchCoordinator } from '../../live/admission.js';
import type { RetiringCustodyCertificate } from '../../services/recovery/epoch-closure.js';
import type { SuccessionRelease } from '../../shutdown.js';
import type { SuccessionAttempt } from '../attempt-child.js';
import type { SuccessionInterposition } from '../interposition.js';
import type { SuccessionPreparation } from '../protocol.js';
import type { SuccessionLaunch, SuccessionLaunchSettlement, SuccessionReconciler } from '../reconciler/index.js';
import { createCommitAttemptRecorder } from './attempt-recording.js';
import { createCommitAttemptReaper } from './attempt-reaping.js';
import { createCommitPause } from './pause.js';
import { createCommitReadiness } from './readiness.js';
import { createCommitWriterPreparation } from './writer-preparation.js';
import { createCommitWindowAdmission } from './window-admission.js';
import { createCommitServing } from './serving.js';
import { createFailedCommitWindow } from './failed-window.js';
import { createCommitRunner } from './runner.js';
import { createCommitReclaim } from './reclaim.js';
import { createSameBuildRecovery } from './same-build-recovery.js';
import { createCommitRecoverySettlement } from './recovery-settlement.js';
import { createCommitSupervisor } from './supervision.js';
import { createCommitLaunch } from './launch.js';
import { createCommitAuthority } from './authority.js';
import { createCommitFailurePolicy } from './failure-policy.js';

export type IncumbentWriterReclaim =
  | Readonly<{
      kind: 'reclaimed';
      generation: SuccessionWriterGeneration;
      providerOperationAdmission: ProviderOperationMutationAdmission;
    }>
  | Readonly<{ kind: 'same-build-succession'; reason: string }>;

export async function reclaimIncumbentWriter(
  options: Readonly<{
    runtime: Runtime;
    writer: SuccessionWriterEntitlement;
    failedGeneration?: SuccessionWriterGeneration;
    storeDb: Database;
    reopenStore?: () => void;
    incumbentInstanceId: string;
    deadlineMs: number;
    reclaimKbDaemonWriter: (generation: SuccessionWriterGeneration, signal: AbortSignal) => Promise<void>;
    reportReclaimFailure: (reason: string) => void;
  }>,
): Promise<IncumbentWriterReclaim> {
  if (options.deadlineMs <= 0) {
    const reason = 'Incumbent writer reclaim deadline expired.';
    options.reportReclaimFailure(reason);
    return { kind: 'same-build-succession', reason };
  }
  const controller = new AbortController();
  const expiresAt = options.runtime.time.monotonicNow() + BigInt(Math.max(0, Math.ceil(options.deadlineMs)));
  let timer: TimerHandle | null = null;
  const admissionState: { current: ProviderOperationMutationAdmission | null } = { current: null };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = options.runtime.time.setTimeout(
      () => reject(new Error('Incumbent writer reclaim deadline expired.')),
      options.deadlineMs,
    );
  });
  try {
    const reclaim = async (): Promise<IncumbentWriterReclaim> => {
      if (options.failedGeneration !== undefined) {
        handbackSuccessionWriterGeneration(options.runtime, options.failedGeneration, {
          storeRoot: options.writer.generation.storeRoot,
          epoch: options.writer.generation.epoch,
        });
      }
      options.writer.unpark();
      options.reopenStore?.();
      if (options.runtime.time.monotonicNow() >= expiresAt) {
        throw new Error('Incumbent writer reclaim deadline expired.');
      }
      const acquired = acquireProviderOperationMutationAdmission(options.storeDb, options.incumbentInstanceId);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Provider operation journal reclaim is holding: ${acquired.exit}.`);
      }
      admissionState.current = acquired.admission;
      await options.reclaimKbDaemonWriter(options.writer.generation, controller.signal);
      controller.signal.throwIfAborted();
      if (options.runtime.time.monotonicNow() >= expiresAt) {
        throw new Error('Incumbent writer reclaim deadline expired.');
      }
      return {
        kind: 'reclaimed',
        generation: options.writer.generation,
        providerOperationAdmission: acquired.admission,
      };
    };
    return await Promise.race([reclaim(), timeout]);
  } catch (error: unknown) {
    if (error instanceof SuccessionServingCommittedError) throw error;
    controller.abort();
    if (admissionState.current !== null) void admissionState.current.close();
    try {
      options.writer.park();
    } catch {
      // The generation fence still refuses writes if the local close failed.
    }
    const reason = formatError(error);
    options.reportReclaimFailure(reason);
    return { kind: 'same-build-succession', reason };
  } finally {
    options.runtime.time.clearTimeout(timer);
  }
}

export type RetiringStoreProtection =
  | Readonly<{ kind: 'protected' }>
  | Readonly<{ kind: 'opener-held'; reason: string }>;

/** The incumbent's own writers, which a commit parks and every failed commit must either reclaim or release. */
export type IncumbentWriterPorts = Readonly<{
  parkProviderOperationMutations(signal: AbortSignal): Promise<void>;
  adoptProviderOperationAdmission(admission: ProviderOperationMutationAdmission): void;
  protectRetiringStore(epochKey: string, openerDrainMs: number): RetiringStoreProtection;
  reopenRetiringStore(epochKey: string): void;
  /** Never returns: the process exits once the release settles. */
  releaseAuthority(release: SuccessionRelease): Promise<never>;
}>;

export type SuccessionCommitPorts = Readonly<{
  runtime: Runtime;
  log: (message: string) => void;
  listener: () => IpcListener;
  /** Every write of the incumbent identity to the intent must use `reconciler().incumbent()`. */
  incumbent: Readonly<{
    instanceId: string;
    pluginRoot: string;
    storeFormatFingerprint: string;
    /** Absent when this build cannot prove its own identity, which forbids relaunching itself. */
    build: Readonly<{ manifest: StrictBundleManifest; bundleDir: string }> | null;
  }>;
  reconciler: () => SuccessionReconciler;
  writers: () => IncumbentWriterPorts | null;
  kbDaemon: Pick<KbDaemonSupervisor, 'parkWriterTurn' | 'reclaimWriterTurn' | 'stop'>;
  launchCoordinator: Pick<
    LaunchCoordinator,
    'admissionRevision' | 'beginSuccessionCommitWindow' | 'beginSuccessionWriterPark' | 'endSuccessionCommitWindow'
  >;
  childPrincipals: Pick<ChildPrincipalRegistry, 'fenceAuthentication' | 'reclaimAuthentication'>;
  /**
   * Provider hosts that authorized the successor. Control is released only once the incumbent's writers are
   * parked, and taken back through each host's recovery grant when the attempt fails before it serves.
   */
  providerHosts: Readonly<{
    transfersHosts(preparation: SuccessionPreparation): boolean;
    /** Parked writers wait on it, so it must end by `signal`, which fires at the commit deadline. */
    releaseForTransfer(attemptId: string, signal: AbortSignal): Promise<void>;
    reclaimTransferred(): void;
  }>;
  setLaunchFenceActive: (active: boolean) => void;
  /** Open job waits resubscribe to whichever coordinator serves once their handover signal fires. */
  waitHandover: Readonly<{ abort(): void; renew(): void }>;
  liveJobIds: () => readonly string[];
  retiringEpoch: RetiringEpochPorts;
  storeDb: () => Database;
  startAttempt: (
    input: Readonly<{ intent: UpgradeIntent; preparation: SuccessionPreparation; recoveryBundleDir?: string }>,
  ) => Promise<SuccessionAttempt>;
  interposition: SuccessionInterposition;
}>;

/** The historical record a format-changing retirement must certify before the incumbent's epoch is retired. */
export type RetiringEpochPorts = Readonly<{
  certificate(epochKey: string): Readonly<{ revision: number; jobIds: readonly string[] }> | null;
  resultsReleased(epochKey: string): boolean;
  recoverLocations(epochKey: string): void;
  /** May wait out a recorded process's disappearance, so it runs before the commit window opens. */
  certifyCustody(epochKey: string, signal: AbortSignal): Promise<RetiringCustodyCertificate | null>;
  /** Never waits on a process, so it fits inside the commit window. */
  confirmCustody(certificate: RetiringCustodyCertificate, signal: AbortSignal): Promise<boolean>;
}>;

export type SuccessionShutdownPort = Readonly<{
  /** True once the active attempt's successor durably serves; shutdown then releases instead of tearing down. */
  committed(): boolean;
  handOverOpenConnections(): Promise<void>;
  /** Aborts an uncommitted attempt and resolves once the commit has reclaimed, released, or restarted. */
  settleUncommittedAttempt(): Promise<void>;
}>;

export type SuccessionCommitter = Readonly<{
  launchPrepared(intent: UpgradeIntent, preparation: SuccessionPreparation): Promise<SuccessionLaunch>;
  retirementServes(attemptId: string, incumbentEpochKey: string): boolean;
  publishServing(attemptId: string, recovery: boolean): Promise<void>;
  shutdown: SuccessionShutdownPort;
}>;

/** An attempt that ended without a serving successor; its writer, when present, is parked and owed a reclaim. */
export type FailedCommit = Readonly<{
  kind: 'failed';
  attempt: SuccessionAttempt | null;
  preparation: SuccessionPreparation;
  reason: string;
  retry: AttemptRetry;
  writer: SuccessionWriterEntitlement | null;
  retirementStoreParked: boolean;
  transfersChildPrincipals: boolean;
  pauseDeadlineAtMs: number;
  childHold: string | null;
  /** Recorded only by the write that clears the attempt, so the attempt never clears without it. */
  unservedMintDiscard: NonNullable<UpgradeIntent['unservedMintDiscard']> | null;
}>;

export type CommitOutcome =
  | Readonly<{ kind: 'serving'; attempt: SuccessionAttempt }>
  | Readonly<{ kind: 'unresolved'; attempt: SuccessionAttempt; reason: string }>
  | FailedCommit;

/** What the intent the attempt was launched for fixes about its commit. */
export type CommitPlan = Readonly<{
  successorFingerprint: string;
  formatChanging: boolean;
  transfersChildPrincipals: boolean;
}>;

/** An open commit window, and the parked state a failure inside it leaves for reclaim. */
export type CommitWindow = {
  readonly attempt: SuccessionAttempt;
  readonly preparation: SuccessionPreparation;
  readonly recovering: boolean;
  readonly pauseDeadlineAtMs: number;
  readonly deadlineAt: number;
  readonly stopForwarding: () => void;
  writer: SuccessionWriterEntitlement | null;
  retirementStoreParked: boolean;
  hold: string | null;
};

export type RecoveryContext = Readonly<{
  writer: SuccessionWriterEntitlement;
  retirementStoreParked: boolean;
  transfersChildPrincipals: boolean;
}>;

export type CommitState = {
  active: SuccessionAttempt | null;
  supervision: Promise<SuccessionLaunchSettlement> | null;
  /** Aborted by shutdown; every wait of the active attempt that could outlast shutdown's patience observes it. */
  attemptAbort: AbortController;
  pausedAttemptId: string | null;
  stopWindowForwarding: (() => void) | null;
};

export function createSuccessionCommitter(ports: SuccessionCommitPorts): SuccessionCommitter {
  const { runtime } = ports;
  const state: CommitState = {
    active: null,
    supervision: null,
    attemptAbort: new AbortController(),
    pausedAttemptId: null,
    stopWindowForwarding: null,
  };

  const { updateAttempt, clearAttempt, recordReleasePending } = createCommitAttemptRecorder(ports);

  const { incumbentOwner, writersOrThrow, handOverOpenConnections, releaseToSuccessor } = createCommitAuthority(ports);
  const { retryAfterFailure, childHoldBlockers } = createCommitFailurePolicy(state);

  const { openPause, closePause } = createCommitPause(ports, state);

  const { abortAndReap } = createCommitAttemptReaper(runtime);

  const { retirementServes, recertifyObligations, planCommit, awaitAttemptReadiness } = createCommitReadiness(ports);

  const { parkIncumbentWriters, authorizeRetirement, certifyRetiringCustody } = createCommitWriterPreparation(
    ports,
    state,
  );

  const { openCommitWindow, parkAndAuthorize } = createCommitWindowAdmission(ports, state, {
    openPause,
    closePause,
    updateAttempt,
    writersOrThrow,
    parkIncumbentWriters,
    recertifyObligations,
    authorizeRetirement,
  });

  const { awaitServing, retryAfterWindowFailure, successorServesBeforeRefusal } = createCommitServing(ports, state, {
    retirementServes,
    retryAfterFailure,
  });

  const { closeFailedWindow } = createFailedCommitWindow(ports, state, {
    successorServesBeforeRefusal,
    recordReleasePending,
    abortAndReap,
  });

  const { runCommit } = createCommitRunner(ports, {
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
  });

  const { reclaimInPlace, wakeForRetry, unservedMintOf } = createCommitReclaim(ports, {
    closePause,
    clearAttempt,
    writersOrThrow,
    childHoldBlockers,
    reclaimIncumbentWriter,
  });

  const { recordRecoveryAttempt, runSameBuildRecovery } = createSameBuildRecovery(ports, state, {
    updateAttempt,
    unservedMintOf,
    incumbentOwner,
    childHoldBlockers,
    abortAndReap,
    runCommit,
  });

  const { settleFailedCommit, releaseUnresolved } = createCommitRecoverySettlement(ports, state, {
    reclaimInPlace,
    recordRecoveryAttempt,
    runSameBuildRecovery,
    recordReleasePending,
    writersOrThrow,
    releaseToSuccessor,
  });

  const { superviseCommit } = createCommitSupervisor(ports, state, {
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
  });

  const { launchPrepared, publishServing, shutdown } = createCommitLaunch(ports, state, {
    updateAttempt,
    abortAndReap,
    superviseCommit,
    releaseToSuccessor,
    recordReleasePending,
    writersOrThrow,
    handOverOpenConnections,
  });

  return { launchPrepared, retirementServes, publishServing, shutdown };
}
