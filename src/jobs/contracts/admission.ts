import type { ExecutionOwner } from '../../runtime/execution-owner.js';
import type { JobPhase } from '../phase.js';

/**
 * Pool selector for admission. Lives here because admission is the
 * contract that makes pool selection meaningful — launch records
 * propagate the selection but do not define it.
 */
export const LAUNCH_POOLS = ['default', 'discuss', 'curate'] as const;
export type LaunchPool = (typeof LAUNCH_POOLS)[number];

export type PermitHolder =
  | Readonly<{ kind: 'local-execution' }>
  | Readonly<{ kind: 'system-task'; id: string }>
  | Readonly<{ kind: 'proxy-operation'; operationId: string }>
  | Readonly<{ kind: 'recovery' }>
  | Readonly<{ kind: 'queue-handoff' }>;

export type LaunchPermit = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  holder: PermitHolder;
  acquiredAt: number;
}>;

export type LaunchPermitDiagnostic = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  holder: PermitHolder;
  executionOwner: ExecutionOwner;
  heldForMs: number;
}>;

export type QueueCancellation = Readonly<{ kind: 'cancelled' }> | Readonly<{ kind: 'admitted'; permit: LaunchPermit }>;

export type QueuedHandle = {
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<LaunchPermit>;
  /** Cancels only the reservation generation represented by this handle. */
  cancel: () => QueueCancellation;
};

export type AdmittedHandle = {
  type: 'immediate';
  permit: LaunchPermit;
};

export type AdmissionResult = AdmittedHandle | QueuedHandle | 'queue_full';
export type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

export type LaunchReservationView =
  | Readonly<{
      kind: 'queued';
      pool: LaunchPool;
      provider: string;
      executionOwner: ExecutionOwner;
      position: number;
    }>
  | Readonly<{
      kind: 'active';
      pool: LaunchPool;
      provider: string;
      executionOwner: ExecutionOwner;
      holder: PermitHolder;
      heldForMs: number;
    }>;

export type LaunchRelease =
  | Readonly<{ kind: 'released'; pool: LaunchPool; admittedNext: boolean }>
  | Readonly<{ kind: 'already-released'; pool: LaunchPool }>
  | Readonly<{ kind: 'transferred'; pool: LaunchPool; holder: PermitHolder }>;

export type LaunchReleaseDiagnostic = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  attemptedHolder: PermitHolder;
  disposition: Exclude<LaunchRelease, { kind: 'released' }>;
  observedAtMs: number;
}>;

export type LaunchPermitReclamationEvidence =
  | Readonly<{ kind: 'job-absent' }>
  | Readonly<{ kind: 'job-terminal'; phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'> }>;

/**
 * What the jobs layer answers when the coordinator asks whether a permit's work has ended. The
 * classification is made where job phase means something; `job-live` is a named answer so that a
 * probe which cannot decide is distinguishable from one that decided "keep holding".
 */
export type LaunchReclamationProbeResult = LaunchPermitReclamationEvidence | Readonly<{ kind: 'job-live' }>;

export type LaunchPermitReclamationDiagnostic = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  holder: PermitHolder;
  heldForMs: number;
  evidence: LaunchPermitReclamationEvidence;
  providerOperationEvidence?: Readonly<{ kind: 'absent'; operationId: string }>;
  reclaimedAtMs: number;
}>;

export type OperationBindingResult =
  | Readonly<{ kind: 'prepared' }>
  | Readonly<{ kind: 'bound'; successorPermit: LaunchPermit }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'settled-unbound' }>
  | Readonly<{ kind: 'settled'; reservationId: string }>
  | Readonly<{ kind: 'already-settled' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export type SettlementRefusalCause = 'terminal-persist-failed' | 'claim-release-failed' | 'claim-already-reassigned';

export type SettlementRefusal = Readonly<{
  kind: 'settlement-refused';
  cause: SettlementRefusalCause;
  quarantine: 'recorded' | 'recording-failed';
}>;

/** Persists durable recovery work left behind by a refused job settlement. */
export interface SettlementRefusalRecorder {
  record(
    input: Readonly<{
      jobId: string;
      cause: SettlementRefusalCause;
      failure: string;
    }>,
  ): boolean | Promise<boolean>;
}

export interface JobAdmissionPort {
  requestLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): AdmissionResult;
  releaseLaunch(permit: LaunchPermit): LaunchRelease;
  cancelQueued(jobId: string, pool: LaunchPool): boolean;
}

export interface JobQueueReadPort {
  queuePosition(jobId: string, pool: LaunchPool): number | null;
  getActiveJobIds(pool?: LaunchPool): string[];
  reservationFor(jobId: string): LaunchReservationView | null;
}

export interface JobLaunchRecoveryPort {
  restoreActiveLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): LaunchPermit;
  restoreQueuedLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): QueuedHandle;
}

export type LaunchCoordinatorPort = JobAdmissionPort & JobQueueReadPort & JobLaunchRecoveryPort;
