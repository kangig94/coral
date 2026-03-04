import { spawnCli } from '../../runner/engine.js';
import { parseClaudeStreamJson, type ParsedClaudeStreamOutput } from './output-parser.js';
import type { ClaudeExecFailure, ClaudeExecResult } from './types.js';

export type ClaudeExecOptions = {
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  sessionId?: string;
  bypassPermissions?: boolean;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
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
  const args = ['-p', '--verbose', '--output-format', 'stream-json'];
  appendSharedArgs(args, options);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return executeClaude(args, prompt, options);
}

export async function executeClaudeResume(
  sessionId: string,
  prompt: string,
  options: Omit<ClaudeExecOptions, 'sessionId'> = {},
): Promise<ClaudeExecResult> {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--resume', sessionId];
  appendSharedArgs(args, options);
  return executeClaude(args, prompt, options);
}

function appendSharedArgs(args: string[], options: ClaudeExecOptions): void {
  if (options.bypassPermissions) args.push('--dangerously-skip-permissions');
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
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
    onEvent: options.onEvent,
  });

  const parsed = parseClaudeStreamJson(stdout);
  if (parsed.isError && !parsed.response) {
    throw new ClaudeExecParseError({
      exitCode: code,
      stdout,
      stderr,
      parseError: 'Fully unparseable stream-json output',
    });
  }

  return {
    response: parsed.response,
    sessionId: parsed.sessionId,
    model: extractModel(parsed, options.model),
    durationMs: parsed.durationMs ?? (Date.now() - start),
    costUsd: parsed.costUsd,
    aborted,
  };
}

function extractModel(parsed: ParsedClaudeStreamOutput, fallbackModel: string | undefined): string {
  if (typeof parsed.model === 'string' && parsed.model) return parsed.model;
  return fallbackModel ?? 'unknown';
}
