import { MAX_BUFFER } from '../../infra/process-constants.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPool } from '../../jobs/contracts/admission.js';
import type { AbortHoldDisposition } from '../../jobs/contracts/abort-registry.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableLaunchResult,
  DurableLaunchSignalAuthority,
  DurablePendingLaunchObligation,
  DurableProvisionalProcessSubject,
  Runtime,
} from '../../runtime/ports.js';
import { type GracefulKillByPidOutcome } from '../../infra/process-supervision.js';
import { createMonotonicClock, createObservedDuration } from '../../infra/monotonic-clock.js';
import {
  observeRecordedContainment,
  ProcessContainmentError,
  reapRecordedContainment,
  type RecordedContainmentObservation,
} from '../../infra/process-containment.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '../../infra/process-constants.js';
import type {
  DurableContainmentOperatorControl,
  DurableProcessIdentityCallback,
  DurableProcessPublicationDisposition,
} from '../../providers/cli-runner.js';

const IDLE_TIMEOUT = 10 * 60 * 1000;
const DURABLE_RUNTIME_POLL_INTERVAL_MS = 500;
const durableProcessCleanupClockScope = Symbol('durable-process-cleanup');
declare const durableContainmentAbsenceBrand: unique symbol;
const DURABLE_PROCESS_CLEANUP_DEADLINE_MS =
  SIGTERM_GRACE_MS +
  SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
  2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

