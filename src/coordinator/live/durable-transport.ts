import { MAX_BUFFER } from '../../infra/process-constants.js';
import { join } from 'node:path';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readAppendedLines } from '../../infra/file-tail.js';
import type { ProcessIncarnation } from '../../infra/node-process.js';
import { recordCustodyIntent, bindCustodyIdentity, type CustodyIntent } from '../../store/custody-ledger.js';
import { resolveCurrentStoreEpoch } from '../../store/epoch.js';
import type { DurableCliRuntimePublicationEvidence } from '../../infra/durable-cli-runtime-evidence.js';
import type { JobRuntime } from '../../jobs/records.js';
import type { LaunchPermit, LaunchPool, LaunchRelease } from '../../jobs/contracts/admission.js';
import type { AbortHoldDisposition, AbortHoldOwner, AbortNextStep } from '../../jobs/contracts/abort-registry.js';
import type { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import type { DurableProcessExit } from '../../runtime/durable-runtime.js';
import type { StoragePort } from '../../infra/port-types.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableLaunchOptions,
  DurableLaunchResult,
  DurableLaunchSignalAuthority,
  DurablePendingLaunchObligation,
  DurableProvisionalProcessSubject,
  Runtime,
} from '../../runtime/ports.js';
import { type GracefulKillByPidOutcome, type GracefulKillOutcome } from '../../infra/process-supervision.js';
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
  DurableLaunchCallerOwnership,
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

