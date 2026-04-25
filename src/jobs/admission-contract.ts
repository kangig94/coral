import type { JobRuntime } from './records.js';
import type { LaunchPool } from './launch.js';

export type { LaunchPool } from './launch.js';

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

export interface LaunchCoordinatorPort {
  requestLaunch(jobId: string, provider: string, pool?: LaunchPool): AdmissionResult;
  releaseLaunch(jobId: string, pool?: LaunchPool): void;
  cancelQueued(jobId: string, pool?: LaunchPool): boolean;
  queuePosition(jobId: string, pool?: LaunchPool): number | null;
  getActiveJobIds(pool?: LaunchPool): string[];
  bindLaunchPermit(jobId: string, signal: AbortSignal, pool?: LaunchPool): void;
  spawnDurableJob(options: {
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
    jobDir: string;
    onRuntimeRecord?: (record: JobRuntime) => void;
  }): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    aborted: boolean;
  }>;
  restoreActiveLaunch(jobId: string, provider: string, pool?: LaunchPool): void;
  restoreQueuedLaunch(jobId: string, provider: string, pool?: LaunchPool): QueuedHandle;
}
