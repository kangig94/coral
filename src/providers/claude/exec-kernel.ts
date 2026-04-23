import type { EffortLevel } from '../request-policy.js';
import type { Provider } from '../contract.js';
import type { ProviderCliRunner } from '../cli-runner.js';
import { providerRequestFailed } from '../fault.js';
import type { ParseErrorDetail } from '../middleware/adapter-parse-guard.js';
import { streamProviderEvents } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { parseClaudeStreamJson, type ParsedClaudeStreamOutput } from './output-parser.js';
import { extractClaudeProgressMessage } from './progress.js';
import { buildClaudeBootstrapSignature, buildClaudeContinuity } from './request-mapping.js';
import { buildPreparedClaudeRequest } from './request-prep.js';
import type { ClaudeExecFailure, ClaudeExecResult, ClaudeStreamEvent } from './types.js';

const CLAUDE_EXEC_REQUEST_FAILURE_KIND = 'provider_request_failed' as const;
const STREAM_JSON_ARGS = ['-p', '--verbose', '--output-format', 'stream-json'];

type ClaudeForkOptions = {
  model?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  effort?: EffortLevel;
  bypassPermissions?: boolean;
  onEvent?: (line: string) => void;
  runCli: ProviderCliRunner;
  environment: Record<string, string>;
};

class ClaudeExecParseError extends Error {
  readonly failure: ClaudeExecFailure;

  constructor(failure: ClaudeExecFailure) {
    super(`Claude CLI returned non-JSON output: ${failure.parseError}`);
    this.name = 'ClaudeExecParseError';
    this.failure = failure;
  }
}

function buildClaudeExecRequestFailed(message: string) {
  const fault = providerRequestFailed({
    provider: 'claude',
    message,
  });
  if (fault.kind !== CLAUDE_EXEC_REQUEST_FAILURE_KIND) {
    throw new Error('Claude exec kernel emitted an unexpected fault kind.');
  }
  return fault;
}

export function isClaudeExecParseError(error: unknown): ParseErrorDetail | null {
  if (!(error instanceof ClaudeExecParseError)) {
    return null;
  }

  return error.failure;
}

export const claudeExecKernel: Provider = (request, runtime) =>
  streamProviderEvents(async (emit) => {
    if (request.action !== 'fork') {
      throw new Error(`Claude exec kernel only supports fork actions, received ${request.action}.`);
    }
    if (!request.conversationRef) {
      throw new Error('fork requires conversationRef');
    }

    const prepared = buildPreparedClaudeRequest(request);
    const result = await executeClaudeFork(request.conversationRef, prepared.prompt, {
      model: prepared.model,
      workingDirectory: request.cwd,
      systemPrompt: prepared.systemPrompt,
      effort: prepared.effort,
      bypassPermissions: request.bypassPermissions,
      onEvent: (line) => emitProgress(line, request.cwd, emit),
      runCli: runtime.runCli,
      environment: request.coralEnv,
    });

    if (result.sessionId) {
      runtime.continuityBridge.checkpoint({
        conversationRef: result.sessionId,
        resumable: true,
        providerContinuity: buildClaudeContinuity({
          bootstrapSignature: buildClaudeBootstrapSignature(request, prepared.systemPrompt),
          conversationRef: result.sessionId,
        }),
      });
    }

    emit({
      kind: 'terminal',
      terminal: result.isError
        ? buildJobTerminal({
            content: result.response,
            model: result.model,
            durationMs: result.durationMs,
            usage: result.costUsd === null ? undefined : { costUsd: result.costUsd },
            outcome: {
              kind: 'failed',
              fault: buildClaudeExecRequestFailed(result.response || 'Claude request failed.'),
            },
          })
        : buildJobTerminal({
            response: result.response,
            model: result.model,
            durationMs: result.durationMs,
            aborted: result.aborted,
            usage: result.costUsd === null ? undefined : { costUsd: result.costUsd },
          }),
      diagnostics: buildJobDiagnostics({}),
    });
  });

function emitProgress(
  line: string,
  projectRoot: string,
  emit: (event: { kind: 'progress'; message: string }) => void,
): void {
  try {
    const event = JSON.parse(line) as ClaudeStreamEvent;
    const message = extractClaudeProgressMessage(event, projectRoot);
    if (!message) {
      return;
    }

    emit({ kind: 'progress', message });
  } catch {
    /* ignore non-JSON or unparseable lines */
  }
}

async function executeClaudeFork(
  sessionId: string,
  prompt: string,
  options: ClaudeForkOptions,
): Promise<ClaudeExecResult> {
  const args = [...STREAM_JSON_ARGS, '--resume', sessionId, '--fork-session'];
  appendSharedArgs(args, options);
  return executeClaude(args, prompt, options);
}

function appendSharedArgs(
  args: string[],
  options: Pick<ClaudeForkOptions, 'bypassPermissions' | 'systemPrompt' | 'model' | 'effort'>,
): void {
  if (options.bypassPermissions) args.push('--dangerously-skip-permissions');
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
}

async function executeClaude(args: string[], prompt: string, options: ClaudeForkOptions): Promise<ClaudeExecResult> {
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
    isError: parsed.isError,
  };
}

function extractModel(parsed: ParsedClaudeStreamOutput, fallbackModel: string | undefined): string {
  if (typeof parsed.model === 'string' && parsed.model) {
    return parsed.model;
  }

  return fallbackModel ?? 'unknown';
}
