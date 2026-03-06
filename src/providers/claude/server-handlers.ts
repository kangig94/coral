import { executeClaudeOneShot, executeClaudeResume, executeClaudeFork, ClaudeExecParseError } from './claude-executor.js';
import { detectClaudeCli, type ClaudeCliInfo } from './cli-detection.js';
import {
  claudeOpSchema,
  coralClaudeSchema,
  type ClaudeOpInput,
  type ClaudeSessionCreateInput,
  type ClaudeSessionSendInput,
  type ClaudeSessionForkInput,
} from './schemas.js';
import {
  launchJob as launchRunnerJob,
  type OnEventCallback,
} from '../../runner/job-manager.js';
import type { SessionManager } from '../../runner/session-manager.js';
import type { CompletionMetadata } from '../../runner/types.js';
import { type McpResult, textResult, jsonResult } from '../../shared/mcp-utils.js';
import { sessionNotFoundError, handleSessionList } from '../session-ops.js';
import { extractClaudeProgressMessage, appendProgressEvent } from './progress.js';
import type { ClaudeStreamEvent } from './types.js';
import type { ProviderAdapter, NotifyFn } from '../types.js';

export const claudeTool = {
  name: 'claude',
  description: 'Execute a prompt with Claude CLI. Use op field to select exec/list/fork. For agent delegation, use op: "coral:<agent-name>" (e.g., coral:architect, coral:critic).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      op: { type: 'string', description: 'Operation: exec/list/fork, or coral:<agent-name> for agent delegation' },
      prompt: { type: 'string', description: 'Prompt to send (exec required)' },
      session: { type: 'string', description: 'Session ID for resume (exec with existing session)' },
      name: { type: 'string', description: 'Session name (exec optional)' },
      model: { type: 'string', description: 'Claude model to use (e.g., sonnet, opus, haiku)' },
      working_directory: { type: 'string', description: 'Working directory for execution' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
      system_prompt: { type: 'string', description: 'Additional system prompt (appended to default)' },
      bypass: { type: 'boolean', description: 'Bypass Claude permission checks. Only set when the user explicitly requests bypass mode.', default: false },
    },
    required: ['op'],
  },
};

export function makeClaudeEventCallback(progressFile: string): OnEventCallback {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as ClaudeStreamEvent;
      const message = extractClaudeProgressMessage(event);
      if (!message) return;
      appendProgressEvent(progressFile, event.type, message);
    } catch {
      /* ignore non-JSON lines */
    }
  };
}

function launchClaudeJob(
  sessionLabel: string,
  handler: (signal: AbortSignal, onEvent: OnEventCallback) => Promise<McpResult>,
  mgr: SessionManager,
  workingDirectory: string,
): McpResult {
  return launchRunnerJob({
    provider: 'claude',
    sessionLabel,
    workingDirectory,
    handler,
    mgr,
    makeOnEvent: ({ progressFile }) => makeClaudeEventCallback(progressFile),
    extractCompletion: (result) => extractClaudeCompletionData(result),
  });
}

export function extractClaudeCompletionData(
  result: McpResult,
): { responseText: string; metadata: CompletionMetadata; sessionId?: string } {
  const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
  const threadId = typeof data.thread_id === 'string' ? data.thread_id : undefined;

  const metadata: CompletionMetadata = {
    thread_id: threadId,
    model: typeof data.model === 'string' ? data.model : undefined,
    duration_ms: data.duration_ms,
    cost_usd: data.cost_usd,
  };
  if (typeof data.notice === 'string' && data.notice) metadata.notice = data.notice;
  if (data.aborted === true) metadata.aborted = true;
  if (data.non_resumable === true) metadata.non_resumable = true;
  if (typeof data.exit_code === 'number') metadata.exit_code = data.exit_code;
  if (Array.isArray(data.errors)) metadata.errors = data.errors;
  if (Array.isArray(data.warnings)) metadata.warnings = data.warnings;

  return {
    responseText: typeof data.response === 'string' ? data.response : '',
    metadata,
    sessionId: threadId,
  };
}

async function preflightClaudeCliCheck(): Promise<
  | { pass: true; cli: ClaudeCliInfo & { available: true } }
  | { pass: false; result: McpResult }
> {
  const cli = await detectClaudeCli();
  if (!cli.available) return { pass: false, result: textResult(`Error: ${cli.error}`, true) };
  if (cli.authState === 'unauthenticated') {
    return { pass: false, result: textResult(`Error: ${cli.authError}`, true) };
  }
  return { pass: true, cli };
}

function missingSessionNotice(aborted: boolean): string {
  return aborted
    ? 'Aborted before session ID was received. This session cannot be resumed.'
    : 'No session ID returned by Claude CLI output. Session not registered.';
}

