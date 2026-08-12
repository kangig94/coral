import type { ProviderRequest } from '../providers/contract.js';
import { resolveEffort } from '../providers/request-policy.js';
import type { JobLaunch } from './records.js';
import { canonicalizeWorkDir } from '../runtime/canonical-work-dir.js';

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
    cwd: canonicalizeWorkDir(request.cwd, launchRecord.projectRoot),
    effort: resolveEffort(request.effort),
    bypassPermissions: request.bypassPermissions,
    systemPrompt: request.systemPrompt,
    instruction: request.instruction,
    coralEnv: request.coralEnv,
  };
}
