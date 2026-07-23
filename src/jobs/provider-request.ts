import type { ProviderRequest } from '../providers/contract.js';
import { resolveEffort } from '../providers/request-policy.js';
import type { JobLaunch } from './records.js';

export function toProviderRequest(launchRecord: JobLaunch, conversationRef: string | undefined): ProviderRequest {
  if (launchRecord.jobKind !== 'provider') {
    throw new Error(`Job ${launchRecord.jobId} does not have a provider request.`);
  }
  const { providerAction, request, sessionId } = launchRecord;
  return {
    action: providerAction,
    sessionId,
    name: request.name,
    prompt: request.prompt,
    conversationRef,
    model: request.model,
    cwd: request.cwd,
    effort: resolveEffort(request.effort),
    bypassPermissions: request.bypassPermissions,
    systemPrompt: request.systemPrompt,
    instruction: request.instruction,
    coralEnv: request.coralEnv,
  };
}