function terminationOutcomeDetail(outcome: Exclude<GracefulKillByPidOutcome, { kind: 'observed-absent' }>): string {
  switch (outcome.kind) {
    case 'signal-refused':
      return outcome.reason;
    case 'signal-delivered-escalation-unavailable':
      return `${outcome.signal}:${outcome.reason}`;
    case 'signal-failed':
      return `${outcome.signal}:${outcome.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `${outcome.kind}:${outcome.stage}`;
  }
}

export type DurableProcessRetention = Readonly<{
  kind: 'recorded-wrapper-group';
  provider: string;
  jobDir: string;
  jobId?: string;
  containment: Readonly<{
    pid: number;
    incarnation: ProcessIncarnation;
    processGroupId: number;
    childRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
  }>;
}>;

export type PendingDurableLaunchIdentity = Readonly<{
  kind: 'awaiting-wrapper-identity';
  provider: string;
  jobDir: string;
  jobId?: string;
}>;

export type PendingDurableLaunch = Readonly<{
  settled: Promise<void>;
  retainedIdentity(): PendingDurableLaunchIdentity;
}>;

type DurableContainmentAbsenceCapability = Readonly<{
  kind: 'observed-absent';
  pid: number;
  retention: DurableProcessRetention;
}> &
  Readonly<{ [durableContainmentAbsenceBrand]: true }>;

type DurableContainmentObservationOutcome =
  | DurableContainmentAbsenceCapability
  | Exclude<RecordedContainmentObservation, { kind: 'absent' }>;

type DurableProcessTerminationOutcome =
  | DurableContainmentAbsenceCapability
  | Exclude<GracefulKillByPidOutcome, { kind: 'observed-absent' }>;

type DurableContainmentOperation =
  | Readonly<{ kind: 'observe' }>
  | Readonly<{
      kind: 'terminate';
      signalAuthority: DurableLaunchSignalAuthority | undefined;
      signal: AbortSignal;
    }>;

function resolveDurableProcessContainment(
  runtime: Runtime,
  retained: DurableProcessRetention,
  operation: Readonly<{ kind: 'observe' }>,
): Promise<DurableContainmentObservationOutcome>;
function resolveDurableProcessContainment(
  runtime: Runtime,
  retained: DurableProcessRetention,
  operation: Readonly<{
    kind: 'terminate';
    signalAuthority: DurableLaunchSignalAuthority | undefined;
    signal: AbortSignal;
  }>,
): Promise<DurableProcessTerminationOutcome>;
async function resolveDurableProcessContainment(
  runtime: Runtime,
  retained: DurableProcessRetention,
  operation: DurableContainmentOperation,
): Promise<DurableContainmentObservationOutcome | DurableProcessTerminationOutcome> {
  const containment = retained.containment;
  const pid = containment.pid;
  let outcome:
    | Readonly<{ kind: 'absence-observed' }>
    | Exclude<RecordedContainmentObservation, { kind: 'absent' }>
    | Exclude<GracefulKillByPidOutcome, { kind: 'observed-absent' }>;

  if (operation.kind === 'observe') {
    const observation = observeRecordedContainment(
      { ...containment, childRoot: containment.childRoot },
      {
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
      },
    );
    outcome = observation.kind === 'absent' ? { kind: 'absence-observed' } : observation;
  } else {
    const signalAuthority = operation.signalAuthority;
    const liveSignalAuthority =
      signalAuthority?.pid === pid && signalAuthority.hasExited() === false ? signalAuthority : undefined;
    const recordedRoots =
      liveSignalAuthority === undefined || runtime.env.platform() === 'linux'
        ? containment.childRoot === null
          ? []
          : [containment.childRoot]
        : [];
    const clock = createMonotonicClock(durableProcessCleanupClockScope, {
      readMilliseconds: () => runtime.time.monotonicNow(),
      sleep: (milliseconds) => runtime.time.sleep(milliseconds),
    });
    try {
      const reapOutcome = await reapRecordedContainment(
        containment,
        recordedRoots,
        clock.shiftMilliseconds(clock.now(), DURABLE_PROCESS_CLEANUP_DEADLINE_MS),
        {
          maxRecordedRoots: 1,
          clock,
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          signal: operation.signal,
          readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
          ...(liveSignalAuthority === undefined
            ? {}
            : {
                knownLiveChildFor: (targetPid: number) =>
                  targetPid === liveSignalAuthority.pid ? liveSignalAuthority : undefined,
              }),
        },
      );
      if (reapOutcome.kind === 'recorded-group-unattributable') {
        outcome = { kind: 'signal-refused', pid, reason: 'expected-incarnation-mismatch' };
      } else if (reapOutcome.kind === 'signal-authorization-refused') {
        outcome = { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
      } else if (reapOutcome.kind === 'identity-unobservable') {
        outcome = reapOutcome.signalDelivered
          ? { kind: 'target-unobservable', pid, stage: 'after-sigterm' }
          : { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' };
      } else if (containment.childRoot === null || recordedRoots.length > 0) {
        outcome = { kind: 'absence-observed' };
      } else {
        const subject = { ...containment, childRoot: containment.childRoot };
        const observation = observeRecordedContainment(subject, {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (targetPid, platform) => runtime.process.readProcessIncarnation(targetPid, platform),
        });
        outcome =
          observation.kind === 'absent'
            ? { kind: 'absence-observed' }
            : observation.kind === 'alive'
              ? { kind: 'target-alive', pid, stage: 'after-sigkill' }
              : { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
      }
    } catch (error: unknown) {
      outcome =
        error instanceof ProcessContainmentError && error.code === 'process_identity_unverified'
          ? { kind: 'signal-refused', pid, reason: 'signal-authorizing-incarnation-unavailable' }
          : { kind: 'target-unobservable', pid, stage: 'after-sigkill' };
    }
  }

  return outcome.kind === 'absence-observed'
    ? // eslint-disable-next-line no-restricted-syntax -- DurableContainmentAbsenceCapability may only be minted by resolveDurableProcessContainment.
      (Object.freeze({ kind: 'observed-absent', pid, retention: retained }) as DurableContainmentAbsenceCapability)
    : outcome;
}

export type DurableProcessCleanupOutcome =
  | GracefulKillByPidOutcome
  | Readonly<{ kind: 'ownership-retained'; pid: number; reason: string }>;

export type DurableProcessCleanup = () => Promise<DurableProcessCleanupOutcome>;

type CleanupOwnershipReleaseDisposition =
  | Readonly<{ kind: 'released' }>
  | Readonly<{ kind: 'retained'; reason: string }>;

type DurableProviderResultDisposition =
  | Readonly<{ kind: 'absence-confirmed' }>
  | Readonly<{ kind: 'held'; reason: string }>
  | Readonly<{ kind: 'operator-abandoned' }>;

export type CliExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

type SpawnCliOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  permitGranted?: boolean;
  pool?: LaunchPool;
  extraEnv?: Record<string, string>;
  exactEnv?: Record<string, string>;
};

export type SpawnDurableJobOptions = SpawnCliOptions & {
  jobDir: string;
  jobId?: string;
  onRuntimeRecord?: (record: JobRuntime, provisionalIdentity?: DurableProvisionalProcessSubject) => void;
  /** A partial containment identity must not cross the durable publication boundary. */
  onDurableProcessIdentity?: DurableProcessIdentityCallback;
};

export async function spawnDurableJobTransport(params: {
  runtime: Runtime;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  internalPermitJobId: string | null;
  cleanupHandles: Map<symbol, DurableProcessCleanup>;
  cleanupRetentions: Map<DurableProcessCleanup, DurableProcessRetention>;
  pendingLaunches: Set<PendingDurableLaunch>;
  releaseLaunch: (jobId: string, pool: LaunchPool) => void;
}): Promise<CliExecResult> {
  const { runtime, options, pool, cleanupHandles, cleanupRetentions, pendingLaunches, releaseLaunch } = params;
  const { internalPermitJobId } = params;
  let abortHandler: (() => void) | null = null;
  let abortedBySignal = false;
  let cleanupKey: symbol | null = null;
  let cleanupInFlight: Promise<DurableProcessCleanupOutcome> | null = null;
  const unsettledCleanupAttempts = new Set<Promise<DurableProcessTerminationOutcome>>();
  let cleanupAbortController: AbortController | null = null;
  let cleanupGeneration = 0;
  let cleanupRetryInterval: ReturnType<Runtime['time']['setInterval']> | null = null;
  let containmentAbsenceConfirmed = false;
  let containmentAbandoned = false;
  let providerResultHeld = false;
  let resolveContainmentAbsence!: () => void;
  const containmentAbsence = new Promise<void>((resolve) => {
    resolveContainmentAbsence = resolve;
  });
  let lastUnsettledDetail: string | null = null;
  let lastPublishedStatus: string | null = null;
  let publishedPid: number | null = null;
  let publishedSubject: DurableCliProcessSubject | null = null;
  let provisionalSubject: DurableProvisionalProcessSubject | null = null;
  let signalAuthority: DurableLaunchSignalAuthority | undefined;
  let retainedProcess: DurableProcessRetention | null = null;
  let resolvePendingLaunch!: () => void;
  let pendingLaunchOwned = true;
  let pendingWrapperObligation: DurablePendingLaunchObligation | null = null;
  const pendingSettlement = new Promise<void>((resolve) => {
    resolvePendingLaunch = resolve;
  });
  const pendingLaunch: PendingDurableLaunch = {
    get settled() {
      return pendingWrapperObligation?.settled ?? pendingSettlement;
    },
    retainedIdentity: () => ({
      kind: 'awaiting-wrapper-identity',
      provider: options.provider,
      jobDir: options.jobDir,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    }),
  };
  const releasePendingLaunch = (): void => {
    if (!pendingLaunchOwned) return;
    pendingLaunchOwned = false;
    pendingLaunches.delete(pendingLaunch);
    resolvePendingLaunch();
  };
  const schedulePendingWrapperTermination = (obligation: DurablePendingLaunchObligation): void => {
    obligation.requestTermination();
  };
  pendingLaunches.add(pendingLaunch);

  const acceptPendingWrapper = (obligation: DurablePendingLaunchObligation): Readonly<{ kind: 'accepted' }> => {
    if (pendingWrapperObligation !== null && pendingWrapperObligation !== obligation) {
      throw new Error('Durable launch changed its pending wrapper obligation.');
    }
    pendingWrapperObligation = obligation;
    void obligation.settled.then(releasePendingLaunch);
    if (abortedBySignal) schedulePendingWrapperTermination(obligation);
    return { kind: 'accepted' };
  };

  const releaseCleanupOwnership = (
    absence: DurableContainmentAbsenceCapability,
  ): CleanupOwnershipReleaseDisposition => {
    if (cleanupKey === null) return { kind: 'released' };
    // Release is reached only with proven absence, so an attempt still settling cannot contradict it and a
    // signal it may yet deliver has no process to reach. Abandonment is the opposite case and does refuse.
    if (absence.retention !== retainedProcess) {
      return { kind: 'retained', reason: 'durable containment identity changed after absence observation' };
    }
    const wasHeld = providerResultHeld;
    if (wasHeld) {
      const publication = publishContainmentStatus({ kind: 'absence-confirmed' });
      if (publication.kind === 'retained') return publication;
    }
    cleanupAbortController?.abort();
    cleanupAbortController = null;
    cleanupGeneration += 1;
    cleanupHandles.delete(cleanupKey);
    cleanupRetentions.delete(cleanup);
    cleanupKey = null;
    if (cleanupRetryInterval !== null) {
      runtime.time.clearInterval(cleanupRetryInterval);
      cleanupRetryInterval = null;
    }
    containmentAbsenceConfirmed = true;
    resolveContainmentAbsence();
    lastUnsettledDetail = null;
    return { kind: 'released' };
  };

  const operatorControl: DurableContainmentOperatorControl = {
    retry: () => {
      void cleanup().catch(() => undefined);
    },
    abandon: () => abandonCleanupOwnership(),
  };

  const publishContainmentStatus = (status: DurableContainmentStatus): DurableProcessPublicationDisposition => {
    const subject = publishedSubject ?? provisionalSubject;
    if (subject === null) return { kind: 'retained', reason: 'durable containment identity is unavailable' };
    const statusKey = JSON.stringify({ subject, status });
    if (statusKey === lastPublishedStatus) return { kind: 'published' };
    try {
      const publication = options.onDurableProcessIdentity?.(
        subject,
        status,
        status.kind === 'held' ? operatorControl : undefined,
      ) ?? { kind: 'published' as const };
      if (publication.kind === 'retained') {
        backendLog.warn(`[durable-process:${subject.pid}] Containment publication retained: ${publication.reason}`);
        return publication;
      }
      lastPublishedStatus = statusKey;
      return publication;
    } catch (error: unknown) {
      const reason = `durable containment publication failed: ${errorMessage(error)}`;
      backendLog.warn(`[durable-process:${subject.pid}] ${reason}`);
      return { kind: 'retained', reason };
    }
  };

  const publishProcessIdentity = (subject: DurableCliProcessSubject | DurableProvisionalProcessSubject): void => {
    const disposition = options.onDurableProcessIdentity?.(subject) ?? { kind: 'published' as const };
    if (disposition.kind === 'retained') {
      throw new Error(`durable process identity publication retained: ${disposition.reason}`);
    }
  };

  const abandonCleanupOwnership = (): AbortHoldDisposition => {
    if (!providerResultHeld || cleanupKey === null) {
      return {
        kind: 'retained',
        reason: 'durable containment ownership is no longer held',
        nextStep: 'Inspect the job before retrying durable abandonment.',
      };
    }
    // A refusal must not destroy the attempt it declines to join: this abandonment cannot await, so the
    // attempt keeps its own ownership until it settles and the operator repeats the abort.
    if (unsettledCleanupAttempts.size > 0) {
      return {
        kind: 'retained',
        reason: 'the active durable containment cleanup attempt is still settling',
        nextStep: 'Retry the abort after the active cleanup attempt settles.',
      };
    }
    const publication = publishContainmentStatus({ kind: 'operator-abandoned', processAbsenceProven: false });
    if (publication.kind === 'retained') {
      return {
        kind: 'retained',
        reason: publication.reason,
        nextStep: 'Retry the abort after durable containment status can be persisted.',
      };
    }
    cleanupAbortController?.abort();
    cleanupAbortController = null;
    cleanupGeneration += 1;
    cleanupHandles.delete(cleanupKey);
    cleanupRetentions.delete(cleanup);
    cleanupKey = null;
    if (cleanupRetryInterval !== null) {
      runtime.time.clearInterval(cleanupRetryInterval);
      cleanupRetryInterval = null;
    }
    containmentAbandoned = true;
    resolveContainmentAbsence();
    return {
      kind: 'abandoned',
      reason: 'job ownership was released without proof of process absence',
      nextStep: 'Inspect the recorded process because it may still be live.',
    };
  };

  const enterContainmentHold = (reason: string): void => {
    providerResultHeld = true;
    publishContainmentStatus({
      kind: 'held',
      reason,
      retryIntervalMs: DURABLE_RUNTIME_POLL_INTERVAL_MS,
      abandonment: 'abort-job',
    });
    if (containmentAbandoned || containmentAbsenceConfirmed || cleanupKey === null) return;
    if (cleanupRetryInterval !== null) return;
    cleanupRetryInterval = runtime.time.setInterval(() => {
      void cleanup().catch((error: unknown) => {
        backendLog.warn(`[durable-process:${publishedPid ?? 'unknown'}] Termination failed: ${errorMessage(error)}`);
      });
    }, DURABLE_RUNTIME_POLL_INTERVAL_MS);
    cleanupRetryInterval.unref?.();
  };

  const cleanup = (): Promise<DurableProcessCleanupOutcome> => {
    if (cleanupInFlight !== null) return cleanupInFlight;
    if (publishedPid === null || retainedProcess === null)
      throw new Error('Durable cleanup was requested before a process identity was published.');
    const pid = publishedPid;
    const cleanupRetention = retainedProcess;
    const generation = ++cleanupGeneration;
    const abortController = new AbortController();
    cleanupAbortController = abortController;
    const cleanupAttempt = resolveDurableProcessContainment(runtime, cleanupRetention, {
      kind: 'terminate',
      signalAuthority,
      signal: abortController.signal,
    });
    unsettledCleanupAttempts.add(cleanupAttempt);
    const cleanupPromise = cleanupAttempt.then(
      (outcome) => {
        unsettledCleanupAttempts.delete(cleanupAttempt);
        if (generation !== cleanupGeneration || cleanupRetention !== retainedProcess) {
          return { kind: 'ownership-retained', pid, reason: 'durable containment cleanup was superseded' } as const;
        }
        if (outcome.kind === 'observed-absent') {
          const release = releaseCleanupOwnership(outcome);
          if (release.kind === 'retained') return { kind: 'ownership-retained', pid, reason: release.reason } as const;
        } else {
          const detail = terminationOutcomeDetail(outcome);
          enterContainmentHold(detail);
          if (detail !== lastUnsettledDetail) {
            backendLog.warn(`[durable-process:${pid}] Termination remains unsettled (${detail}).`);
            lastUnsettledDetail = detail;
          }
        }
        return outcome;
      },
      (error: unknown) => {
        unsettledCleanupAttempts.delete(cleanupAttempt);
        throw error;
      },
    );
    cleanupInFlight = cleanupPromise;
    void cleanupPromise.then(
      () => {
        if (cleanupInFlight === cleanupPromise) {
          cleanupInFlight = null;
          if (cleanupAbortController === abortController) cleanupAbortController = null;
        }
      },
      () => {
        if (cleanupInFlight === cleanupPromise) {
          cleanupInFlight = null;
          if (cleanupAbortController === abortController) cleanupAbortController = null;
        }
      },
    );
    return cleanupPromise;
  };

  const settleProviderResultContainment = async (): Promise<DurableProviderResultDisposition> => {
    if (containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
    if (containmentAbandoned) return { kind: 'operator-abandoned' };
    if (retainedProcess?.kind === 'recorded-wrapper-group') {
      const childRoot = retainedProcess.containment.childRoot;
      if (childRoot !== null) {
        const subject = { ...retainedProcess.containment, childRoot };
        const observation = observeRecordedContainment(subject, {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        });
        if (observation.kind === 'absent') {
          await Promise.race([runtime.time.sleep(CONTAINMENT_DISAPPEARANCE_CONFIRM_MS), containmentAbsence]);
          if (containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
          if (containmentAbandoned) return { kind: 'operator-abandoned' };
          const confirmation = await resolveDurableProcessContainment(runtime, retainedProcess, { kind: 'observe' });
          if (confirmation.kind === 'observed-absent') {
            const release = releaseCleanupOwnership(confirmation);
            return release.kind === 'released'
              ? { kind: 'absence-confirmed' }
              : { kind: 'held', reason: release.reason };
          }
          return {
            kind: 'held',
            reason: confirmation.kind === 'unobservable' ? confirmation.reason : 'containment is still alive',
          };
        }
      }
    }

    const outcome = await cleanup();
    if (containmentAbandoned) return { kind: 'operator-abandoned' };
    if (outcome.kind === 'observed-absent') return { kind: 'absence-confirmed' };
    return {
      kind: 'held',
      reason: outcome.kind === 'ownership-retained' ? outcome.reason : terminationOutcomeDetail(outcome),
    };
  };

  const publishWrapperSpawned = (launch: {
    runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
    pid: number;
    leaderIncarnation: ProcessIncarnation;
    signalAuthority?: DurableLaunchSignalAuthority;
  }): void => {
    if (publishedPid !== null) {
      if (publishedPid !== launch.pid) {
        throw new Error('Durable launch changed process identity after provisional publication.');
      }
      return;
    }
    publishedPid = launch.pid;
    provisionalSubject = {
      kind: 'provisional-wrapper',
      pid: launch.pid,
      incarnation: launch.leaderIncarnation,
      processGroupId: launch.pid,
      provider: options.provider,
      jobDir: options.jobDir,
    };
    signalAuthority = launch.signalAuthority;
    retainedProcess = {
      kind: 'recorded-wrapper-group',
      provider: options.provider,
      jobDir: options.jobDir,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      containment: {
        pid: launch.pid,
        incarnation: launch.leaderIncarnation,
        processGroupId: launch.pid,
        childRoot: null,
      },
    };
    cleanupKey = Symbol();
    cleanupHandles.set(cleanupKey, cleanup);
    cleanupRetentions.set(cleanup, retainedProcess);
    options.onRuntimeRecord?.(launch.runtimeRecord, provisionalSubject);
    publishProcessIdentity(provisionalSubject);
    releasePendingLaunch();
    if (abortedBySignal) {
      enterContainmentHold('termination requested; process absence is not yet proven');
      void cleanup().catch((error: unknown) => {
        backendLog.warn(`[durable-process:${launch.pid}] Termination failed: ${errorMessage(error)}`);
        enterContainmentHold(errorMessage(error));
      });
    }
  };

  const publishSpawned = (launch: {
    runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
    leaderIncarnation: ProcessIncarnation | null;
    childRoot: DurableCliProcessSubject['childRoot'] | null;
    signalAuthority?: DurableLaunchSignalAuthority;
  }): void => {
    if (launch.leaderIncarnation === null) {
      throw new Error('Durable launch reached readiness without an incarnation-bound wrapper identity.');
    }
    publishWrapperSpawned({
      runtimeRecord: launch.runtimeRecord,
      pid: launch.runtimeRecord.pid,
      leaderIncarnation: launch.leaderIncarnation,
      ...(launch.signalAuthority === undefined ? {} : { signalAuthority: launch.signalAuthority }),
    });
    if (launch.leaderIncarnation !== null && launch.childRoot !== null) {
      const cleanupNeedsRetargeting = cleanupInFlight !== null;
      publishedSubject = {
        pid: launch.runtimeRecord.pid,
        incarnation: launch.leaderIncarnation,
        processGroupId: launch.runtimeRecord.pid,
        childRoot: launch.childRoot,
      };
      retainedProcess = {
        kind: 'recorded-wrapper-group',
        provider: options.provider,
        jobDir: options.jobDir,
        ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
        containment: { ...publishedSubject, childRoot: publishedSubject.childRoot },
      };
      cleanupRetentions.set(cleanup, retainedProcess);
      provisionalSubject = null;
      if (cleanupNeedsRetargeting) {
        // Clearing this slot retargets the next attempt; it does not forget the superseded one. Ownership
        // reads `unsettledCleanupAttempts`, which the superseded attempt leaves only when it settles, so an
        // abandonment still cannot release an identity a live attempt is signalling.
        cleanupAbortController?.abort();
        cleanupInFlight = null;
        void cleanup().catch((error: unknown) => {
          backendLog.warn(`[durable-process:${launch.runtimeRecord.pid}] Termination failed: ${errorMessage(error)}`);
          enterContainmentHold(errorMessage(error));
        });
      }
    }
    if (publishedSubject !== null) publishProcessIdentity(publishedSubject);
  };

  try {
    if (options.signal?.aborted) {
      return { stdout: '', stderr: '', code: null, aborted: true };
    }

    const launchOptions = {
      provider: options.provider,
      command: options.command,
      args: options.args,
      prompt: options.prompt,
      cwd: options.cwd,
      jobDir: options.jobDir,
      envAdditions: options.extraEnv,
      env: options.exactEnv,
      onWrapperSpawned: acceptPendingWrapper,
      onWrapperIdentified: publishWrapperSpawned,
      onSpawned: publishSpawned,
    };
    if (options.signal) {
      abortHandler = () => {
        if (abortedBySignal) return;
        abortedBySignal = true;
        if (cleanupKey === null) {
          if (pendingWrapperObligation !== null) schedulePendingWrapperTermination(pendingWrapperObligation);
          return;
        }
        enterContainmentHold('termination requested; process absence is not yet proven');
        operatorControl.retry();
      };

      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    let durable: DurableLaunchResult;
    try {
      let launchDisposition = await runtime.process.durable.launch(launchOptions);
      if (launchDisposition.disposition === 'held') {
        const reason = launchDisposition.reason;
        while (launchDisposition.disposition === 'held') {
          await launchDisposition.retryAfter;
          const retried = await launchDisposition.retry();
          if (retried.disposition === 'settled') throw new Error(reason);
          launchDisposition = retried;
        }
      }
      durable = launchDisposition;
    } catch (launchError: unknown) {
      if (cleanupKey === null) throw launchError;
      while (true) {
        const disposition = await settleProviderResultContainment();
        if (disposition.kind === 'absence-confirmed') throw launchError;
        if (disposition.kind === 'operator-abandoned') throw launchError;
        enterContainmentHold(disposition.reason);
        await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
      }
    }
    if (publishedPid === null) {
      publishSpawned({
        runtimeRecord: durable.runtimeRecord,
        leaderIncarnation: durable.processSubject.incarnation,
        childRoot: durable.processSubject.childRoot,
        ...(durable.signalAuthority === undefined ? {} : { signalAuthority: durable.signalAuthority }),
      });
    } else if (publishedPid !== durable.pid) {
      throw new Error('Durable runtime readiness reported a different process from provisional publication.');
    }
    if (durable.signalAuthority !== undefined) {
      if (durable.signalAuthority.pid !== durable.pid) {
        throw new Error('Durable launch signal authority names a different process from launch readiness.');
      }
      signalAuthority = durable.signalAuthority;
    }

    let runtimeRecord = durable.runtimeRecord;
    let tailOffset = runtimeRecord.tailWatermark ?? 0;
    const durableState: { exitRecord: DurableProcessExit | null; exitError: unknown } = {
      exitRecord: null,
      exitError: null,
    };
    const observedIdle = createObservedDuration(runtime.time.monotonicNow(), DURABLE_RUNTIME_POLL_INTERVAL_MS);

    void runtime.process.durable
      .waitForExit(durable)
      .then((record) => {
        durableState.exitRecord = record;
      })
      .catch((error: unknown) => {
        durableState.exitError = error;
      });

    const drainStdout = (): void => {
      const { lines, newOffset } = readAppendedLines(durable.stdoutPath, tailOffset, runtime.storage);
      if (newOffset === tailOffset) {
        return;
      }

      tailOffset = newOffset;
      observedIdle.reset(runtime.time.monotonicNow());
      runtimeRecord = { ...runtimeRecord, tailWatermark: newOffset };
      options.onRuntimeRecord?.(runtimeRecord);

      for (const line of lines) {
        options.onEvent?.(line);
      }
    };

    const awaitProviderResultContainment = async (): Promise<void> => {
      for (;;) {
        const disposition = await settleProviderResultContainment();
        if (disposition.kind !== 'held') return;
        enterContainmentHold(disposition.reason);
        await Promise.race([runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS), containmentAbsence]);
        drainStdout();
      }
    };

    while (true) {
      drainStdout();

      const completedExit = durableState.exitRecord;
      if (completedExit !== null) {
        await awaitProviderResultContainment();
        drainStdout();
        return {
          stdout: readOutputFile(runtime.storage, durable.stdoutPath),
          stderr: readOutputFile(runtime.storage, durable.stderrPath),
          code: completedExit.exitCode,
          aborted: abortedBySignal,
        };
      }

      if (containmentAbandoned) {
        return {
          stdout: readOutputFile(runtime.storage, durable.stdoutPath),
          stderr: readOutputFile(runtime.storage, durable.stderrPath),
          code: null,
          aborted: true,
        };
      }

      if (durableState.exitError) {
        await awaitProviderResultContainment();
        throw durableState.exitError instanceof Error
          ? durableState.exitError
          : new Error(errorMessage(durableState.exitError));
      }

      observedIdle.advance(runtime.time.monotonicNow());
      if (observedIdle.elapsedMs() >= IDLE_TIMEOUT) {
        const disposition = await cleanup();
        if (disposition.kind === 'observed-absent') {
          throw new Error(
            `Durable process ${durable.pid} terminated after ${IDLE_TIMEOUT / 60_000} minutes of inactivity`,
          );
        }
        observedIdle.reset(runtime.time.monotonicNow());
      }

      await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
    }
  } finally {
    if (pendingWrapperObligation === null) releasePendingLaunch();
    if (abortHandler && options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (internalPermitJobId) {
      releaseLaunch(internalPermitJobId, pool);
    }
  }
}

function readOutputFile(storage: StoragePort, path: string): string {
  try {
    const stats = storage.statSync(path);
    const bytesToRead = Math.min(stats.size, MAX_BUFFER + 1);
    const fd = storage.openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = storage.readSync(fd, buffer, 0, bytesToRead, 0);
      const output = buffer.subarray(0, bytesRead).toString('utf-8');
      if (stats.size > MAX_BUFFER) {
        return output.slice(0, MAX_BUFFER) + '\n[output truncated at 10MB]';
      }
      return output;
    } finally {
      storage.closeSync(fd);
    }
  } catch {
    return '';
  }
}
