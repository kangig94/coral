import { formatError } from '../../infra/error-format.js';
import type { StrictBundleManifest } from '../../infra/bundle-manifest.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../../infra/node-process.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { gracefulKillByPid } from '../../infra/process-supervision.js';
import { readUpgradeIntent, retryUpgradeIntentCas, type UpgradeIntent } from '../../infra/upgrade-intent.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import {
  decodeResolvedStoreEpoch,
  discardUnservedRetirementMint,
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
} from '../../store/epoch.js';
import {
  acquireProviderOperationMutationAdmission,
  type ProviderOperationMutationAdmission,
} from '../../store/provider-operation-journal.js';
import {
  handbackSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  observeSuccessionServing,
  observeSuccessionWriterGeneration,
  SuccessionServingCommittedError,
  type SuccessionWriterEntitlement,
  type SuccessionWriterGeneration,
} from '../../store/succession-writer-generation.js';
import type { IpcListener } from '../../transport/ipc/server.js';
import type { ChildPrincipalRegistry } from '../child-principal-registry.js';
import type { KbDaemonSupervisor } from '../live/kb-daemon-supervisor.js';
import type { LaunchCoordinator } from '../live/admission.js';
import type { SuccessionRelease } from '../shutdown.js';
import type { AttemptAcknowledgment, SuccessionAttempt } from './attempt-child.js';
import { recordControllerOpen } from './controller-open.js';
import type { SuccessionInterposition } from './interposition.js';
import type { SuccessionPreparation } from './protocol.js';
import type { SuccessionReconciler } from './reconciler.js';
import { observeRetirementDisposition, recordRetirementDisposition } from './retirement-disposition.js';

const ATTEMPT_READY_TIMEOUT_MS = 10_000;
const LISTENER_TRANSFER_TIMEOUT_MS = 10_000;
const CONNECTION_HANDOVER_MS = 500;
const SERVING_POLL_MS = 25;
/** Reserved inside the admission pause so a failed attempt still leaves the incumbent time to reclaim. */
const RECLAIM_RESERVE_MS = 2_500;
const KB_WRITER_RECLAIM_ACK_MS = 500;
const SAME_BUILD_RECOVERY_ATTEMPTS = 2;
const SERVING_RECEIPT_ATTEMPTS = 20;
const SERVING_RECEIPT_RETRY_MS = 50;

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
    startSameBuildSuccession: (reason: string) => void;
  }>,
): Promise<IncumbentWriterReclaim> {
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
    options.startSameBuildSuccession(reason);
    return { kind: 'same-build-succession', reason };
  } finally {
    options.runtime.time.clearTimeout(timer);
  }
}

/** The incumbent's own writers, which a commit parks and every failed commit must either reclaim or release. */
export type IncumbentWriterPorts = Readonly<{
  parkProviderOperationMutations(signal: AbortSignal): Promise<void>;
  adoptProviderOperationAdmission(admission: ProviderOperationMutationAdmission): void;
  protectRetiringStore(epochKey: string): void;
  reopenRetiringStore(epochKey: string): void;
  /** Never returns: the process exits once the release settles. */
  releaseAuthority(release: SuccessionRelease): Promise<never>;
}>;

export type SuccessionCommitPorts = Readonly<{
  runtime: Runtime;
  log: (message: string) => void;
  listener: () => IpcListener;
  incumbent: Readonly<{
    instanceId: string;
    pid: number;
    version: string;
    bundleHash: string;
    flavor: UpgradeIntent['incumbent']['flavor'];
    pluginRoot: string;
    storeFormatFingerprint: string;
    incarnation: () => ProcessIncarnation | null;
    /** Absent when this build cannot prove its own identity, which forbids relaunching itself. */
    build: Readonly<{ manifest: StrictBundleManifest; bundleDir: string }> | null;
  }>;
  reconciler: () => SuccessionReconciler;
  writers: () => IncumbentWriterPorts | null;
  kbDaemon: Pick<KbDaemonSupervisor, 'parkWriterTurn' | 'reclaimWriterTurn' | 'stop'>;
  launchCoordinator: Pick<
    LaunchCoordinator,
    'admissionRevision' | 'beginSuccessionCommitWindow' | 'endSuccessionCommitWindow'
  >;
  childPrincipals: Pick<ChildPrincipalRegistry, 'fenceAuthentication' | 'reclaimAuthentication'>;
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
  certifyCustody(epochKey: string, signal: AbortSignal): Promise<boolean>;
}>;

