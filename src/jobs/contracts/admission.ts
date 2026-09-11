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

/** Only the launch coordinator may mint or replace a permit; mutation callers must return the exact received generation. */
export type LaunchPermit = Readonly<{
  reservationId: string;
  jobId: string;
  pool: LaunchPool;
  provider: string;
  holder: PermitHolder;
  acquiredAt: number;
}>;

/** Diagnostic snapshots are observational only and must not authorize release or reclamation. */
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

type AdmittedHandle = {
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

/** Only `released` proves that this permit returned capacity; a transferred reservation remains occupied. */
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

type LaunchJobReclamationEvidence =
  | Readonly<{ kind: 'job-absent' }>
  | Readonly<{ kind: 'job-terminal'; phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'> }>;

export type ReclaimablePermitHolderKind = Exclude<PermitHolder['kind'], 'system-task' | 'queue-handoff'>;

type LaunchPermitReclamationEvidenceByHolder = Readonly<{
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

/** Reclamation may consume this evidence only for the exact current permit and its matching holder identity. */
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

/** A diagnostic may exist only after the exact reservation generation was reclaimed; refused probes must leave none. */
export type LaunchPermitReclamationDiagnostic = {
  [K in ReclaimablePermitHolderKind]: LaunchPermitReclamationDiagnosticBase &
    Readonly<{
      holder: Extract<PermitHolder, { kind: K }>;
      evidence: LaunchPermitReclamationEvidenceByHolder[K];
    }>;
}[ReclaimablePermitHolderKind];

type SettlementRefusalCause = 'terminal-persist-failed' | 'claim-release-failed' | 'claim-already-reassigned';

/** Only `quarantine: 'recorded'` permits callers to treat the refusal as durably contained. */
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
