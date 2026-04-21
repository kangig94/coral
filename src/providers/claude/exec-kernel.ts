import type { Provider } from '../contract.js';
import { providerRequestFailed } from '../fault.js';
import type { ParseErrorDetail } from '../middleware/adapter-parse-guard.js';
import { streamProviderEvents } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { executeClaudeFork, ClaudeExecParseError } from './claude-executor.js';
import { extractClaudeProgressMessage } from './progress.js';
import { buildClaudeBootstrapSignature, buildClaudeContinuity } from './request-mapping.js';
import { buildPreparedClaudeRequest } from './shared-utils.js';
import type { ClaudeStreamEvent } from './types.js';

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
              fault: providerRequestFailed({
                provider: 'claude',
                message: result.response || 'Claude request failed.',
              }),
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
