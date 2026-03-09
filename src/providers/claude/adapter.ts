/** Claude provider adapter for the execution service. */

/** Appended to every spawned Claude subprocess to neutralize output-style hooks. */
export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

import {
  executeClaudeOneShot,
  executeClaudeResume,
  executeClaudeFork,
  ClaudeExecParseError,
} from './claude-executor.js';
import { detectClaudeCli } from '../cli-detection.js';
import { extractClaudeProgressMessage } from './progress.js';
import type { ProviderRequest, ProviderResult } from '../../types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import { makeOnEvent, type Provider, type ProviderRuntime } from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';
import type { ClaudeExecResult } from './types.js';

async function preflight(): Promise<void> {
  const cli = await detectClaudeCli();
  if (!cli.available) throw new Error(`Claude CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Claude CLI unauthenticated: ${cli.authError}`);
}

/**
 * Build the Claude --append-system-prompt value and final prompt from ProviderRequest.
 *
 * - instruction.channel === 'system': combined system = [instruction.content, systemPrompt].join('\n\n')
 * - instruction.channel === 'prompt': instruction prepended to prompt; systemPrompt separate
 * - No instruction: systemPrompt only
 */
function buildClaudeArgs(request: ProviderRequest): { prompt: string; systemPrompt?: string } {
  const systemParts: string[] = [];
  let prompt = request.prompt;

  if (request.instruction) {
    if (request.instruction.channel === 'system') {
      systemParts.push(request.instruction.content);
    } else {
      prompt = `${request.instruction.content}\n\n---\n\n${request.prompt}`;
    }
  }

  if (request.systemPrompt) {
    systemParts.push(request.systemPrompt);
  }

  // Override any output-style injected by the parent session's hooks.
  systemParts.push(OUTPUT_STYLE_OVERRIDE);

  return {
    prompt,
    systemPrompt: systemParts.join('\n\n'),
  };
}

function mapResult(result: ClaudeExecResult, fallbackConversationRef?: string): ProviderResult {
  return {
    ...mapProviderResultBase(result),
    conversationRef: result.sessionId ?? fallbackConversationRef,
    nonResumable: result.sessionId == null ? true : undefined,
    usage: result.costUsd != null ? { costUsd: result.costUsd } : undefined,
  };
}

function parseError(error: unknown, fallbackModel: string): ProviderResult {
  if (error instanceof ClaudeExecParseError) {
    return {
      content: '',
      notice: 'Claude CLI returned non-JSON output; result is non-resumable.',
      nonResumable: true,
      model: fallbackModel,
      exitCode: error.failure.exitCode,
      errors: [error.failure],
    };
  }
  throw error;
}

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const { prompt, systemPrompt } = buildClaudeArgs(request);
  const effort = request.effort as EffortLevel | undefined;
  const onEvent = makeOnEvent(runtime, request.sessionId, extractClaudeProgressMessage, request.cwd);

  switch (request.action) {
    case 'exec': {
      try {
        const result = await executeClaudeOneShot(prompt, {
          model: request.model,
          workingDirectory: request.cwd,
          systemPrompt,
          effort,
          bypassPermissions: request.bypassPermissions,
          signal: runtime.signal,
          onEvent,
        });
        return mapResult(result);
      } catch (error) {
        return parseError(error, request.model ?? 'unknown');
      }
    }
    case 'resume': {
      if (!request.conversationRef) throw new Error('resume requires conversationRef');
      try {
        const result = await executeClaudeResume(request.conversationRef, prompt, {
          model: request.model,
          workingDirectory: request.cwd,
          systemPrompt,
          effort,
          bypassPermissions: request.bypassPermissions,
          signal: runtime.signal,
          onEvent,
        });
        return mapResult(result, request.conversationRef);
      } catch (error) {
        return parseError(error, request.model ?? 'unknown');
      }
    }
    case 'fork': {
      if (!request.conversationRef) throw new Error('fork requires conversationRef');
      try {
        const result = await executeClaudeFork(request.conversationRef, prompt, {
          model: request.model,
          workingDirectory: request.cwd,
          systemPrompt,
          effort,
          bypassPermissions: request.bypassPermissions,
          signal: runtime.signal,
          onEvent,
        });
        return mapResult(result);
      } catch (error) {
        return parseError(error, request.model ?? 'unknown');
      }
    }
  }

  const exhaustive: never = request.action;
  throw new Error(`Unsupported action: ${exhaustive}`);
}

export const claudeProvider: Provider = {
  name: 'claude',
  execute,
  preflight,
};
