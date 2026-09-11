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
  | Readonly<{ kind: 'undecided-provider-operation'; recordKeys: readonly string[] }>
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
      reservationId: string;
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

export type LaunchJobReclamationEvidence =
  | Readonly<{ kind: 'job-absent' }>
  | Readonly<{ kind: 'job-terminal'; phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'> }>;

export type ReclaimablePermitHolderKind = Exclude<PermitHolder['kind'], 'system-task' | 'queue-handoff'>;

export type LaunchPermitReclamationEvidenceByHolder = Readonly<{
  'local-execution': LaunchJobReclamationEvidence;
  recovery: LaunchJobReclamationEvidence;
  'proxy-operation': Readonly<{
    kind: 'provider-operation-absent';
    operationId: string;
    jobEvidence: LaunchJobReclamationEvidence;
  }>;
  'undecided-provider-operation': Readonly<{
    kind: 'provider-operation-records-absent';
    recordKeys: readonly string[];
    jobEvidence: LaunchJobReclamationEvidence;
  }>;
}>;

export type LaunchPermitReclamationEvidence =
  LaunchPermitReclamationEvidenceByHolder[keyof LaunchPermitReclamationEvidenceByHolder];

/** Evidence that does not authorize reclamation must return `job-live`. */
export type LaunchReclamationProbeResult<K extends ReclaimablePermitHolderKind> =
  | LaunchPermitReclamationEvidenceByHolder[K]
  | Readonly<{ kind: 'job-live' }>;

type LaunchPermitReclamationDiagnosticBase = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  heldForMs: number;
  reclaimedAtMs: number;
}>;

export type LaunchPermitReclamationDiagnostic = {
  [K in ReclaimablePermitHolderKind]: LaunchPermitReclamationDiagnosticBase &
    Readonly<{
      holder: Extract<PermitHolder, { kind: K }>;
      evidence: LaunchPermitReclamationEvidenceByHolder[K];
    }>;
}[ReclaimablePermitHolderKind];

export type SettlementRefusalCause = 'terminal-persist-failed' | 'claim-release-failed' | 'claim-already-reassigned';

export type SettlementRefusal = Readonly<{
  kind: 'settlement-refused';
  cause: SettlementRefusalCause;
  quarantine: 'recorded' | 'recording-failed';
}>;

/** A caller may treat a settlement refusal as durably contained only after `record` resolves `true`. */
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
}

export interface JobQueueReadPort {
  queuePosition(jobId: string, pool: LaunchPool): number | null;
  getActiveJobIds(pool?: LaunchPool): string[];
  reservationFor(jobId: string): LaunchReservationView | null;
}

export interface JobLaunchRecoveryPort {
  restoreActiveLaunch(
    jobId: string,
    provider: string,
    executionOwner: ExecutionOwner,
    pool: LaunchPool,
    holder?: Extract<PermitHolder, { kind: 'recovery' | 'undecided-provider-operation' }>,
  ): LaunchPermit;
  restoreQueuedLaunch(jobId: string, provider: string, executionOwner: ExecutionOwner, pool: LaunchPool): QueuedHandle;
  holdUndecidedProviderOperationLaunch(permit: LaunchPermit, recordKeys: readonly string[]): LaunchPermit | null;
  reclaimLaunchPermit(permit: LaunchPermit): boolean;
}

export type LaunchCoordinatorPort = JobAdmissionPort & JobQueueReadPort & JobLaunchRecoveryPort;
