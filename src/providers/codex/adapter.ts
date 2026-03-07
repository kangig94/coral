/** Codex provider adapter for the execution service. */

import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli, type CliInfo } from '../cli-detection.js';
import { extractProgressMessage } from './progress.js';
import type { ProviderRequest, ProviderResult } from '../../types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import { makeOnEvent, type Provider, type ProviderRuntime } from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';

let lastValidatedCli: (CliInfo & { available: true }) | undefined;

async function preflight(): Promise<void> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(`Codex CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Codex CLI unauthenticated: ${cli.authError}`);
  lastValidatedCli = cli;
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

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const prompt = buildPrompt(request);
  const effort = request.effort as EffortLevel | undefined;

  switch (request.action) {
    case 'exec': {
      // executeOneShot internally prepends CLAUDE.md to the prompt
      const result = await executeOneShot(prompt, {
        model: request.model,
        workingDirectory: request.cwd,
        effort,
        bypassSandbox: request.bypassPermissions,
        onEvent: makeOnEvent(runtime, request.sessionId, extractProgressMessage, request.cwd),
        signal: runtime.signal,
        preChecked: lastValidatedCli!,
      });
      return {
        ...mapProviderResultBase(result),
        conversationRef: result.sessionId ?? undefined,
        nonResumable: result.sessionId == null ? true : undefined,
        exitCode: result.exitCode,
        errors: result.errors.length > 0 ? result.errors : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    }
    case 'resume': {
      if (!request.conversationRef) throw new Error('resume requires conversationRef');
      const result = await executeResume(request.conversationRef, prompt, {
        model: request.model,
        workingDirectory: request.cwd,
        effort,
        bypassSandbox: request.bypassPermissions,
        onEvent: makeOnEvent(runtime, request.sessionId, extractProgressMessage, request.cwd),
        signal: runtime.signal,
        preChecked: lastValidatedCli!,
      });
      return {
        ...mapProviderResultBase(result),
        conversationRef: result.sessionId ?? request.conversationRef,
        exitCode: result.exitCode,
        errors: result.errors.length > 0 ? result.errors : undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    }
    case 'fork': {
      if (!request.conversationRef) throw new Error('fork requires conversationRef');
      const result = await executeFork(request.conversationRef, prompt, {
        model: request.model,
        workingDirectory: request.cwd,
        effort,
        bypassSandbox: request.bypassPermissions,
        onEvent: makeOnEvent(runtime, request.sessionId, extractProgressMessage, request.cwd),
        signal: runtime.signal,
        preChecked: lastValidatedCli!,
      });
      return {
        ...mapProviderResultBase(result),
        conversationRef: result.sessionId ?? undefined,
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
  execute,
  preflight,
};
