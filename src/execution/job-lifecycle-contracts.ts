import type {
  JobKind,
  JobPhase,
  LaunchDecision,
  PersistedLaunchRecord,
  ProviderRequest,
} from '../shared/types.js';
import type { AdmissionResult } from './engine.js';

export const QUEUED_ABORT_MESSAGE = 'Aborted while queued.';
export const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;

export type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

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

export function toProviderRequest(launchRecord: PersistedLaunchRecord): ProviderRequest {
  return {
    action: launchRecord.providerAction,
    sessionId: launchRecord.sessionId,
    name: launchRecord.request.name,
    prompt: launchRecord.request.prompt,
    conversationRef: launchRecord.request.conversationRef,
    model: launchRecord.request.model,
    cwd: launchRecord.request.cwd,
    effort: launchRecord.request.effort,
    bypassPermissions: launchRecord.request.bypassPermissions,
    systemPrompt: launchRecord.request.systemPrompt,
    instruction: launchRecord.request.instruction,
    coralEnv: launchRecord.request.coralEnv,
  };
}
