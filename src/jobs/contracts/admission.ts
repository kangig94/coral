import type { LaunchPool } from '../launch.js';

// LaunchPool's canonical home is `jobs/launch.ts`, but the admission contract
// re-exports it so coordinator-side consumers can stay on the contract seam
// (see `tests/invariants/coordinator-topology.test.ts` CONTRACT_TARGETS).
export type { LaunchPool };

export type QueuedHandle = {
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<void>;
  cancel: () => void;
};

export type AdmittedHandle = {
  type: 'immediate';
};

export type AdmissionResult = AdmittedHandle | QueuedHandle | 'queue_full';
export type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

export interface JobAdmissionPort {
  requestLaunch(jobId: string, provider: string, pool?: LaunchPool): AdmissionResult;
  releaseLaunch(jobId: string, pool?: LaunchPool): void;
  cancelQueued(jobId: string, pool?: LaunchPool): boolean;
  bindLaunchPermit(jobId: string, signal: AbortSignal, pool?: LaunchPool): void;
}

export interface JobQueueReadPort {
  queuePosition(jobId: string, pool?: LaunchPool): number | null;
  getActiveJobIds(pool?: LaunchPool): string[];
}

export interface JobLaunchRecoveryPort {
  restoreActiveLaunch(jobId: string, provider: string, pool?: LaunchPool): void;
  restoreQueuedLaunch(jobId: string, provider: string, pool?: LaunchPool): QueuedHandle;
}

export type LaunchCoordinatorPort = JobAdmissionPort & JobQueueReadPort & JobLaunchRecoveryPort;