/** What shutdown needs from an attempt that may still be committing. */
export type SuccessionShutdownPort = Readonly<{
  /** True once the active attempt's successor durably serves; shutdown then releases instead of tearing down. */
  committed(): boolean;
  handOverOpenConnections(): Promise<void>;
  /** Aborts an uncommitted attempt and resolves once the commit has reclaimed, released, or restarted. */
  settleUncommittedAttempt(): Promise<void>;
}>;

export type SuccessionCommitter = Readonly<{
  launchPrepared(intent: UpgradeIntent, preparation: SuccessionPreparation): Promise<void>;
  retirementServes(attemptId: string, incumbentEpochKey: string, servedEpochKey: string): boolean;
  publishServing(attemptId: string, recovery: boolean): Promise<void>;
  shutdown: SuccessionShutdownPort;
}>;

/** An attempt that ended without a serving successor; its writer, when present, is parked and owed a reclaim. */
type FailedCommit = Readonly<{
  kind: 'failed';
  attempt: SuccessionAttempt | null;
  preparation: SuccessionPreparation;
  reason: string;
  writer: SuccessionWriterEntitlement | null;
  retirementStoreParked: boolean;
  transfersChildPrincipals: boolean;
  pauseDeadlineAtMs: number;
  childHold: string | null;
}>;

type CommitOutcome = Readonly<{ kind: 'serving'; attempt: SuccessionAttempt }> | FailedCommit;

type RecoveryContext = Readonly<{
  writer: SuccessionWriterEntitlement;
  retirementStoreParked: boolean;
  transfersChildPrincipals: boolean;
}>;

