import type { LaunchDecision, LaunchPool } from '../launch.js';
import type { JobPhase } from '../phase.js';
import type { JobKind, JobLaunch } from '../records.js';
import type { ProviderRequest } from '../../providers/contract.js';
import { resolveEffort } from '../../providers/request-policy.js';
import type { JobRuntime } from '../records.js';

export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;
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

export type AdmissionResult =
  | {
      outcome: 'admitted';
      permit: LaunchPermit;
      type: 'immediate';
    }
  | QueuedHandle
  | 'queue_full';

export type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

export interface LaunchCoordinator {
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

export type ClaimJobOptions = {
  expectedVersion?: number;
  initialPhase?: Extract<JobPhase, 'queued' | 'launching'>;
  jobKind?: JobKind;
};

export class SessionClaimError extends Error {
  constructor() {
    super('Session claim failed');
    this.name = 'SessionClaimError';
  }
}

export function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
  };
}

export function toProviderRequest(launchRecord: JobLaunch): ProviderRequest {
  const { providerAction, request, sessionId, projectRoot } = launchRecord;
  return {
    action: providerAction,
    sessionId,
    name: request.name,
    prompt: request.prompt,
    conversationRef: request.conversationRef,
    model: request.model,
    cwd: request.cwd ?? projectRoot,
    effort: resolveEffort(request.effort),
    bypassPermissions: request.bypassPermissions,
    systemPrompt: request.systemPrompt,
    instruction: request.instruction,
    coralEnv: request.coralEnv,
  };
}