function pendingWrapperTerminationOutcomeDetail(
  outcome: Exclude<GracefulKillOutcome, { kind: 'observed-absent' }>,
): string {
  switch (outcome.kind) {
    case 'signal-failed':
      return `${outcome.signal}:${outcome.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `${outcome.kind}:${outcome.stage}`;
  }
}

export type DurableProcessPublication =
  | Readonly<{
      kind: 'observed-unpublished';
      owner: 'process-exit';
      publicationLoss: string;
    }>
  | Readonly<{
      kind: 'durably-published';
      owner: 'successor-recovery';
      evidence: DurableCliRuntimePublicationEvidence;
    }>;

export type DurableProcessRetention = Readonly<{
  kind: 'recorded-wrapper-group';
  provider: string;
  jobDir: string;
  jobId?: string;
  publication: DurableProcessPublication;
  containment: Readonly<{
    pid: number;
    incarnation: ProcessIncarnation;
    processGroupId: number;
    childRoot: Readonly<{ pid: number; incarnation: ProcessIncarnation }> | null;
  }>;
}>;

export type PendingDurableLaunchIdentity = Readonly<{
  kind: 'awaiting-wrapper-identity';
  owner: 'process-exit';
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
  callerOwnership?: DurableLaunchCallerOwnership;
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

type SpawnDurableJobTransportParams = {
  runtime: Runtime;
  epochPath?: string;
  options: SpawnDurableJobOptions;
  pool: LaunchPool;
  cleanupHandles: Map<symbol, DurableProcessCleanup>;
  cleanupRetentions: Map<DurableProcessCleanup, DurableProcessRetention>;
  pendingLaunches: Readonly<{ add(launch: PendingDurableLaunch): void; delete(launch: PendingDurableLaunch): void }>;
  releaseLaunch: (permit: LaunchPermit) => LaunchRelease;
  ownership:
    | Readonly<{ kind: 'internal'; permit: LaunchPermit; abortRegistry: AbortRegistry }>
    | Readonly<{ kind: 'caller'; permit: LaunchPermit; abortRegistry: AbortHoldOwner }>;
};

type PendingWrapperHold = {
  generation: number;
  obligation: DurablePendingLaunchObligation | null;
  settlement: Promise<GracefulKillOutcome> | null;
  settled: Promise<void>;
  resolveSettled: () => void;
};

type DurableTransportState = {
  forwardExternalAbort: (() => void) | null;
  abortHandler: (() => void) | null;
  abortedBySignal: boolean;
  cleanupKey: symbol | null;
  cleanupInFlight: Promise<DurableProcessCleanupOutcome> | null;
  unsettledCleanupAttempts: Set<Promise<DurableProcessTerminationOutcome>>;
  cleanupAbortController: AbortController | null;
  cleanupGeneration: number;
  cleanupRetryInterval: ReturnType<Runtime['time']['setInterval']> | null;
  containmentAbsenceConfirmed: boolean;
  containmentAbandoned: boolean;
  providerResultHeld: boolean;
  resolveContainmentAbsence: () => void;
  containmentAbsence: Promise<void>;
  lastUnsettledDetail: string | null;
  lastPublishedStatus: string | null;
  publishedPid: number | null;
  custodyIntent: CustodyIntent | null;
  publishedSubject: DurableCliProcessSubject | null;
  provisionalSubject: DurableProvisionalProcessSubject | null;
  signalAuthority: DurableLaunchSignalAuthority | undefined;
  retainedProcess: DurableProcessRetention | null;
  resolvePendingLaunch: () => void;
  pendingLaunchOwned: boolean;
  pendingWrapperObligation: DurablePendingLaunchObligation | null;
  pendingWrapperHoldGeneration: number;
  pendingWrapperHold: PendingWrapperHold | null;
  pendingSettlement: Promise<void>;
};

function createDurableTransportState(): DurableTransportState {
  return {
    forwardExternalAbort: null,
    abortHandler: null,
    abortedBySignal: false,
    cleanupKey: null,
    cleanupInFlight: null,
    unsettledCleanupAttempts: new Set(),
    cleanupAbortController: null,
    cleanupGeneration: 0,
    cleanupRetryInterval: null,
    containmentAbsenceConfirmed: false,
    containmentAbandoned: false,
    providerResultHeld: false,
    resolveContainmentAbsence: () => undefined,
    containmentAbsence: Promise.resolve(),
    lastUnsettledDetail: null,
    lastPublishedStatus: null,
    publishedPid: null,
    custodyIntent: null,
    publishedSubject: null,
    provisionalSubject: null,
    signalAuthority: undefined,
    retainedProcess: null,
    resolvePendingLaunch: () => undefined,
    pendingLaunchOwned: true,
    pendingWrapperObligation: null,
    pendingWrapperHoldGeneration: 0,
    pendingWrapperHold: null,
    pendingSettlement: Promise.resolve(),
  };
}

function retryDurablePendingWrapperTermination(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  generation: number,
  retain: (generation: number, reason: string, nextStep: AbortNextStep) => void,
  settle: (generation: number) => void,
): Extract<AbortHoldDisposition, { kind: 'retained' }> {
  const { permit } = params.ownership;
  const hold = state.pendingWrapperHold;
  if (hold?.generation !== generation) {
    return {
      kind: 'retained',
      reason: 'pending wrapper ownership moved to another generation',
      nextStep: 'Inspect the job before retrying its current abort disposition.',
    };
  }
  if (hold.obligation === null) {
    const disposition: Extract<AbortHoldDisposition, { kind: 'retained' }> = {
      kind: 'retained' as const,
      reason: 'termination requested before the wrapper published its obligation',
      nextStep:
        'Wait for wrapper obligation publication; a returned launch without one proves absence and releases the permit.',
    };
    retain(generation, disposition.reason, disposition.nextStep);
    return disposition;
  }

  let termination: ReturnType<DurablePendingLaunchObligation['requestTermination']>;
  try {
    termination = hold.obligation.requestTermination();
  } catch (error: unknown) {
    const disposition: Extract<AbortHoldDisposition, { kind: 'retained' }> = {
      kind: 'retained' as const,
      reason: `pending wrapper termination threw: ${errorMessage(error)}`,
      nextStep: {
        detail: 'Restore wrapper termination; only observed absence or wrapper settlement releases the permit.',
        remedy: { kind: 'abort-job', jobId: permit.jobId },
      },
    };
    retain(generation, disposition.reason, disposition.nextStep);
    return disposition;
  }

  if (termination.kind === 'signal-failed') {
    const disposition: Extract<AbortHoldDisposition, { kind: 'retained' }> = {
      kind: 'retained' as const,
      reason: `pending wrapper termination failed: ${termination.signal}:${termination.reason}`,
      nextStep: {
        detail: 'Restore signal delivery; only observed absence or wrapper settlement releases the permit.',
        remedy: { kind: 'abort-job', jobId: permit.jobId },
      },
    };
    retain(generation, disposition.reason, disposition.nextStep);
    return disposition;
  }

  if (hold.settlement !== termination.settlement) {
    hold.settlement = termination.settlement;
    void termination.settlement.then(
      (outcome) => {
        if (state.pendingWrapperHold?.generation !== generation) return outcome;
        if (outcome.kind === 'observed-absent') {
          settle(generation);
          return outcome;
        }
        retain(
          generation,
          `pending wrapper termination remains unsettled: ${pendingWrapperTerminationOutcomeDetail(outcome)}`,
          {
            detail: 'Only observed absence or wrapper settlement releases the permit.',
            remedy: { kind: 'abort-job', jobId: permit.jobId },
          },
        );
        return outcome;
      },
      (error: unknown) => {
        retain(generation, `pending wrapper termination settlement failed: ${errorMessage(error)}`, {
          detail: 'Restore wrapper termination; only observed absence or wrapper settlement releases the permit.',
          remedy: { kind: 'abort-job', jobId: permit.jobId },
        });
      },
    );
  }
  const disposition = {
    kind: 'retained' as const,
    reason: 'pending wrapper termination is settling',
    nextStep:
      'Wait for observed absence or wrapper settlement; if the target remains, retry the abort to continue termination.',
  };
  retain(generation, disposition.reason, disposition.nextStep);
  return disposition;
}

function enterDurablePendingWrapperHold(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  obligation: DurablePendingLaunchObligation | null,
  retain: (generation: number, reason: string, nextStep: AbortNextStep) => void,
  settle: (generation: number) => void,
  retry: (generation: number) => Extract<AbortHoldDisposition, { kind: 'retained' }>,
): void {
  const { permit } = params.ownership;
  if (state.pendingWrapperHold !== null) {
    if (state.pendingWrapperHold.obligation === null && obligation !== null) {
      state.pendingWrapperHold.obligation = obligation;
      const generation = state.pendingWrapperHold.generation;
      void obligation.settled.then(
        () => settle(generation),
        (error: unknown) => {
          retain(generation, `pending wrapper settlement failed: ${errorMessage(error)}`, {
            detail: 'Restore wrapper termination; only observed absence or wrapper settlement releases the permit.',
            remedy: { kind: 'abort-job', jobId: permit.jobId },
          });
        },
      );
      retry(generation);
    }
    return;
  }
  const generation = ++state.pendingWrapperHoldGeneration;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  state.pendingWrapperHold = {
    generation,
    obligation,
    settlement: null,
    settled,
    resolveSettled,
  };
  retain(generation, 'termination requested while the durable wrapper identity is pending', {
    detail: 'Only observed absence or wrapper settlement releases the permit.',
    remedy: { kind: 'abort-job', jobId: permit.jobId },
  });
  if (obligation !== null) {
    void obligation.settled.then(
      () => settle(generation),
      (error: unknown) => {
        retain(generation, `pending wrapper settlement failed: ${errorMessage(error)}`, {
          detail: 'Restore wrapper termination; only observed absence or wrapper settlement releases the permit.',
          remedy: { kind: 'abort-job', jobId: permit.jobId },
        });
      },
    );
    retry(generation);
  }
}

async function settleDurableProviderResultContainment(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  cleanup: DurableProcessCleanup,
  releaseCleanupOwnership: (absence: DurableContainmentAbsenceCapability) => CleanupOwnershipReleaseDisposition,
): Promise<DurableProviderResultDisposition> {
  const { runtime } = params;
  if (state.containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
  if (state.containmentAbandoned) return { kind: 'operator-abandoned' };
  if (state.retainedProcess?.kind === 'recorded-wrapper-group') {
    const childRoot = state.retainedProcess.containment.childRoot;
    if (childRoot !== null) {
      const subject = { ...state.retainedProcess.containment, childRoot };
      const observation = observeRecordedContainment(subject, {
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
      });
      if (observation.kind === 'absent') {
        await Promise.race([runtime.time.sleep(CONTAINMENT_DISAPPEARANCE_CONFIRM_MS), state.containmentAbsence]);
        if (state.containmentAbsenceConfirmed) return { kind: 'absence-confirmed' };
        if (state.containmentAbandoned) return { kind: 'operator-abandoned' };
        const confirmation = await resolveDurableProcessContainment(runtime, state.retainedProcess, {
          kind: 'observe',
        });
        if (confirmation.kind === 'observed-absent') {
          const release = releaseCleanupOwnership(confirmation);
          return release.kind === 'released' ? { kind: 'absence-confirmed' } : { kind: 'held', reason: release.reason };
        }
        return {
          kind: 'held',
          reason: confirmation.kind === 'unobservable' ? confirmation.reason : 'containment is still alive',
        };
      }
    }
  }

  const outcome = await cleanup();
  if (state.containmentAbandoned) return { kind: 'operator-abandoned' };
  if (outcome.kind === 'observed-absent') return { kind: 'absence-confirmed' };
  return {
    kind: 'held',
    reason: outcome.kind === 'ownership-retained' ? outcome.reason : terminationOutcomeDetail(outcome),
  };
}

type DurableWrapperSpawned = {
  runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
  pid: number;
  leaderIncarnation: ProcessIncarnation;
  signalAuthority?: DurableLaunchSignalAuthority;
};

function prepareDurableWrapperPublication(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  launch: DurableWrapperSpawned,
): DurableProcessRetention | null {
  const { runtime, options } = params;
  if (state.custodyIntent === null) throw new Error('Durable wrapper spawned without pre-effect custody intent.');
  bindCustodyIdentity(runtime, runtime.paths.coral.coordinator.runDir, state.custodyIntent, {
    process: { pid: launch.pid, incarnation: launch.leaderIncarnation, processGroupId: launch.pid },
    capsule: state.custodyIntent.capsule,
    observedAtMs: runtime.time.now(),
  });
  if (state.publishedPid !== null) {
    if (state.publishedPid !== launch.pid) {
      throw new Error('Durable launch changed process identity after provisional publication.');
    }
    return null;
  }
  state.publishedPid = launch.pid;
  state.provisionalSubject = {
    kind: 'provisional-wrapper',
    pid: launch.pid,
    incarnation: launch.leaderIncarnation,
    processGroupId: launch.pid,
    provider: options.provider,
    jobDir: options.jobDir,
  };
  state.signalAuthority = launch.signalAuthority;
  const wrapperGroup = {
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
  } as const;
  state.retainedProcess = {
    ...wrapperGroup,
    publication: {
      kind: 'observed-unpublished',
      owner: 'process-exit',
      publicationLoss: 'runtime publication is unproven',
    },
  };
  state.cleanupKey = Symbol();
  return state.retainedProcess;
}

function recordDurableRuntimePublication(
  params: SpawnDurableJobTransportParams,
  launch: DurableWrapperSpawned,
  subject: DurableProvisionalProcessSubject,
  setPublication: (publication: DurableProcessPublication) => void,
): Readonly<{ error: unknown }> | null {
  const { options } = params;
  let runtimePublicationFailure: Readonly<{ error: unknown }> | null = null;
  if (options.onRuntimeRecord === undefined) {
    setPublication({
      kind: 'observed-unpublished',
      owner: 'process-exit',
      publicationLoss: 'runtime publication callback is unavailable',
    });
  } else {
    try {
      options.onRuntimeRecord(launch.runtimeRecord, subject);
      setPublication(
        options.jobId === undefined
          ? {
              kind: 'observed-unpublished',
              owner: 'process-exit',
              publicationLoss: 'runtime publication is unproven because the job id is unavailable',
            }
          : {
              kind: 'durably-published',
              owner: 'successor-recovery',
              evidence: {
                kind: 'durable-cli-runtime',
                jobId: options.jobId,
                pid: launch.runtimeRecord.pid,
                leaderIncarnation: launch.leaderIncarnation,
              },
            },
      );
    } catch (error: unknown) {
      setPublication({
        kind: 'observed-unpublished',
        owner: 'process-exit',
        publicationLoss: `runtime publication failed: ${errorMessage(error)}`,
      });
      runtimePublicationFailure = { error };
    }
  }

  return runtimePublicationFailure;
}

type DurableReadySpawn = {
  runtimeRecord: Extract<JobRuntime, { transport: 'durable-cli' }>;
  leaderIncarnation: ProcessIncarnation | null;
  childRoot: DurableCliProcessSubject['childRoot'] | null;
  signalAuthority?: DurableLaunchSignalAuthority;
};

function durableWrapperIdentityFromReady(launch: DurableReadySpawn): DurableWrapperSpawned {
  if (launch.leaderIncarnation === null) {
    throw new Error('Durable launch reached readiness without an incarnation-bound wrapper identity.');
  }
  return {
    runtimeRecord: launch.runtimeRecord,
    pid: launch.runtimeRecord.pid,
    leaderIncarnation: launch.leaderIncarnation,
    ...(launch.signalAuthority === undefined ? {} : { signalAuthority: launch.signalAuthority }),
  };
}

function retargetDurableReadySpawn(state: DurableTransportState, launch: DurableReadySpawn): boolean {
  if (launch.leaderIncarnation !== null && launch.childRoot !== null) {
    const cleanupNeedsRetargeting = state.cleanupInFlight !== null;
    const currentRetention = state.retainedProcess;
    if (currentRetention === null) {
      throw new Error('Durable launch reached readiness without retained wrapper ownership.');
    }
    state.publishedSubject = {
      pid: launch.runtimeRecord.pid,
      incarnation: launch.leaderIncarnation,
      processGroupId: launch.runtimeRecord.pid,
      childRoot: launch.childRoot,
    };
    state.retainedProcess = {
      ...currentRetention,
      containment: { ...state.publishedSubject, childRoot: state.publishedSubject.childRoot },
    };
    state.provisionalSubject = null;
    return cleanupNeedsRetargeting;
  }
  return false;
}

async function awaitDurableLaunchResult(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  durable: DurableLaunchResult,
  settleProviderResultContainment: () => Promise<DurableProviderResultDisposition>,
  enterContainmentHold: (reason: string) => void,
  cleanup: DurableProcessCleanup,
): Promise<CliExecResult> {
  const { runtime, options } = params;
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
      await Promise.race([runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS), state.containmentAbsence]);
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
        aborted: state.abortedBySignal,
      };
    }

    if (state.containmentAbandoned) {
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
}

async function executeDurableLaunch(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  signal: AbortSignal | undefined,
  acceptPendingWrapper: (obligation: DurablePendingLaunchObligation) => Readonly<{ kind: 'accepted' }>,
  publishWrapperSpawned: (launch: DurableWrapperSpawned) => void,
  publishSpawned: (launch: DurableReadySpawn) => void,
  enterPendingWrapperHold: (obligation: DurablePendingLaunchObligation | null) => void,
  enterContainmentHold: (reason: string) => void,
  operatorControl: DurableContainmentOperatorControl,
  settleProviderResultContainment: () => Promise<DurableProviderResultDisposition>,
): Promise<DurableLaunchResult> {
  const { runtime, options } = params;
  const { permit } = params.ownership;
  const launchOptions: DurableLaunchOptions = {
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
  if (signal) {
    state.abortHandler = () => {
      if (state.abortedBySignal) return;
      state.abortedBySignal = true;
      if (state.cleanupKey === null) {
        enterPendingWrapperHold(state.pendingWrapperObligation);
        return;
      }
      enterContainmentHold('termination requested; process absence is not yet proven');
      operatorControl.retry();
    };

    if (signal.aborted) state.abortHandler();
    else signal.addEventListener('abort', state.abortHandler, { once: true });
  }
  let durable: DurableLaunchResult;
  try {
    const dbDir = runtime.paths.coral.store.dbDir;
    const epoch =
      params.epochPath ??
      (() => {
        const selected = resolveCurrentStoreEpoch(runtime.storage, dbDir);
        if (selected === null) throw new Error('Durable wrapper custody requires a selected store epoch.');
        return join(dbDir, `epoch-${selected}`);
      })();
    state.custodyIntent = recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
      effect: 'process-spawn',
      epoch,
      owner: 'durable-cli',
      operationId: options.jobId ?? permit.jobId,
      capsule: join(options.jobDir, 'launch.v1.json'),
      nowMs: runtime.time.now(),
      bindWithinMs: 10_000,
    });
    launchOptions.custodyTicket = JSON.stringify({
      runDir: runtime.paths.coral.coordinator.runDir,
      intentId: state.custodyIntent.id,
      processToken: state.custodyIntent.processToken,
      processGroupId: null,
      epoch: state.custodyIntent.epoch,
    });
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
    if (state.cleanupKey === null) throw launchError;
    while (true) {
      const disposition = await settleProviderResultContainment();
      if (disposition.kind === 'absence-confirmed') throw launchError;
      if (disposition.kind === 'operator-abandoned') throw launchError;
      enterContainmentHold(disposition.reason);
      await runtime.time.sleep(DURABLE_RUNTIME_POLL_INTERVAL_MS);
    }
  }
  if (state.publishedPid === null) {
    publishSpawned({
      runtimeRecord: durable.runtimeRecord,
      leaderIncarnation: durable.processSubject.incarnation,
      childRoot: durable.processSubject.childRoot,
      ...(durable.signalAuthority === undefined ? {} : { signalAuthority: durable.signalAuthority }),
    });
  } else if (state.publishedPid !== durable.pid) {
    throw new Error('Durable runtime readiness reported a different process from provisional publication.');
  }
  if (durable.signalAuthority !== undefined) {
    if (durable.signalAuthority.pid !== durable.pid) {
      throw new Error('Durable launch signal authority names a different process from launch readiness.');
    }
    state.signalAuthority = durable.signalAuthority;
  }

  return durable;
}

function cleanupDurableContainment(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  releaseCleanupOwnership: (absence: DurableContainmentAbsenceCapability) => CleanupOwnershipReleaseDisposition,
  enterContainmentHold: (reason: string) => void,
): Promise<DurableProcessCleanupOutcome> {
  const { runtime } = params;
  if (state.cleanupInFlight !== null) return state.cleanupInFlight;
  if (state.publishedPid === null || state.retainedProcess === null)
    throw new Error('Durable cleanup was requested before a process identity was published.');
  const pid = state.publishedPid;
  const cleanupRetention = state.retainedProcess;
  const generation = ++state.cleanupGeneration;
  const abortController = new AbortController();
  state.cleanupAbortController = abortController;
  const cleanupAttempt = resolveDurableProcessContainment(runtime, cleanupRetention, {
    kind: 'terminate',
    signalAuthority: state.signalAuthority,
    signal: abortController.signal,
  });
  state.unsettledCleanupAttempts.add(cleanupAttempt);
  const cleanupPromise = cleanupAttempt.then(
    (outcome) => {
      state.unsettledCleanupAttempts.delete(cleanupAttempt);
      if (generation !== state.cleanupGeneration || cleanupRetention !== state.retainedProcess) {
        return { kind: 'ownership-retained', pid, reason: 'durable containment cleanup was superseded' } as const;
      }
      if (outcome.kind === 'observed-absent') {
        const release = releaseCleanupOwnership(outcome);
        if (release.kind === 'retained') return { kind: 'ownership-retained', pid, reason: release.reason } as const;
      } else {
        const detail = terminationOutcomeDetail(outcome);
        enterContainmentHold(detail);
        if (detail !== state.lastUnsettledDetail) {
          backendLog.warn(`[durable-process:${pid}] Termination remains unsettled (${detail}).`);
          state.lastUnsettledDetail = detail;
        }
      }
      return outcome;
    },
    (error: unknown) => {
      state.unsettledCleanupAttempts.delete(cleanupAttempt);
      throw error;
    },
  );
  state.cleanupInFlight = cleanupPromise;
  void cleanupPromise.then(
    () => {
      if (state.cleanupInFlight === cleanupPromise) {
        state.cleanupInFlight = null;
        if (state.cleanupAbortController === abortController) state.cleanupAbortController = null;
      }
    },
    () => {
      if (state.cleanupInFlight === cleanupPromise) {
        state.cleanupInFlight = null;
        if (state.cleanupAbortController === abortController) state.cleanupAbortController = null;
      }
    },
  );
  return cleanupPromise;
}

function releaseDurableCleanupOwnership(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  absence: DurableContainmentAbsenceCapability,
  publishContainmentStatus: (status: DurableContainmentStatus) => DurableProcessPublicationDisposition,
  cleanup: DurableProcessCleanup,
): CleanupOwnershipReleaseDisposition {
  const { runtime, cleanupHandles, cleanupRetentions } = params;
  const { permit, abortRegistry } = params.ownership;
  if (state.cleanupKey === null) return { kind: 'released' };
  // Release requires proven absence; abandonment must not release a still-settling attempt.
  if (absence.retention !== state.retainedProcess) {
    return { kind: 'retained', reason: 'durable containment identity changed after absence observation' };
  }
  const wasHeld = state.providerResultHeld;
  if (wasHeld) {
    const publication = publishContainmentStatus({ kind: 'absence-confirmed' });
    if (publication.kind === 'retained') return publication;
  }
  state.cleanupAbortController?.abort();
  state.cleanupAbortController = null;
  state.cleanupGeneration += 1;
  cleanupHandles.delete(state.cleanupKey);
  cleanupRetentions.delete(cleanup);
  state.cleanupKey = null;
  if (state.cleanupRetryInterval !== null) {
    runtime.time.clearInterval(state.cleanupRetryInterval);
    state.cleanupRetryInterval = null;
  }
  state.containmentAbsenceConfirmed = true;
  abortRegistry.releaseHold(permit.jobId);
  state.resolveContainmentAbsence();
  state.lastUnsettledDetail = null;
  return { kind: 'released' };
}

function abandonDurableCleanupOwnership(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  publishContainmentStatus: (status: DurableContainmentStatus) => DurableProcessPublicationDisposition,
  cleanup: DurableProcessCleanup,
): AbortHoldDisposition {
  const { runtime, cleanupHandles, cleanupRetentions } = params;
  if (!state.providerResultHeld || state.cleanupKey === null) {
    return {
      kind: 'retained',
      reason: 'durable containment ownership is no longer held',
      nextStep: 'Inspect the job before retrying durable abandonment.',
    };
  }
  // A refusal must not destroy or release the cleanup attempt it declines to join.
  if (state.unsettledCleanupAttempts.size > 0) {
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
  state.cleanupAbortController?.abort();
  state.cleanupAbortController = null;
  state.cleanupGeneration += 1;
  cleanupHandles.delete(state.cleanupKey);
  cleanupRetentions.delete(cleanup);
  state.cleanupKey = null;
  if (state.cleanupRetryInterval !== null) {
    runtime.time.clearInterval(state.cleanupRetryInterval);
    state.cleanupRetryInterval = null;
  }
  state.containmentAbandoned = true;
  state.resolveContainmentAbsence();
  return {
    kind: 'abandoned',
    reason: 'job ownership was released without proof of process absence',
    nextStep: 'Inspect the recorded process because it may still be live.',
  };
}

function enterDurableContainmentHold(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  reason: string,
  transferPendingWrapperHold: () => void,
  operatorControl: DurableContainmentOperatorControl,
  publishContainmentStatus: (status: DurableContainmentStatus) => DurableProcessPublicationDisposition,
): boolean {
  const { permit, abortRegistry } = params.ownership;
  state.providerResultHeld = true;
  transferPendingWrapperHold();
  abortRegistry.hold(
    permit.jobId,
    reason,
    {
      detail: 'Explicitly abandon the durable containment hold only if unresolved process life is acceptable.',
      remedy: { kind: 'abort-job', jobId: permit.jobId },
    },
    operatorControl.abandon,
  );
  void publishContainmentStatus({
    kind: 'held',
    reason,
    retryIntervalMs: DURABLE_RUNTIME_POLL_INTERVAL_MS,
    abandonment: 'abort-job',
  });
  return (
    !state.containmentAbandoned &&
    !state.containmentAbsenceConfirmed &&
    state.cleanupKey !== null &&
    state.cleanupRetryInterval === null
  );
}

function publishDurableContainmentStatus(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  status: DurableContainmentStatus,
  operatorControl: DurableContainmentOperatorControl,
): DurableProcessPublicationDisposition {
  const { options } = params;
  const subject = state.publishedSubject ?? state.provisionalSubject;
  if (subject === null) return { kind: 'retained', reason: 'durable containment identity is unavailable' };
  const statusKey = JSON.stringify({ subject, status });
  if (statusKey === state.lastPublishedStatus) return { kind: 'published' };
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
    state.lastPublishedStatus = statusKey;
    return publication;
  } catch (error: unknown) {
    const reason = `durable containment publication failed: ${errorMessage(error)}`;
    backendLog.warn(`[durable-process:${subject.pid}] ${reason}`);
    return { kind: 'retained', reason };
  }
}

function publishDurableProcessIdentity(
  params: SpawnDurableJobTransportParams,
  subject: DurableCliProcessSubject | DurableProvisionalProcessSubject,
): void {
  const { options } = params;
  const disposition = options.onDurableProcessIdentity?.(subject) ?? { kind: 'published' as const };
  if (disposition.kind === 'retained') {
    throw new Error(`durable process identity publication retained: ${disposition.reason}`);
  }
}

function createDurablePendingWrapperControl(params: SpawnDurableJobTransportParams, state: DurableTransportState) {
  const { options, pendingLaunches } = params;
  const { permit, abortRegistry } = params.ownership;
  state.pendingSettlement = new Promise<void>((resolve) => {
    state.resolvePendingLaunch = resolve;
  });
  const pendingLaunch: PendingDurableLaunch = {
    get settled() {
      return state.pendingWrapperObligation?.settled ?? state.pendingSettlement;
    },
    retainedIdentity: () => ({
      kind: 'awaiting-wrapper-identity',
      owner: 'process-exit',
      provider: options.provider,
      jobDir: options.jobDir,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    }),
  };
  const releasePendingLaunch = (): void => {
    if (!state.pendingLaunchOwned) return;
    state.pendingLaunchOwned = false;
    pendingLaunches.delete(pendingLaunch);
    state.resolvePendingLaunch();
  };

  function retainPendingWrapperHold(generation: number, reason: string, nextStep: AbortNextStep): void {
    if (state.pendingWrapperHold?.generation !== generation) return;
    abortRegistry.hold(permit.jobId, reason, nextStep, () => retryPendingWrapperTermination(generation));
  }

  function settlePendingWrapperHold(generation: number): void {
    const hold = state.pendingWrapperHold;
    if (hold?.generation !== generation) return;
    state.pendingWrapperHold = null;
    state.pendingWrapperHoldGeneration += 1;
    releasePendingLaunch();
    hold.resolveSettled();
    abortRegistry.releaseHold(permit.jobId);
  }

  function retryPendingWrapperTermination(generation: number): Extract<AbortHoldDisposition, { kind: 'retained' }> {
    return retryDurablePendingWrapperTermination(
      params,
      state,
      generation,
      retainPendingWrapperHold,
      settlePendingWrapperHold,
    );
  }

  function enterPendingWrapperHold(obligation: DurablePendingLaunchObligation | null): void {
    enterDurablePendingWrapperHold(
      params,
      state,
      obligation,
      retainPendingWrapperHold,
      settlePendingWrapperHold,
      retryPendingWrapperTermination,
    );
  }

  function settleAnyPendingWrapperHold(): void {
    const hold = state.pendingWrapperHold;
    if (hold !== null) settlePendingWrapperHold(hold.generation);
  }

  async function awaitPendingWrapperHoldSettlement(): Promise<void> {
    const hold = state.pendingWrapperHold;
    if (hold !== null) await hold.settled;
  }

  const transferPendingWrapperHold = (): void => {
    const hold = state.pendingWrapperHold;
    if (hold === null) return;
    state.pendingWrapperHold = null;
    state.pendingWrapperHoldGeneration += 1;
    hold.resolveSettled();
  };
  pendingLaunches.add(pendingLaunch);

  const acceptPendingWrapper = (obligation: DurablePendingLaunchObligation): Readonly<{ kind: 'accepted' }> => {
    if (state.pendingWrapperObligation !== null && state.pendingWrapperObligation !== obligation) {
      throw new Error('Durable launch changed its pending wrapper obligation.');
    }
    state.pendingWrapperObligation = obligation;
    void obligation.settled.then(releasePendingLaunch);
    if (state.abortedBySignal) enterPendingWrapperHold(obligation);
    return { kind: 'accepted' };
  };

  return {
    releasePendingLaunch,
    enterPendingWrapperHold,
    settleAnyPendingWrapperHold,
    awaitPendingWrapperHoldSettlement,
    transferPendingWrapperHold,
    acceptPendingWrapper,
  };
}

function createDurableTransportAbortSignal(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
): AbortSignal | undefined {
  const { options, releaseLaunch } = params;
  const { ownership } = params;
  const { permit } = ownership;
  const transportAbortController = ownership.kind === 'internal' ? new AbortController() : null;
  const signal = transportAbortController?.signal ?? options.signal;
  if (ownership.kind === 'internal' && transportAbortController !== null) {
    ownership.abortRegistry.register(
      permit.jobId,
      () => transportAbortController.abort(),
      () => releaseLaunch(permit),
    );
    if (options.signal?.aborted === true) {
      transportAbortController.abort(options.signal.reason);
    } else if (options.signal !== undefined) {
      state.forwardExternalAbort = () => transportAbortController.abort(options.signal?.reason);
      options.signal.addEventListener('abort', state.forwardExternalAbort, { once: true });
    }
  }
  return signal;
}

async function runDurableTransportLaunch(
  params: SpawnDurableJobTransportParams,
  state: DurableTransportState,
  signal: AbortSignal | undefined,
  control: {
    acceptPendingWrapper: (obligation: DurablePendingLaunchObligation) => Readonly<{ kind: 'accepted' }>;
    publishWrapperSpawned: (launch: DurableWrapperSpawned) => void;
    publishSpawned: (launch: DurableReadySpawn) => void;
    enterPendingWrapperHold: (obligation: DurablePendingLaunchObligation | null) => void;
    enterContainmentHold: (reason: string) => void;
    operatorControl: DurableContainmentOperatorControl;
    settleProviderResultContainment: () => Promise<DurableProviderResultDisposition>;
    cleanup: DurableProcessCleanup;
    releasePendingLaunch: () => void;
    settleAnyPendingWrapperHold: () => void;
    awaitPendingWrapperHoldSettlement: () => Promise<void>;
  },
): Promise<CliExecResult> {
  const { options, releaseLaunch, ownership } = params;
  const { permit } = ownership;
  try {
    if (signal?.aborted) return { stdout: '', stderr: '', code: null, aborted: true };
    const durable = await executeDurableLaunch(
      params,
      state,
      signal,
      control.acceptPendingWrapper,
      control.publishWrapperSpawned,
      control.publishSpawned,
      control.enterPendingWrapperHold,
      control.enterContainmentHold,
      control.operatorControl,
      control.settleProviderResultContainment,
    );
    return await awaitDurableLaunchResult(
      params,
      state,
      durable,
      control.settleProviderResultContainment,
      control.enterContainmentHold,
      control.cleanup,
    );
  } finally {
    if (state.pendingWrapperObligation === null) {
      control.releasePendingLaunch();
      control.settleAnyPendingWrapperHold();
    }
    await control.awaitPendingWrapperHoldSettlement();
    if (state.abortHandler && signal) signal.removeEventListener('abort', state.abortHandler);
    if (state.forwardExternalAbort !== null) options.signal?.removeEventListener('abort', state.forwardExternalAbort);
    if (ownership.kind === 'internal') {
      void releaseLaunch(permit);
      ownership.abortRegistry.remove(permit.jobId);
    }
  }
}

export async function spawnDurableJobTransport(params: SpawnDurableJobTransportParams): Promise<CliExecResult> {
  const state = createDurableTransportState();
  const signal = createDurableTransportAbortSignal(params, state);
  state.containmentAbsence = new Promise<void>((resolve) => {
    state.resolveContainmentAbsence = resolve;
  });
  const {
    releasePendingLaunch,
    enterPendingWrapperHold,
    settleAnyPendingWrapperHold,
    awaitPendingWrapperHoldSettlement,
    transferPendingWrapperHold,
    acceptPendingWrapper,
  } = createDurablePendingWrapperControl(params, state);

  const releaseCleanupOwnership = (absence: DurableContainmentAbsenceCapability): CleanupOwnershipReleaseDisposition =>
    releaseDurableCleanupOwnership(params, state, absence, publishContainmentStatus, cleanup);

  const operatorControl: DurableContainmentOperatorControl = {
    retry: () => {
      void cleanup().catch(() => undefined);
    },
    abandon: () => abandonCleanupOwnership(),
  };

  const publishContainmentStatus = (status: DurableContainmentStatus): DurableProcessPublicationDisposition =>
    publishDurableContainmentStatus(params, state, status, operatorControl);
  const publishProcessIdentity = (subject: DurableCliProcessSubject | DurableProvisionalProcessSubject): void =>
    publishDurableProcessIdentity(params, subject);

  const abandonCleanupOwnership = (): AbortHoldDisposition =>
    abandonDurableCleanupOwnership(params, state, publishContainmentStatus, cleanup);

  const enterContainmentHold = (reason: string): void => {
    if (
      !enterDurableContainmentHold(
        params,
        state,
        reason,
        transferPendingWrapperHold,
        operatorControl,
        publishContainmentStatus,
      )
    ) {
      return;
    }
    state.cleanupRetryInterval = params.runtime.time.setInterval(() => {
      void cleanup().catch((error: unknown) => {
        backendLog.warn(
          `[durable-process:${state.publishedPid ?? 'unknown'}] Termination failed: ${errorMessage(error)}`,
        );
      });
    }, DURABLE_RUNTIME_POLL_INTERVAL_MS);
    state.cleanupRetryInterval.unref?.();
  };

  const cleanup = (): Promise<DurableProcessCleanupOutcome> =>
    cleanupDurableContainment(params, state, releaseCleanupOwnership, enterContainmentHold);

  const settleProviderResultContainment = (): Promise<DurableProviderResultDisposition> =>
    settleDurableProviderResultContainment(params, state, cleanup, releaseCleanupOwnership);

  const publishWrapperSpawned = (launch: DurableWrapperSpawned): void => {
    const initialRetention = prepareDurableWrapperPublication(params, state, launch);
    if (initialRetention === null) return;
    params.cleanupRetentions.set(cleanup, initialRetention);
    params.cleanupHandles.set(state.cleanupKey as symbol, cleanup);
    const setPublication = (publication: DurableProcessPublication): DurableProcessRetention => {
      state.retainedProcess = { ...initialRetention, publication };
      params.cleanupRetentions.set(cleanup, state.retainedProcess);
      return state.retainedProcess;
    };
    try {
      const runtimePublicationFailure = recordDurableRuntimePublication(
        params,
        launch,
        state.provisionalSubject as DurableProvisionalProcessSubject,
        setPublication,
      );
      publishProcessIdentity(state.provisionalSubject as DurableProvisionalProcessSubject);
      if (runtimePublicationFailure !== null) throw runtimePublicationFailure.error;
      if (state.abortedBySignal) {
        enterContainmentHold('termination requested; process absence is not yet proven');
        void cleanup().catch((error: unknown) => {
          backendLog.warn(`[durable-process:${launch.pid}] Termination failed: ${errorMessage(error)}`);
          enterContainmentHold(errorMessage(error));
        });
      }
    } finally {
      releasePendingLaunch();
    }
  };

  const publishSpawned = (launch: DurableReadySpawn): void => {
    publishWrapperSpawned(durableWrapperIdentityFromReady(launch));
    const cleanupNeedsRetargeting = retargetDurableReadySpawn(state, launch);
    if (launch.childRoot !== null && state.retainedProcess !== null) {
      params.cleanupRetentions.set(cleanup, state.retainedProcess);
      if (cleanupNeedsRetargeting) {
        // Superseding a cleanup attempt must not release its ownership before it settles.
        state.cleanupAbortController?.abort();
        state.cleanupInFlight = null;
        void cleanup().catch((error: unknown) => {
          backendLog.warn(`[durable-process:${launch.runtimeRecord.pid}] Termination failed: ${errorMessage(error)}`);
          enterContainmentHold(errorMessage(error));
        });
      }
    }
    if (state.publishedSubject !== null) publishProcessIdentity(state.publishedSubject);
  };

  return runDurableTransportLaunch(params, state, signal, {
    acceptPendingWrapper,
    publishWrapperSpawned,
    publishSpawned,
    enterPendingWrapperHold,
    enterContainmentHold,
    operatorControl,
    settleProviderResultContainment,
    cleanup,
    releasePendingLaunch,
    settleAnyPendingWrapperHold,
    awaitPendingWrapperHoldSettlement,
  });
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
