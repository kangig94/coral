/** Codex provider adapter for the execution service. */

import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli } from './cli-detection.js';
import { extractProgressMessage } from './progress.js';
import type { CodexThreadEvent } from './types.js';
import type { ProviderProgressEvent, ProviderRequest, ProviderResult } from '../../types.js';
import type { Provider, ProviderCapabilities, ProviderRuntime } from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';

const capabilities: ProviderCapabilities = { resumable: true, forkable: true };

async function preflight(): Promise<void> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(`Codex CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Codex CLI unauthenticated: ${cli.authError}`);
}

/**
 * Build the final prompt for Codex by prepending any instruction/systemPrompt.
 * Both channels map to prompt prepend (Codex has no system prompt flag).
 * For exec, executeOneShot will additionally wrap the result with CLAUDE.md.
 */
function buildPrompt(request: ProviderRequest): string {
  const parts: string[] = [];
  if (request.instruction) parts.push(request.instruction.content);
  if (request.systemPrompt) parts.push(request.systemPrompt);
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

function makeOnEvent(runtime: ProviderRuntime, jobId: string): (line: string) => void {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as CodexThreadEvent;
      const message = extractProgressMessage(event);
      if (!message) return;
      const progressEvent: ProviderProgressEvent = { jobId, message, ts: new Date().toISOString() };
      runtime.onEvent(progressEvent);
    } catch {
      /* ignore non-JSON or unparseable lines */
    }
  };
}

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const prompt = buildPrompt(request);
  const effort = request.effort as EffortLevel | undefined;

  switch (request.action) {
    case 'exec': {
      // executeOneShot internally prepends CLAUDE.md to the prompt
      const result = await executeOneShot(
        prompt,
        request.model,
        request.cwd,
        effort,
        request.bypassPermissions,
        makeOnEvent(runtime, request.sessionId),
        runtime.signal,
      );
      return {
        text: result.response,
        conversationRef: result.sessionId ?? undefined,
        model: result.model,
        durationMs: result.durationMs,
        aborted: result.aborted || undefined,
        nonResumable: result.sessionId == null ? true : undefined,
        exitCode: result.exitCode,
        errors: result.errors.length > 0 ? result.errors : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    }
    case 'resume': {
      if (!request.conversationRef) throw new Error('resume requires conversationRef');
      const result = await executeResume(
        request.conversationRef,
        prompt,
        request.model,
        request.cwd,
        effort,
        request.bypassPermissions,
        makeOnEvent(runtime, request.sessionId),
        runtime.signal,
      );
      return {
        text: result.response,
        conversationRef: result.sessionId ?? request.conversationRef,
        model: result.model,
        durationMs: result.durationMs,
        aborted: result.aborted || undefined,
        exitCode: result.exitCode,
        errors: result.errors.length > 0 ? result.errors : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    }
    case 'fork': {
      if (!request.conversationRef) throw new Error('fork requires conversationRef');
      const result = await executeFork(
        request.conversationRef,
        prompt,
        request.model,
        request.cwd,
        effort,
        request.bypassPermissions,
        makeOnEvent(runtime, request.sessionId),
        runtime.signal,
      );
      return {
        text: result.response,
        conversationRef: result.sessionId ?? undefined,
        model: result.model,
        durationMs: result.durationMs,
        aborted: result.aborted || undefined,
        nonResumable: result.sessionId == null ? true : undefined,
        exitCode: result.exitCode,
        errors: result.errors.length > 0 ? result.errors : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    }
  }

  const exhaustive: never = request.action;
  throw new Error(`Unsupported action: ${exhaustive}`);
}

export const codexProvider: Provider = {
  name: 'codex',
  capabilities,
  execute,
  preflight,
};