export async function handleClaudeSessionCreate(
  input: ClaudeSessionCreateInput,
  _mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  _preChecked?: ClaudeCliInfo & { available: true },
): Promise<McpResult> {
  const sessionName = input.name ?? `session-${Date.now()}`;

  let result;
  try {
    result = await executeClaudeOneShot(input.prompt, {
      model: input.model,
      workingDirectory: input.working_directory,
      systemPrompt: input.system_prompt,
      effort: input.effort,
      bypassPermissions: input.bypass,
      signal,
      onEvent,
    });
  } catch (error: unknown) {
    if (error instanceof ClaudeExecParseError) {
      return jsonResult({
        response: '',
        notice: 'Claude CLI returned non-JSON output; session result is non-resumable.',
        non_resumable: true,
        model: input.model ?? 'unknown',
        duration_ms: 0,
        cost_usd: 0,
        exit_code: error.failure.exitCode,
        errors: [error.failure],
      });
    }
    throw error;
  }

  if (!result.sessionId) {
    return jsonResult({
      response: result.response,
      notice: missingSessionNotice(result.aborted),
      ...(result.aborted ? { aborted: true } : {}),
      non_resumable: true,
      model: result.model,
      duration_ms: result.durationMs,
      cost_usd: result.costUsd,
    });
  }

  return jsonResult({
    response: result.response,
    thread_id: result.sessionId,
    session_name: sessionName,
    model: result.model,
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
    ...(result.aborted ? { aborted: true } : {}),
  });
}

export async function handleClaudeSessionSend(
  input: ClaudeSessionSendInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  _preChecked?: ClaudeCliInfo & { available: true },
  sourceSessionId?: string,
): Promise<McpResult> {
  const entry = mgr.get('claude', input.session);
  if (!entry) return sessionNotFoundError(input.session, 'claude');

  const sessionName = entry.name;
  const workingDirectory = input.working_directory ?? entry.workingDirectory;

  let result;
  try {
    result = await executeClaudeResume(entry.threadId, input.prompt, {
      model: input.model,
      workingDirectory,
      systemPrompt: input.system_prompt,
      effort: input.effort,
      bypassPermissions: input.bypass,
      signal,
      onEvent,
    });
  } catch (error: unknown) {
    if (error instanceof ClaudeExecParseError) {
      return jsonResult({
        response: '',
        notice: 'Claude CLI returned non-JSON output while resuming session.',
        non_resumable: true,
        model: input.model ?? entry.model,
        duration_ms: 0,
        cost_usd: 0,
        exit_code: error.failure.exitCode,
        errors: [error.failure],
      });
    }
    throw error;
  }

  const updateFields: { model?: string; threadId?: string } = {};
  if (input.model) updateFields.model = input.model;
  if (result.sessionId) updateFields.threadId = result.sessionId;
  if (Object.keys(updateFields).length > 0) {
    mgr.updateSession('claude', sourceSessionId ?? input.session, updateFields);
  }

  return jsonResult({
    response: result.response,
    ...(result.sessionId ? { thread_id: result.sessionId } : {}),
    ...(result.sessionId ? {} : { notice: missingSessionNotice(result.aborted), non_resumable: true }),
    session_name: sessionName,
    model: result.model,
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
    ...(result.aborted ? { aborted: true } : {}),
  });
}

export async function handleClaudeSessionFork(
  input: ClaudeSessionForkInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  _preChecked?: ClaudeCliInfo & { available: true },
): Promise<McpResult> {
  const entry = mgr.get('claude', input.session);
  if (!entry) return sessionNotFoundError(input.session, 'claude');

  const workingDirectory = input.working_directory ?? entry.workingDirectory;
  let result;
  try {
    result = await executeClaudeFork(entry.threadId, input.prompt ?? '', {
      model: input.model,
      workingDirectory,
      systemPrompt: input.system_prompt,
      effort: input.effort,
      bypassPermissions: input.bypass,
      signal,
      onEvent,
    });
  } catch (error: unknown) {
    if (error instanceof ClaudeExecParseError) {
      return jsonResult({
        response: '',
        notice: 'Claude CLI returned non-JSON output while forking session.',
        non_resumable: true,
        model: input.model ?? entry.model,
        duration_ms: 0,
        cost_usd: 0,
        exit_code: error.failure.exitCode,
        errors: [error.failure],
      });
    }
    throw error;
  }

  if (!result.sessionId) {
    return jsonResult({
      response: result.response,
      notice: missingSessionNotice(result.aborted),
      ...(result.aborted ? { aborted: true } : {}),
      non_resumable: true,
      model: result.model,
      duration_ms: result.durationMs,
      cost_usd: result.costUsd,
    });
  }

  return jsonResult({
    response: result.response,
    thread_id: result.sessionId,
    forked_from: input.session,
    ...(input.name ? { session_name: input.name } : {}),
    model: result.model,
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
    ...(result.aborted ? { aborted: true } : {}),
  });
}

