import type { JobKind, JobPhase, LaunchDecision, PersistedLaunchRecord, ProviderRequest } from '../shared/types.js';
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
  const { providerAction, request, sessionId } = launchRecord;
  return {
    action: providerAction,
    sessionId,
    name: request.name,
    prompt: request.prompt,
    conversationRef: request.conversationRef,
    model: request.model,
    cwd: request.cwd,
    effort: request.effort,
    bypassPermissions: request.bypassPermissions,
    systemPrompt: request.systemPrompt,
    instruction: request.instruction,
    coralEnv: request.coralEnv,
  };
}
