import type { ProviderRequest } from '../../shared/types.js';
import type { ProviderServerSpec } from '../types.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

const ABSTRACT_MODEL_TIERS = new Set(['opus', 'sonnet', 'haiku']);

export function resolveCodexModel(model: string | undefined): string | undefined {
  if (model !== undefined && ABSTRACT_MODEL_TIERS.has(model)) {
    return undefined;
  }
  return model;
}

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

export function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function buildCodexProviderServerSpec(
  projectRoot: string,
  env?: Record<string, string>,
): ProviderServerSpec {
  return {
    provider: 'codex',
    key: `codex:${projectRoot}`,
    command: 'codex',
    args: ['app-server'],
    cwd: projectRoot,
    env,
  };
}

export function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

export function mapThreadStartParams(request: ProviderRequest): ThreadStartParams {
  return {
    cwd: request.cwd ?? process.cwd(),
    model: resolveCodexModel(request.model) ?? null,
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ephemeral: false,
  };
}

export function mapThreadResumeParams(request: ProviderRequest, threadId: string): ThreadResumeParams {
  return {
    threadId,
    cwd: request.cwd ?? process.cwd(),
    model: resolveCodexModel(request.model) ?? null,
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
  };
}

export function mapTurnStartParams(request: ProviderRequest, threadId: string): TurnStartParams {
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model: resolveCodexModel(request.model),
    effort: request.effort,
  };
}