export function handleClaudeSessionList(mgr: SessionManager): McpResult {
  return handleSessionList(mgr, 'claude');
}

export async function handleClaudeCoralOp(
  coralName: string,
  coralContent: string,
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  _progressToken?: string | number,
  _notify?: NotifyFn,
): Promise<McpResult> {
  const parsed = coralClaudeSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  const input = parsed.data;

  const systemPrompt = coralContent;
  const preflight = await preflightClaudeCliCheck();
  if (!preflight.pass) return preflight.result;

  if (input.session) {
    const entry = sessionManager.get('claude', input.session);
    if (!entry) return sessionNotFoundError(input.session, 'claude');

    const sendInput: ClaudeSessionSendInput = {
      session: input.session,
      prompt: input.prompt,
      model: input.model,
      working_directory: input.working_directory ?? entry.workingDirectory,
      effort: input.effort,
      system_prompt: systemPrompt,
      bypass: true,
    };
    return launchClaudeJob(
      entry.name,
      (signal, onEvent) => handleClaudeSessionSend(sendInput, sessionManager, signal, onEvent, preflight.cli, input.session),
      sessionManager,
      sendInput.working_directory ?? entry.workingDirectory,
    );
  }

  const sessionName = input.name ?? `${coralName}-${Date.now()}`;
  const createInput: ClaudeSessionCreateInput & { name: string } = {
    prompt: input.prompt,
    name: sessionName,
    model: input.model,
    working_directory: input.working_directory,
    effort: input.effort,
    system_prompt: systemPrompt,
    bypass: true,
  };

  return launchClaudeJob(
    sessionName,
    (signal, onEvent) => handleClaudeSessionCreate(createInput, sessionManager, signal, onEvent, preflight.cli),
    sessionManager,
    createInput.working_directory ?? process.cwd(),
  );
}

async function handleForkOp(
  input: Extract<ClaudeOpInput, { op: 'fork' }>,
  sessionManager: SessionManager,
): Promise<McpResult> {
  const { op: _op, ...forkInput } = input;
  const entry = sessionManager.get('claude', forkInput.session);
  if (!entry) return sessionNotFoundError(forkInput.session, 'claude');

  const preflight = await preflightClaudeCliCheck();
  if (!preflight.pass) return preflight.result;

  const sessionLabel = forkInput.name ?? entry.name;
  return launchClaudeJob(
    sessionLabel,
    (signal, onEvent) => handleClaudeSessionFork(forkInput, sessionManager, signal, onEvent, preflight.cli),
    sessionManager,
    forkInput.working_directory ?? entry.workingDirectory,
  );
}

export async function handleClaudeOp(
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  _progressToken?: string | number,
  _notify?: NotifyFn,
): Promise<McpResult> {
  const parsed = claudeOpSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const rawOp = (rawArgs as { op?: unknown }).op;
    if (rawOp !== undefined && parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator')) {
      return jsonResult({ error: 'unknown_op', op: rawOp });
    }
    throw parsed.error;
  }

  const input: ClaudeOpInput = parsed.data;
  switch (input.op) {
    case 'exec': {
      const { op: _op, session: sessionRef, ...rest } = input;
      const preflight = await preflightClaudeCliCheck();
      if (!preflight.pass) return preflight.result;

      if (sessionRef) {
        const entry = sessionManager.get('claude', sessionRef);
        if (!entry) return sessionNotFoundError(sessionRef, 'claude');

        const sendInput: ClaudeSessionSendInput = { ...rest, session: sessionRef };
        return launchClaudeJob(
          entry.name,
          (signal, onEvent) => handleClaudeSessionSend(sendInput, sessionManager, signal, onEvent, preflight.cli, sessionRef),
          sessionManager,
          sendInput.working_directory ?? entry.workingDirectory,
        );
      }

      const sessionName = rest.name ?? `session-${Date.now()}`;
      const createInput: ClaudeSessionCreateInput & { name: string } = { ...rest, name: sessionName };
      return launchClaudeJob(
        sessionName,
        (signal, onEvent) => handleClaudeSessionCreate(createInput, sessionManager, signal, onEvent, preflight.cli),
        sessionManager,
        createInput.working_directory ?? process.cwd(),
      );
    }
    case 'list':
      return handleClaudeSessionList(sessionManager);
    case 'fork':
      return handleForkOp(input, sessionManager);
    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as ClaudeOpInput).op}`, true);
    }
  }
}

export const claudeAdapter: ProviderAdapter = {
  name: 'claude',
  tool: claudeTool,
  handleOp: handleClaudeOp,
  handleCoralOp: handleClaudeCoralOp,
  extractCompletion: extractClaudeCompletionData,
  makeOnEvent: ({ progressFile }) => makeClaudeEventCallback(progressFile),
};
