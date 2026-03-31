/** Claude provider adapter for the execution service. */

/** Appended to every spawned Claude subprocess to neutralize output-style hooks. */
export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

import { readFileSync } from 'node:fs';
import {
  executeClaudeOneShot,
  executeClaudeResume,
  executeClaudeFork,
  ClaudeExecParseError,
} from './claude-executor.js';
import { parseClaudeStreamJson } from './output-parser.js';
import { detectClaudeCli } from '../cli-detection.js';
import { resolveInjectMd } from '../inject.js';
import { extractClaudeProgressMessage } from './progress.js';
import { readAppendedLines } from '../../shared/file-tail.js';
import type { ProviderRequest, ProviderResult } from '../../shared/types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import {
  makeOnEvent,
  requireConversationRef,
  type Provider,
  type ProviderRecoveryContract,
  type ProviderRuntime,
} from '../types.js';
import type { EffortLevel } from '../../shared/schemas.js';
import type { ClaudeExecResult, ClaudeStreamEvent } from './types.js';

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

  const injectMd = resolveInjectMd(request.cwd, request.coralEnv?.CORAL_OWNER);
  if (injectMd) systemParts.push(injectMd);

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

const claudeRecovery: ProviderRecoveryContract = {
  async finalizeFromArtifacts({ stdoutPath, exitCode, signal, fallbackConversationRef }) {
    const stdout = readFileSync(stdoutPath, 'utf-8');
    const parsed = parseClaudeStreamJson(stdout);
    const aborted = signal !== null;
    if (!parsed.isError || parsed.response) {
      return mapResult(
        {
          response: parsed.response,
          sessionId: parsed.sessionId,
          model: parsed.model ?? '',
          durationMs: parsed.durationMs ?? 0,
          costUsd: parsed.costUsd,
          aborted,
        },
        fallbackConversationRef,
      );
    }
    // Fallback: raw content when stream-JSON parsing yields nothing useful
    return {
      content: stdout,
      exitCode,
      aborted,
      notice: signal ? `killed by ${signal}` : undefined,
    };
  },
  extractProgress({ stdoutPath, fromOffset }) {
    const { lines, newOffset } = readAppendedLines(stdoutPath, fromOffset);
    const messages = lines.flatMap((line) => {
      try {
        const event = JSON.parse(line) as ClaudeStreamEvent;
        const message = extractClaudeProgressMessage(event);
        return message ? [message] : [];
      } catch {
        return [];
      }
    });
    return { messages, newOffset };
  },
};

const TIER_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

function resolveModelCap(env: Record<string, string>): string {
  return env.CORAL_CLAUDE_MODEL_CAP ?? 'opus';
}

function capModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = resolveModelCap(env);
  if (!model) return model;
  const modelRank = TIER_RANK[model];
  const capRank = TIER_RANK[cap];
  if (modelRank === undefined || capRank === undefined) return model;
  return modelRank > capRank ? cap : model;
}

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const { prompt, systemPrompt } = buildClaudeArgs(request);
  const effort = request.effort as EffortLevel | undefined;
  const options = {
    model: capModel(request.model, request.coralEnv),
    workingDirectory: request.cwd,
    systemPrompt,
    effort,
    bypassPermissions: request.bypassPermissions,
    onEvent: makeOnEvent(runtime, request.sessionId, extractClaudeProgressMessage, request.cwd),
    runCli: runtime.runCli,
    environment: request.coralEnv,
  };

  try {
    switch (request.action) {
      case 'exec':
        return mapResult(await executeClaudeOneShot(prompt, options));
      case 'resume': {
        const conversationRef = requireConversationRef(request, 'resume');
        return mapResult(await executeClaudeResume(conversationRef, prompt, options), conversationRef);
      }
      case 'fork': {
        const conversationRef = requireConversationRef(request, 'fork');
        return mapResult(await executeClaudeFork(conversationRef, prompt, options));
      }
    }
  } catch (error) {
    return parseError(error, request.model ?? 'unknown');
  }

  const exhaustive: never = request.action;
  throw new Error(`Unsupported action: ${exhaustive}`);
}

export const claudeProvider: Provider = {
  name: 'claude',
  execute,
  preflight,
  recovery: claudeRecovery,
};
