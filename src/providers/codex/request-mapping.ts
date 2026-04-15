import type { ProviderRequest } from '../../shared/types.js';
import { resolveModelTier, type EffortLevel } from '../../shared/schemas.js';
import type { ProviderServerSpec } from '../types.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

export function buildCodexPrompt(request: Pick<ProviderRequest, 'action' | 'instruction' | 'systemPrompt' | 'prompt'>): string {
  const parts: string[] = [];
  if (request.action !== 'resume' && request.instruction) {
    parts.push(request.instruction.content);
  }
  if (request.systemPrompt) {
    parts.push(request.systemPrompt);
  }
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

const CODEX_EFFORT: Record<EffortLevel, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function buildCodexProviderServerSpec(
  projectRoot: string,
  env?: Record<string, string>,
  clientVersion?: string,
): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: projectRoot,
    env,
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral', version: clientVersion ?? 'unknown' } },
    },
  };
}

export function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4';

function resolveCodexModel(requestModel: string | undefined): string {
  return resolveModelTier(requestModel) ?? process.env.CORAL_CODEX_MODEL ?? DEFAULT_CODEX_MODEL;
}

export function mapThreadStartParams(request: ProviderRequest): ThreadStartParams {
  return {
    cwd: request.cwd,
    model: resolveCodexModel(request.model),
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ephemeral: false,
  };
}

export function mapThreadResumeParams(request: ProviderRequest, threadId: string): ThreadResumeParams {
  return {
    threadId,
    cwd: request.cwd,
    model: resolveCodexModel(request.model),
    approvalPolicy: 'never',
    // Codex merge_persisted_resume_metadata() does not restore sandbox from stored
    // ThreadMetadata — omitting sandbox causes a downgrade to the config default (read-only).
    sandbox: resolveCodexSandbox(request.bypassPermissions),
  };
}

export function mapTurnStartParams(request: ProviderRequest, threadId: string): TurnStartParams {
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model: resolveCodexModel(request.model),
    effort: CODEX_EFFORT[request.effort],
  };
}
