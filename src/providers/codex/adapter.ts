/** Codex provider adapter for the execution service. */

import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli, type CliInfo } from '../cli-detection.js';
import { extractProgressMessage } from './progress.js';
import type { ProviderRequest, ProviderResult } from '../../types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import { makeOnEvent, requireConversationRef, type Provider, type ProviderRuntime } from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';

/** Raw result type returned by Codex executors. */
type CodexRawResult = Awaited<ReturnType<typeof executeOneShot>>;

/** Abstract model tiers from agent frontmatter — all map to the default Codex model. */
const ABSTRACT_MODEL_TIERS = new Set(['opus', 'sonnet', 'haiku']);

function resolveModel(model: string | undefined): string | undefined {
  if (model !== undefined && ABSTRACT_MODEL_TIERS.has(model)) return undefined;
  return model;
}

let lastValidatedCli: (CliInfo & { available: true }) | undefined;

async function preflight(): Promise<void> {
  const cli = await detectCodexCli();
  if (!cli.available) throw new Error(`Codex CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Codex CLI unauthenticated: ${cli.authError}`);
  lastValidatedCli = cli;
}

function toProviderResult(result: CodexRawResult, fallbackConversationRef?: string): ProviderResult {
  return {
    ...mapProviderResultBase(result),
    conversationRef: result.sessionId ?? fallbackConversationRef,
    nonResumable: result.sessionId == null ? true : undefined,
    exitCode: result.exitCode,
    errors: result.errors.length > 0 ? result.errors : undefined,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  };
}

/**
 * Build the final prompt for Codex by prepending any instruction/systemPrompt.
 * Both channels map to prompt prepend (Codex has no system prompt flag).
 * For exec, executeOneShot will additionally wrap the result with CLAUDE.md.
 */
function buildPrompt(request: ProviderRequest): string {
  const parts: string[] = [];
  // Skip instruction on resume: Codex prepends to prompt (persisted in history),
  // unlike Claude which uses --append-system-prompt (re-injected each call).
  if (request.instruction && request.action !== 'resume') parts.push(request.instruction.content);
  if (request.systemPrompt) parts.push(request.systemPrompt);
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const prompt = buildPrompt(request);
  const effort = request.effort as EffortLevel | undefined;
  const options = {
    model: resolveModel(request.model),
    workingDirectory: request.cwd,
    effort,
    bypassSandbox: request.bypassPermissions,
    onEvent: makeOnEvent(runtime, request.sessionId, extractProgressMessage, request.cwd),
    signal: runtime.signal,
    preChecked: lastValidatedCli!,
    environment: request.coralEnv,
  };

  switch (request.action) {
    case 'exec': {
      // executeOneShot internally prepends CLAUDE.md to the prompt
      const result = await executeOneShot(prompt, options);
      return toProviderResult(result);
    }
    case 'resume': {
      const conversationRef = requireConversationRef(request, 'resume');
      const result = await executeResume(conversationRef, prompt, options);
      return toProviderResult(result, conversationRef);
    }
    case 'fork': {
      const conversationRef = requireConversationRef(request, 'fork');
      const result = await executeFork(conversationRef, prompt, options);
      return toProviderResult(result);
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
