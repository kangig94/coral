/**
 * Pool selector for admission. Lives here because admission is the
 * contract that makes pool selection meaningful — launch records
 * propagate the selection but do not define it.
 */
export type LaunchPool = 'default' | 'discuss' | 'curate';

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
