import type { LaunchPool } from '../launch.js';

export type { LaunchPool } from '../launch.js';

export type LaunchPermit = { type: 'immediate' };

export type QueuedHandle = {
  outcome: 'queued';
  position: number;
  type: 'queued';
  queuePosition: number;
  waitForPermit: () => Promise<void>;
  cancel: () => void;
};

export type AdmittedHandle = {
  outcome: 'admitted';
  permit: LaunchPermit;
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
