import { spawnCli } from '../../runner/engine.js';
import { isRecord } from '../../shared/mcp-utils.js';
import type { ClaudeExecFailure, ClaudeExecResult, ClaudeJsonOutput } from './types.js';

export type ClaudeExecOptions = {
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  sessionId?: string;
  bypassPermissions?: boolean;
  signal?: AbortSignal;
};

export class ClaudeExecParseError extends Error {
  readonly failure: ClaudeExecFailure;

  constructor(failure: ClaudeExecFailure) {
    super(`Claude CLI returned non-JSON output: ${failure.parseError}`);
    this.name = 'ClaudeExecParseError';
    this.failure = failure;
  }
}

export async function executeClaudeOneShot(
  prompt: string,
  options: ClaudeExecOptions = {},
): Promise<ClaudeExecResult> {
  const args = ['-p', '--output-format', 'json'];
  if (options.bypassPermissions) args.push('--dangerously-skip-permissions');
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return executeClaude(args, prompt, options);
}

export async function executeClaudeResume(
  sessionId: string,
  prompt: string,
  options: Omit<ClaudeExecOptions, 'sessionId'> = {},
): Promise<ClaudeExecResult> {
  const args = ['-p', '--output-format', 'json', '--resume', sessionId];
  if (options.bypassPermissions) args.push('--dangerously-skip-permissions');
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
  return executeClaude(args, prompt, options);
}

async function executeClaude(
  args: string[],
  prompt: string,
  options: Omit<ClaudeExecOptions, 'sessionId'>,
): Promise<ClaudeExecResult> {
  const start = Date.now();
  const { stdout, stderr, code, aborted } = await spawnCli({
    provider: 'claude',
    command: 'claude',
    args,
    prompt,
    cwd: options.workingDirectory,
    signal: options.signal,
  });

  let parsed: ClaudeJsonOutput;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonOutput;
  } catch (error: unknown) {
    throw new ClaudeExecParseError({
      exitCode: code,
      stdout,
      stderr,
      parseError: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    response: extractResponseText(parsed),
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    model: extractModel(parsed, options.model),
    durationMs: Date.now() - start,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : 0,
    aborted,
  };
}

function extractModel(parsed: ClaudeJsonOutput, fallbackModel: string | undefined): string {
  if (typeof parsed.model === 'string' && parsed.model) return parsed.model;
  const resultRecord = isRecord(parsed.result) ? parsed.result : null;
  if (typeof resultRecord?.model === 'string' && resultRecord.model) return resultRecord.model;
  return fallbackModel ?? 'unknown';
}

function extractResponseText(parsed: ClaudeJsonOutput): string {
  if (typeof parsed.result === 'string') return parsed.result;
  if (isRecord(parsed.result)) {
    if (typeof parsed.result.response === 'string') return parsed.result.response;
    if (typeof parsed.result.output_text === 'string') return parsed.result.output_text;
    if (Array.isArray(parsed.result.content)) {
      const textParts = parsed.result.content
        .map((item: unknown) => (isRecord(item) && typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean);
      if (textParts.length > 0) return textParts.join('\n');
    }
  }
  return '';
}

