import type { ProviderRequest } from '../providers/contract.js';
import { resolveEffort } from '../providers/request-policy.js';
import type { JobLaunch } from './records.js';

export function toProviderRequest(launchRecord: JobLaunch): ProviderRequest {
  const { providerAction, request, sessionId, projectRoot } = launchRecord;
  if (launchRecord.jobKind === 'kb' || sessionId === null || launchRecord.provider === null) {
    throw new Error(`Job ${launchRecord.jobId} does not have a provider request.`);
  }
  return {
    action: providerAction ?? 'exec',
    sessionId,
    name: request.name,
    prompt: request.prompt ?? '',
    conversationRef: request.conversationRef,
    model: request.model,
    cwd: request.cwd ?? projectRoot,
    effort: resolveEffort(request.effort),
    bypassPermissions: request.bypassPermissions ?? false,
    systemPrompt: request.systemPrompt,
    instruction: request.instruction,
    coralEnv: request.coralEnv ?? {},
  };
}
