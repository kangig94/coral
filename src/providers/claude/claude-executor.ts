import { resolveEffort, type EffortLevel } from '../../shared/schemas.js';
import { parseClaudeStreamJson, type ParsedClaudeStreamOutput } from './output-parser.js';
import type { ClaudeExecFailure, ClaudeExecResult } from './types.js';
import type { ProviderCliRunner } from '../runner-port.js';

export type ClaudeExecOptions = {
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  effort?: EffortLevel;
  sessionId?: string;
  bypassPermissions?: boolean;
  onEvent?: (line: string) => void;
  runCli: ProviderCliRunner;
  environment: Record<string, string>;
};

export class ClaudeExecParseError extends Error {
  readonly failure: ClaudeExecFailure;

  constructor(failure: ClaudeExecFailure) {
    super(`Claude CLI returned non-JSON output: ${failure.parseError}`);
    this.name = 'ClaudeExecParseError';
    this.failure = failure;
  }
}

const STREAM_JSON_ARGS = ['-p', '--verbose', '--output-format', 'stream-json'];

export async function executeClaudeOneShot(prompt: string, options: ClaudeExecOptions): Promise<ClaudeExecResult> {
  const args = [...STREAM_JSON_ARGS];
  appendSharedArgs(args, options);
  if (options.sessionId) args.push('--session-id', options.sessionId);
  return executeClaude(args, prompt, options);
}

export async function executeClaudeResume(
  sessionId: string,
  prompt: string,
  options: Omit<ClaudeExecOptions, 'sessionId'>,
): Promise<ClaudeExecResult> {
  const args = [...STREAM_JSON_ARGS, '--resume', sessionId];
  appendSharedArgs(args, options);
  return executeClaude(args, prompt, options);
}

export async function executeClaudeFork(
  sessionId: string,
  prompt: string,
  options: Omit<ClaudeExecOptions, 'sessionId'>,
): Promise<ClaudeExecResult> {
  const args = [...STREAM_JSON_ARGS, '--resume', sessionId, '--fork-session'];
  appendSharedArgs(args, options);
  return executeClaude(args, prompt, options);
}

function appendSharedArgs(args: string[], options: ClaudeExecOptions): void {
  if (options.bypassPermissions) args.push('--dangerously-skip-permissions');
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
  const effort = resolveEffort(options.effort, options.environment);
  args.push('--effort', effort);
}

async function executeClaude(args: string[], prompt: string, options: ClaudeExecOptions): Promise<ClaudeExecResult> {
  const start = Date.now();
  const { stdout, stderr, code, aborted } = await options.runCli({
    command: 'claude',
    args,
    prompt,
    cwd: options.workingDirectory,
    extraEnv: options.environment,
    onEvent: options.onEvent,
  });

  const parsed = parseClaudeStreamJson(stdout);
  // The Claude parser signals parse failure via a sentinel result; preserve that
  // executor-level rejection so empty/unparseable streams never look successful.
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
    durationMs: parsed.durationMs ?? Date.now() - start,
    costUsd: parsed.costUsd,
    aborted,
  };
}

function extractModel(parsed: ParsedClaudeStreamOutput, fallbackModel: string | undefined): string {
  if (typeof parsed.model === 'string' && parsed.model) return parsed.model;
  return fallbackModel ?? 'unknown';
}