export function createSuccessionCommitter(ports: SuccessionCommitPorts): SuccessionCommitter {
  const { runtime } = ports;
  const runDir = runtime.paths.coral.coordinator.runDir;
  let active: SuccessionAttempt | null = null;
  let supervision: Promise<void> | null = null;
  let abortRequested = false;
  let pausedAttemptId: string | null = null;

  const updateAttempt = async (attemptId: string, change: (intent: UpgradeIntent) => UpgradeIntent): Promise<void> => {
    const outcome = await retryUpgradeIntentCas(runDir, (observed) => {
      if (observed.kind !== 'readable' || observed.intent.attemptId !== attemptId) {
        throw new Error('Succession attempt changed while recording its commit window.');
      }
      return {
        kind: 'write',
        expectedRevision: observed.intent.revision,
        change: change(observed.intent),
        settle: () => undefined,
      };
    });
    if (outcome.kind === 'refused') throw new Error(`Succession intent could not be recorded: ${outcome.problem}`);
    if (outcome.kind === 'exhausted') throw new Error('Succession intent changed throughout its commit window.');
  };

  const recordBestEffort = async (
    attemptId: string,
    change: (intent: UpgradeIntent) => UpgradeIntent,
  ): Promise<void> => {
    try {
      await updateAttempt(attemptId, change);
    } catch (error: unknown) {
      ports.log(`Succession hold recording failed: ${formatError(error)}\n`);
    }
  };

  const writersOrThrow = (): IncumbentWriterPorts => {
    const writers = ports.writers();
    if (writers === null) throw new Error('Incumbent writer park capabilities are unavailable.');
    return writers;
  };

  async function handOverOpenConnections(attempt: SuccessionAttempt): Promise<void> {
    ports.waitHandover.abort();
    await Promise.race([
      attempt.drainIncumbentConnections(ports.listener()),
      runtime.time.sleep(CONNECTION_HANDOVER_MS),
    ]);
  }

  const releaseToSuccessor = (attempt: SuccessionAttempt): Promise<never> =>
    writersOrThrow().releaseAuthority({ kind: 'successor', handOver: () => handOverOpenConnections(attempt) });

  function openPause(attemptId: string, admissionRevision: number): number {
    if (pausedAttemptId !== null) ports.launchCoordinator.endSuccessionCommitWindow(pausedAttemptId);
    pausedAttemptId = null;
    const pause = ports.launchCoordinator.beginSuccessionCommitWindow(attemptId, admissionRevision);
    if (pause.kind !== 'paused') throw new Error(`Succession admission pause was ${pause.reason}.`);
    pausedAttemptId = attemptId;
    return pause.deadlineAtMs;
  }

  function closePause(): void {
    if (pausedAttemptId !== null) ports.launchCoordinator.endSuccessionCommitWindow(pausedAttemptId);
    pausedAttemptId = null;
  }

  const waitForAttemptReady = (
    attempt: SuccessionAttempt,
  ): Promise<Extract<AttemptAcknowledgment, { kind: 'ready' }>> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = (): void => {};
      const timeout = runtime.time.setTimeout(
        () => finish(new Error('Successor did not report read-only readiness.')),
        ATTEMPT_READY_TIMEOUT_MS,
      );
      const onExit = (): void => finish(new Error('Successor exited before readiness.'));
      attempt.child.once('exit', onExit);
      unsubscribe = attempt.onAcknowledgment((acknowledgment) => {
        if (acknowledgment.kind === 'hold') finish(new Error(acknowledgment.reason));
        if (acknowledgment.kind === 'ready') finish(null, acknowledgment);
      });
      if (settled) unsubscribe();
      function finish(error: Error | null, ready?: Extract<AttemptAcknowledgment, { kind: 'ready' }>): void {
        if (settled) return;
        settled = true;
        runtime.time.clearTimeout(timeout);
        unsubscribe();
        attempt.child.off('exit', onExit);
        if (error !== null) reject(error);
        else if (ready !== undefined) resolve(ready);
      }
    });

  async function reapAttempt(
    attempt: SuccessionAttempt,
    requireDurableIdentity: boolean,
  ): Promise<Readonly<{ kind: 'observed-absent' }>> {
    const recorded = readUpgradeIntent(runDir);
    const identityRecord = recorded.kind === 'readable' ? recorded.intent.attemptChild : null;
    if (
      requireDurableIdentity &&
      (identityRecord?.attemptId !== attempt.attemptId ||
        identityRecord.pid !== attempt.childIdentity.pid ||
        identityRecord.incarnation !== attempt.childIdentity.incarnation)
    ) {
      throw new Error('Failed successor identity does not match the durable attempt record.');
    }
    if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) return { kind: 'observed-absent' };
    const { pid, incarnation } = attempt.childIdentity;
    if (probeProcessIncarnation(pid) !== incarnation) {
      throw new Error('Failed successor identity cannot be verified for reaping.');
    }
    // The owned child's exit is decisive absence evidence; reaping must not wait for the escalation deadline.
    const exited = new Promise<Readonly<{ kind: 'observed-absent' }>>((resolve) => {
      if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) resolve({ kind: 'observed-absent' });
      else attempt.child.once('exit', () => resolve({ kind: 'observed-absent' }));
    });
    const termination = gracefulKillByPid(runtime, pid, incarnation);
    if (termination.kind !== 'escalation-scheduled') {
      throw new Error(`Failed successor reaping was ${termination.kind}.`);
    }
    const settled = await Promise.race([termination.settlement, exited]);
    if (settled.kind !== 'observed-absent') {
      throw new Error(`Failed successor reaping remained ${settled.kind}.`);
    }
    return settled;
  }

  /**
   * Unproven absence of a failed child holds the child, never the incumbent: the incumbent's later reclaim
   * advances the writer generation, which refuses every write the child could still attempt.
   */
  async function abortAndReap(attempt: SuccessionAttempt, requireDurableIdentity = true): Promise<string | null> {
    await attempt.abort().catch(() => {});
    try {
      void (await reapAttempt(attempt, requireDurableIdentity));
      return null;
    } catch (error: unknown) {
      return `failed successor ${attempt.childIdentity.pid} absence is unproven (${formatError(error)}); the writer generation fence refuses its writes`;
    }
  }

  const childHoldBlockers = (childHold: string | null): { owner: string; reason: string }[] =>
    childHold === null ? [] : [{ owner: 'succession-attempt-child', reason: childHold }];

  function retirementServes(attemptId: string, incumbentEpochKey: string, servedEpochKey: string): boolean {
    const recorded = observeRetirementDisposition(runtime, attemptId);
    const observed = readUpgradeIntent(runDir);
    const incumbent = decodeResolvedStoreEpoch(runtime, incumbentEpochKey);
    const successor = decodeResolvedStoreEpoch(runtime, servedEpochKey);
    const certificate = ports.retiringEpoch.certificate(incumbentEpochKey);
    if (
      recorded.kind !== 'recorded' ||
      recorded.disposition.incumbentEpochKey !== incumbentEpochKey ||
      observed.kind !== 'readable' ||
      observed.intent.attemptId !== attemptId ||
      recorded.disposition.successorFingerprint !== observed.intent.target.build.storeFormatFingerprint ||
      incumbent === undefined ||
      successor === undefined ||
      certificate === null ||
      certificate.revision !== recorded.disposition.certificateRevision ||
      JSON.stringify(certificate.jobIds) !== JSON.stringify(recorded.disposition.certificateJobIds) ||
      !ports.retiringEpoch.resultsReleased(incumbentEpochKey)
    )
      return false;
    return (
      successor.storeRoot === (incumbent.canonicalStoreRoot ?? incumbent.storeRoot) &&
      BigInt(successor.epoch) === BigInt(incumbent.epoch) + 1n
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
      await ports.kbDaemon.parkWriterTurn(parkAbort.signal);
      parkAbort.signal.throwIfAborted();
    } finally {
      runtime.time.clearTimeout(parkDeadline);
    }
  }

  async function authorizeRetirement(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    successorFingerprint: string,
    deadlineAt: number,
    protect: () => void,
  ): Promise<void> {
    const certificate = ports.retiringEpoch.certificate(preparation.epochKey);
    if (certificate === null || !ports.retiringEpoch.resultsReleased(preparation.epochKey)) {
      throw new Error('Historical job inventory and result retention are not certified.');
    }
    const custodySettled = await ports.retiringEpoch.certifyCustody(
      preparation.epochKey,
      AbortSignal.timeout(Math.max(1, deadlineAt - runtime.time.now())),
    );
    if (!custodySettled) throw new Error('Retiring epoch custody has not settled.');
    if (runtime.time.now() >= deadlineAt) throw new Error('Retirement certification exceeded the commit deadline.');
    await ports.interposition.at('retirement-protection', { recovery: false });
    protect();
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
   * Runs one attempt through the commit window. A first attempt that fails before the window opens throws,
   * because nothing was parked; every later failure returns the parked state it leaves.
   */
  async function runCommit(
    attempt: SuccessionAttempt,
    preparation: SuccessionPreparation,
    recovery: RecoveryContext | null,
  ): Promise<CommitOutcome> {
    const recovering = recovery !== null;
    const intentAtStart = readUpgradeIntent(runDir);
    if (intentAtStart.kind !== 'readable' || intentAtStart.intent.attemptId !== attempt.attemptId) {
      throw new Error('Succession intent changed before commit.');
    }
    const successorFingerprint = intentAtStart.intent.target.build.storeFormatFingerprint;
    const formatChanging = !recovering && successorFingerprint !== ports.incumbent.storeFormatFingerprint;
    const transfersChildPrincipals = preparation.receipts.some((receipt) => receipt.owner === 'child-principals');
    try {
      const ready = await waitForAttemptReady(attempt);
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
        if (reported.kind !== 'ready') throw new Error(`Succession readiness was ${reported.kind}.`);
      }
      await awaitListenerTransfer(attempt);
    } catch (error: unknown) {
      if (!recovering) throw new Error(formatError(error), { cause: error });
      return {
        kind: 'failed',
        attempt,
        preparation,
        reason: formatError(error),
        ...recovery,
        pauseDeadlineAtMs: runtime.time.now(),
        childHold: await abortAndReap(attempt),
      };
    }

    if (formatChanging) {
      // Settles now, outside the admission pause, whatever retiring custody can discharge: the binding
      // certification inside the pause is too short to also wait out a process discharge.
      await ports.retiringEpoch.certifyCustody(preparation.epochKey, new AbortController().signal);
    }
    const pauseDeadlineAtMs = openPause(attempt.attemptId, preparation.admissionRevision);
    const stopAttemptForwarding = attempt.forwardConnections(ports.listener());
    // Only after forwarding starts: a wait that resubscribes must reach the successor, never this incumbent,
    // whose store reads fail once its writers park.
    ports.waitHandover.abort();
    let forwarding = true;
    const stopForwarding = (): void => {
      if (!forwarding) return;
      forwarding = false;
      stopAttemptForwarding();
    };
    const deadlineAt = pauseDeadlineAtMs - RECLAIM_RESERVE_MS;
    let writer: SuccessionWriterEntitlement | null = recovery?.writer ?? null;
    let retirementStoreParked = recovery?.retirementStoreParked ?? false;
    let hold: string | null = null;
    const unsubscribe = attempt.onAcknowledgment((acknowledgment) => {
      if (acknowledgment.kind === 'hold') hold = acknowledgment.reason;
    });
    let failure: unknown;
    try {
      await updateAttempt(attempt.attemptId, (intent) => ({
        ...intent,
        disposition: 'attempting',
        attemptDeadline: new Date(deadlineAt).toISOString(),
      }));
      await attempt.setDeadline(deadlineAt);
      const inspected = inspectCurrentStore(runtime);
      if (inspected.kind !== 'current' || encodeResolvedStoreEpoch(runtime, inspected.epoch) !== preparation.epochKey) {
        throw new Error('Incumbent store epoch changed before writer park.');
      }
      writer = joinSuccessionWriterGeneration(runtime, inspected.epoch);
      const writers = writersOrThrow();
      if (formatChanging) {
        if (preparation.receipts.length > 0 || ports.liveJobIds().length > 0) {
          throw new Error('Format-changing retirement still has live obligations.');
        }
        ports.retiringEpoch.recoverLocations(preparation.epochKey);
      }
      if (!recovering) {
        await parkIncumbentWriters(writers, deadlineAt);
        writer.park();
      }
      if (transfersChildPrincipals) ports.childPrincipals.fenceAuthentication();
      if (formatChanging) {
        await authorizeRetirement(attempt, preparation, successorFingerprint, deadlineAt, () => {
          retirementStoreParked = true;
          writers.protectRetiringStore(preparation.epochKey);
        });
      }
      await attempt.allowCommittedOpen();
      for (;;) {
        const serving = observeSuccessionServing(runtime, attempt.attemptId);
        if (serving !== null) {
          if (
            (serving.epochKey !== preparation.epochKey &&
              !retirementServes(attempt.attemptId, preparation.epochKey, serving.epochKey)) ||
            serving.controlGeneration <= writer.generation.generation
          ) {
            throw new Error('Durable serving record does not match the prepared takeover.');
          }
          if (!recovering) {
            const committed = await ports.reconciler().commit(attempt.attemptId);
            if (committed.kind !== 'committed') {
              ports.log(`Succession serves, but completion receipt is ${committed.kind}.\n`);
            }
          }
          await ports.interposition.at('incumbent-release', { recovery: recovering });
          break;
        }
        if (hold !== null) throw new Error(hold);
        if (abortRequested) throw new Error('Incumbent shutdown aborted the uncommitted attempt.');
        if (attempt.child.exitCode !== null || attempt.child.signalCode !== null) {
          throw new Error('Successor exited before durable serving.');
        }
        if (runtime.time.now() >= deadlineAt) throw new Error('Successor missed its serving deadline.');
        await runtime.time.sleep(SERVING_POLL_MS);
      }
    } catch (error: unknown) {
      failure = error;
    } finally {
      unsubscribe();
    }
    if (observeSuccessionServing(runtime, attempt.attemptId) !== null) return { kind: 'serving', attempt };

    stopForwarding();
    ports.waitHandover.renew();
    const reason = formatError(failure);
    await recordBestEffort(attempt.attemptId, (intent) => ({
      ...intent,
      disposition: 'deferred',
      blockers: [{ owner: 'succession-commit', reason }],
      retryCondition: { kind: 'attempt-expiry', evidence: 'incumbent writer reclaim' },
    }));
    const childHold = await abortAndReap(attempt);
    if (formatChanging) {
      try {
        discardUnservedRetirementMint(runtime, preparation.epochKey, attempt.attemptId);
      } catch (error: unknown) {
        if (observeSuccessionServing(runtime, attempt.attemptId) !== null) return { kind: 'serving', attempt };
        ports.log(`Unserved retirement mint could not be discarded: ${formatError(error)}\n`);
      }
    }
    return {
      kind: 'failed',
      attempt,
      preparation,
      reason,
      writer,
      retirementStoreParked,
      transfersChildPrincipals,
      pauseDeadlineAtMs,
      childHold,
    };
  }

  async function reclaimKbDaemonWriter(
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
        runtime.time.sleep(KB_WRITER_RECLAIM_ACK_MS).then(() => false as const),
      ]);
    } catch {
      acknowledged = false;
    }
    if (acknowledged) return;
    const stopped = await ports.kbDaemon.stop('succession writer reclaim', { signal });
    if (stopped.pid !== null) throw new Error('KB daemon writer remained alive after bounded stop.');
  }

  /** Resumes this incumbent in place; false leaves its writers parked for a same-build successor. */
  async function reclaimInPlace(failure: FailedCommit, recovering: boolean): Promise<boolean> {
    const attemptId = failure.attempt?.attemptId ?? failure.preparation.attemptId;
    if (failure.writer === null) {
      closePause();
      await recordBestEffort(attemptId, (intent) => ({
        ...intent,
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
        retryCondition: { kind: 'target-change', evidence: 'successor commit preparation failure' },
      }));
      return true;
    }
    const writers = writersOrThrow();
    const writer = failure.writer;
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
      deadlineMs: Math.max(RECLAIM_RESERVE_MS, failure.pauseDeadlineAtMs - runtime.time.now()),
      reclaimKbDaemonWriter: (generation, signal) => reclaimKbDaemonWriter(generation, signal, recovering),
      startSameBuildSuccession: (reason) => ports.log(`Same-build writer recovery required: ${reason}\n`),
    });
    if (reclaimed.kind !== 'reclaimed') return false;
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
    const childPrincipalHold =
      failure.transfersChildPrincipals && !ports.childPrincipals.reclaimAuthentication(reclaimed.generation.generation)
        ? [
            {
              owner: 'child-principals',
              reason: 'consumed-nonce ledger could not be reclaimed; child handles stay fenced',
            },
          ]
        : [];
    writers.adoptProviderOperationAdmission(reclaimed.providerOperationAdmission);
    ports.setLaunchFenceActive(false);
    closePause();
    await recordBestEffort(attemptId, (intent) => ({
      ...intent,
      disposition: 'deferred',
      attemptId: null,
      attemptChild: null,
      attemptOwner: null,
      attemptDeadline: null,
      recoveryAttemptId: null,
      recoveryBuildSetId: null,
      successionPreparation: null,
      blockers: [
        { owner: 'succession-commit', reason: `incumbent reclaimed after ${failure.reason}` },
        ...childHoldBlockers(failure.childHold),
        ...childPrincipalHold,
      ],
      retryCondition: { kind: 'target-change', evidence: 'successor committed-open failure' },
    }));
    ports.log(`Succession attempt held and incumbent writer reclaimed: ${failure.reason}\n`);
    return true;
  }

  /** Records the same-build recovery grant a relaunched child or the next startup of this build serves from. */
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
      attemptId: recoveryPreparation.attemptId,
      attemptChild: null,
      attemptDeadline: null,
      attemptOwner: {
        kind: 'incumbent',
        instanceId: ports.incumbent.instanceId,
        pid: ports.incumbent.pid,
        incarnation: ports.incumbent.incarnation(),
      },
      recoveryAttemptId: recoveryPreparation.attemptId,
      recoveryBuildSetId: ports.incumbent.build?.manifest.buildSetId ?? null,
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
      transfersChildPrincipals: failure.transfersChildPrincipals,
    };
    let recoveryPreparation: SuccessionPreparation = failure.preparation;
    let attempt: SuccessionAttempt | null = null;
    const failed = async (reason: string): Promise<FailedCommit> => ({
      kind: 'failed',
      attempt,
      preparation: recoveryPreparation,
      reason,
      ...recovery,
      pauseDeadlineAtMs: runtime.time.now(),
      childHold: attempt === null ? null : await abortAndReap(attempt),
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
    active = attempt;
    try {
      return await runCommit(attempt, recoveryPreparation, recovery);
    } catch (error: unknown) {
      return failed(`same-build recovery failed: ${formatError(error)}`);
    }
  }

  /**
   * Every failed commit ends in one of three named exits: the incumbent reclaims in place, a same-build
   * successor it launched serves, or the incumbent records a same-build recovery grant and exits so the next
   * startup of this build serves from it. A parked incumbent that stays alive is never one of them.
   */
  async function settleFailedCommit(initial: FailedCommit): Promise<void> {
    let failure = initial;
    for (let relaunches = 0; ; relaunches++) {
      if (await reclaimInPlace(failure, relaunches > 0)) return;
      ports.setLaunchFenceActive(true);
      const writer = failure.writer;
      const bundleDir = ports.incumbent.build?.bundleDir;
      if (writer === null || bundleDir === undefined || abortRequested || relaunches >= SAME_BUILD_RECOVERY_ATTEMPTS) {
        await recordRecoveryAttempt(failure).catch((error: unknown) =>
          ports.log(`Same-build restart grant could not be recorded: ${formatError(error)}\n`),
        );
        ports.log(`Incumbent exits for a same-build restart after ${failure.reason}\n`);
        return writersOrThrow().releaseAuthority({ kind: 'restart', reason: failure.reason });
      }
      const outcome = await runSameBuildRecovery(failure, writer, bundleDir);
      if (outcome.kind === 'serving') return releaseToSuccessor(outcome.attempt);
      failure = outcome;
    }
  }

  async function superviseCommit(attempt: SuccessionAttempt, preparation: SuccessionPreparation): Promise<void> {
    let outcome: CommitOutcome;
    try {
      outcome = await runCommit(attempt, preparation, null);
    } catch (error: unknown) {
      const reason = formatError(error);
      await recordBestEffort(attempt.attemptId, (current) => ({
        ...current,
        disposition: 'deferred',
        blockers: [{ owner: 'succession-prepare', reason }],
        retryCondition: { kind: 'attempt-expiry', evidence: 'successor attempt exit' },
      }));
      const childHold = await abortAndReap(attempt);
      await recordBestEffort(attempt.attemptId, (current) => ({
        ...current,
        disposition: 'deferred',
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        successionPreparation: null,
        blockers: [
          { owner: 'succession-prepare', reason: `incumbent retained authority after ${reason}` },
          ...childHoldBlockers(childHold),
        ],
        retryCondition: { kind: 'target-change', evidence: 'successor readiness failure' },
      }));
      return;
    }
    if (outcome.kind === 'serving') return releaseToSuccessor(outcome.attempt);
    try {
      await settleFailedCommit(outcome);
    } catch (error: unknown) {
      if (active !== null && observeSuccessionServing(runtime, active.attemptId) !== null) {
        return releaseToSuccessor(active);
      }
      ports.log(`Failed succession commit could not be settled in place: ${formatError(error)}\n`);
      return writersOrThrow().releaseAuthority({ kind: 'restart', reason: formatError(error) });
    }
  }

  async function launchPrepared(intent: UpgradeIntent, preparation: SuccessionPreparation): Promise<void> {
    if (active !== null) throw new Error('Another succession attempt is active.');
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
    active = attempt;
    abortRequested = false;
    supervision = superviseCommit(attempt, preparation)
      .catch((error: unknown) => ports.log(`Succession commit supervision failed: ${formatError(error)}\n`))
      .finally(() => {
        active = null;
        supervision = null;
        abortRequested = false;
      });
  }

  async function publishServing(attemptId: string, recovery: boolean): Promise<void> {
    if (recovery) {
      await updateAttempt(attemptId, (intent) => ({
        ...intent,
        incumbent: {
          instanceId: ports.incumbent.instanceId,
          pid: ports.incumbent.pid,
          incarnation: ports.incumbent.incarnation(),
          version: ports.incumbent.version,
          bundleHash: ports.incumbent.bundleHash,
          flavor: ports.incumbent.flavor,
        },
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        recoveryAttemptId: null,
        recoveryBuildSetId: null,
        successionPreparation: null,
        disposition: 'deferred',
        blockers: [{ owner: 'succession-commit', reason: 'same-build recovery serves after failed target commit' }],
        retryCondition: { kind: 'target-change', evidence: 'successor committed-open failure' },
        completionReceipt: null,
      }));
      ports.reconciler().notifyObligationChange();
      return;
    }
    for (let attempt = 0; attempt < SERVING_RECEIPT_ATTEMPTS; attempt++) {
      const decision = await ports.reconciler().commit(attemptId);
      if (decision.kind === 'committed') return;
      await runtime.time.sleep(SERVING_RECEIPT_RETRY_MS);
    }
    ports.log('Durable succession serving could not publish its completion receipt.\n');
  }

  const shutdown: SuccessionShutdownPort = {
    committed: () => active !== null && observeSuccessionServing(runtime, active.attemptId) !== null,
    handOverOpenConnections: async () => {
      if (active !== null) await handOverOpenConnections(active);
    },
    settleUncommittedAttempt: async () => {
      const attempt = active;
      if (attempt === null) return;
      abortRequested = true;
      await attempt.abort().catch(() => {});
      await supervision;
    },
  };

  return { launchPrepared, retirementServes, publishServing, shutdown };
}
