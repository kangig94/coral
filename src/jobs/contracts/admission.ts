import type { ExecutionOwner } from '../../runtime/execution-owner.js';

/**
 * Pool selector for admission. Lives here because admission is the
 * contract that makes pool selection meaningful — launch records
 * propagate the selection but do not define it.
 */
export const LAUNCH_POOLS = ['default', 'discuss', 'curate'] as const;
export type LaunchPool = (typeof LAUNCH_POOLS)[number];

export type QueuedHandle = {
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<void>;
  /** Cancels only the reservation generation represented by this handle. */
  cancel: () => boolean;
};

export type AdmittedHandle = {
  type: 'immediate';
};

export type AdmissionResult = AdmittedHandle | QueuedHandle | 'queue_full';
export type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

export interface JobAdmissionPort {
  requestLaunch(jobId: string, provider: string, owner: ExecutionOwner, pool?: LaunchPool): AdmissionResult;
  releaseLaunch(jobId: string, pool?: LaunchPool): void;
  cancelQueued(jobId: string, pool?: LaunchPool): boolean;
}

export interface JobQueueReadPort {
  queuePosition(jobId: string, pool?: LaunchPool): number | null;
  getActiveJobIds(pool?: LaunchPool): string[];
}

export interface JobLaunchRecoveryPort {
  restoreActiveLaunch(jobId: string, provider: string, owner: ExecutionOwner, pool?: LaunchPool): void;
  restoreQueuedLaunch(jobId: string, provider: string, owner: ExecutionOwner, pool?: LaunchPool): QueuedHandle;
}

export type LaunchCoordinatorPort = JobAdmissionPort & JobQueueReadPort & JobLaunchRecoveryPort;
