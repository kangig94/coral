/** Claude provider adapter for the execution service. */

import {
  executeClaudeOneShot,
  executeClaudeResume,
  executeClaudeFork,
  ClaudeExecParseError,
} from './claude-executor.js';
import { detectClaudeCli } from './cli-detection.js';
import { extractClaudeProgressMessage } from './progress.js';
import type { ClaudeStreamEvent } from './types.js';
import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../../types.js';
import type { Provider, ProviderCapabilities, ProviderRuntime } from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';

const capabilities: ProviderCapabilities = { resumable: true, forkable: true };

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

  return {
    prompt,
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

function makeOnEvent(runtime: ProviderRuntime, jobId: string, projectRoot?: string): (line: string) => void {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as ClaudeStreamEvent;
      const message = extractClaudeProgressMessage(event, projectRoot);
      if (!message) return;
      const progressEvent: ProviderProgressEvent = { jobId, message, ts: new Date().toISOString() };
      runtime.onEvent(progressEvent);
    } catch {
      /* ignore non-JSON or unparseable lines */
    }
  };
}

function parseError(error: unknown, fallbackModel: string): ProviderResult {
  if (error instanceof ClaudeExecParseError) {
    return {
      text: '',
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
  const onEvent = makeOnEvent(runtime, request.sessionId, request.cwd);

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
        return {
          text: result.response,
          conversationRef: result.sessionId ?? undefined,
          model: result.model,
          durationMs: result.durationMs,
          aborted: result.aborted || undefined,
          nonResumable: result.sessionId == null ? true : undefined,
          usage: result.costUsd != null ? { costUsd: result.costUsd } : undefined,
        };
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
        return {
          text: result.response,
          conversationRef: result.sessionId ?? request.conversationRef,
          model: result.model,
          durationMs: result.durationMs,
          aborted: result.aborted || undefined,
          nonResumable: result.sessionId == null ? true : undefined,
          usage: result.costUsd != null ? { costUsd: result.costUsd } : undefined,
        };
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
        return {
          text: result.response,
          conversationRef: result.sessionId ?? undefined,
          model: result.model,
          durationMs: result.durationMs,
          aborted: result.aborted || undefined,
          nonResumable: result.sessionId == null ? true : undefined,
          usage: result.costUsd != null ? { costUsd: result.costUsd } : undefined,
        };
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
  capabilities,
  execute,
  preflight,
};
