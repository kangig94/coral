import type { LaunchDecision } from '../launch.js';
import type { JobPhase } from '../phase.js';
import type { JobKind, JobLaunchRecord } from '../records.js';
import type { ProviderRequest } from '../../providers/protocol.js';
import { resolveEffort } from '../../shared/schemas.js';
import type { AdmissionResult } from '../../coordinator/live/admission.js';

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

export function toProviderRequest(launchRecord: JobLaunchRecord): ProviderRequest {
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
