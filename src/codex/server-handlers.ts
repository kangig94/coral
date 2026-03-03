/**
 * Coral MCP Server - business logic handlers and utilities.
 * Extracted from server.ts to enable independent testing.
 * server.ts is the composition root (wiring only).
 */

import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli, type CliInfo } from './cli-detection.js';
import { SessionManager } from '../runner/session-manager.js';
import {
  codexOpSchema,
  coralAgentSchema,
  type CodexOpInput,
  type CoralAgentInput,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
  type CodexSessionAbortInput,
  type CodexWaitInput,
} from './schemas.js';
import type { CodexThreadEvent } from '../types.js';
import {
  extractProgressMessage,
  appendProgressEvent,
} from './progress.js';
import {
  activeSessions,
  tryClaimTerminalWrite,
  shutdownSignal,
  launchJob as launchRunnerJob,
  handleWait as handleRunnerWait,
  type OnEventCallback,
} from '../runner/job-manager.js';
import type { CompletionMetadata } from '../runner/types.js';
import { resolveCoralContent } from '../runner/coral-resolver.js';
import { type McpResult, textResult, jsonResult, resultExtras } from '../shared/mcp-utils.js';

export { activeSessions, tryClaimTerminalWrite, shutdownSignal };

export const tools = [
  {
    name: 'codex',
    description: 'Execute a prompt with OpenAI Codex CLI. Use op field to select exec/list/fork/wait/abort. For agent delegation, use op: "coral:<agent-name>" (e.g., coral:scanner, coral:architect).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          description: 'Operation to run: exec/list/fork/wait/abort, or coral:<agent> for agent delegation (e.g., coral:scanner, coral:architect)',
        },
        session: { type: 'string', description: 'Session UUID for resume (exec/fork/abort)' },
        prompt: { type: 'string', description: 'Prompt to send (exec required, fork optional)' },
        name: { type: 'string', description: 'Session name (exec/fork optional)' },
        model: { type: 'string', description: 'Codex model to use' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        bypass: { type: 'boolean', description: 'Bypass Codex sandbox and approval checks. Only set when the user explicitly requests bypass mode.', default: false },
        sessions: { type: 'array', items: { type: 'string' }, description: 'Session UUIDs to monitor (from exec/fork response)' },
        timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
      },
      required: ['op'],
    },
  },
];

/** Session-not-found error message with recovery hint. */
export function sessionNotFoundError(ref: string): McpResult {
  return textResult(
    `Session not found: "${ref}". To resume, use a coral session UUID. Use codex({ op: "list" }) to see registered sessions, or codex({ op: "exec" }) to start a new session.`,
    true,
  );
}

export function makeEventCallback(progressFile: string): OnEventCallback {
  return (line: string) => {
    try {
      const event = JSON.parse(line) as CodexThreadEvent;
      const message = extractProgressMessage(event);
      if (!message) return;
      appendProgressEvent(progressFile, event.type, message);
    } catch {
      /* ignore non-JSON lines */
    }
  };
}

export function extractCompletionData(
  result: McpResult,
  _sessionLabel?: string,
): { responseText: string; metadata: CompletionMetadata; sessionId?: string } {
  const data = JSON.parse(result.content[0].text);
  let threadId: string | null = null;
  if (typeof data.thread_id === 'string') {
    threadId = data.thread_id;
  } else if (typeof data.session === 'string') {
    process.stderr.write(`Warning: Completion payload uses legacy 'session' field; update producer to emit 'thread_id'\n`);
    threadId = data.session;
  }
  const metadata: CompletionMetadata = {
    thread_id: threadId,
    model: data.model,
    duration_ms: data.duration_ms,
  };
  if (data.notice) metadata.notice = data.notice;
  if (data.aborted) metadata.aborted = true;
  if (data.non_resumable) metadata.non_resumable = true;
  if (data.exit_code !== undefined) metadata.exit_code = data.exit_code;
  if (Array.isArray(data.errors)) metadata.errors = data.errors;
  if (Array.isArray(data.warnings)) metadata.warnings = data.warnings;
  return {
    responseText: data.response ?? '',
    metadata,
    sessionId: typeof threadId === 'string' ? threadId : undefined,
  };
}

export function launchJob(
  sessionLabel: string,
  handler: (signal: AbortSignal, onEvent: OnEventCallback) => Promise<McpResult>,
  mgr: SessionManager,
  workingDirectory: string = process.cwd(),
): McpResult {
  return launchRunnerJob({
    provider: 'codex',
    sessionLabel,
    workingDirectory,
    handler,
    mgr,
    makeOnEvent: ({ progressFile }) => makeEventCallback(progressFile),
    extractCompletion: (result) => extractCompletionData(result),
  });
}

async function preflightCliCheck(): Promise<
  | { pass: true; cli: CliInfo & { available: true } }
  | { pass: false; result: McpResult }
> {
  const cli = await detectCodexCli();
  if (!cli.available) return { pass: false, result: textResult(`Error: ${cli.error}`, true) };
  if (cli.authState === 'unauthenticated') {
    return { pass: false, result: textResult(`Error: ${cli.authError}`, true) };
  }
  return { pass: true, cli };
}

export async function handleSessionCreate(
  input: CodexSessionCreateInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
): Promise<McpResult> {
  const sessionName = input.name ?? `session-${Date.now()}`;
  const result = await executeOneShot(
    input.prompt,
    input.model,
    input.working_directory,
    input.reasoning_effort,
    input.bypass,
    onEvent,
    signal,
    preChecked,
  );

  if (!result.sessionId) {
    return jsonResult({
      response: result.response,
      notice: result.aborted
        ? 'Aborted before session ID was received. This session cannot be resumed.'
        : 'No session ID returned by Codex. Session not registered.',
      ...(result.aborted ? { aborted: true, non_resumable: true } : {}),
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  }

  return jsonResult({
    response: result.response,
    thread_id: result.sessionId,
    session_name: sessionName,
    model: result.model,
    duration_ms: result.durationMs,
    ...resultExtras(result),
  });
}

export async function handleSessionSend(
  input: CodexSessionSendInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
  sourceSessionId?: string,
): Promise<McpResult> {
  const entry = mgr.get('codex', input.session);
  if (!entry) return sessionNotFoundError(input.session);
  const sessionName = entry.name;
  const workingDirectory = input.working_directory ?? entry.workingDirectory;
  const modelUpdate = input.model ? { model: input.model } : undefined;

  const result = await executeResume(
    entry.threadId,
    input.prompt,
    input.model,
    workingDirectory,
    input.reasoning_effort,
    input.bypass,
    onEvent,
    signal,
    preChecked,
  );

  mgr.updateSession('codex', sourceSessionId ?? input.session, modelUpdate);

  return jsonResult({
    response: result.response,
    // Fall back to the known entry thread ID when abort fires before session ID re-emits.
    thread_id: result.sessionId ?? entry.threadId,
    session_name: sessionName,
    model: result.model,
    duration_ms: result.durationMs,
    ...resultExtras(result),
  });
}

export function handleSessionList(mgr: SessionManager): McpResult {
  const registered = mgr.list('codex').map((s) => {
    const active = activeSessions.get(s.id);
    const owner = active?.provider ?? 'codex';
    return {
      name: s.name,
      session: s.id,
      model: s.model,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      working_directory: s.workingDirectory,
      status: owner === 'codex' && active?.terminalState === 'running' ? 'running' : 'completed',
    };
  });

  return jsonResult({ sessions: registered, total: registered.length });
}

export async function handleSessionFork(
  input: CodexSessionForkInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
): Promise<McpResult> {
  const entry = mgr.get('codex', input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const cwd = input.working_directory ?? entry.workingDirectory;
  const result = await executeFork(
    entry.threadId,
    input.prompt,
    input.model,
    cwd,
    input.reasoning_effort,
    input.bypass,
    onEvent,
    signal,
    preChecked,
  );

  return jsonResult({
    response: result.response,
    thread_id: result.sessionId,
    forked_from: input.session,
    ...(input.name ? { session_name: input.name } : {}),
    model: result.model,
    duration_ms: result.durationMs,
    ...resultExtras(result),
  });
}

export async function handleSessionAbort(input: CodexSessionAbortInput, _mgr: SessionManager): Promise<McpResult> {
  const entry = activeSessions.get(input.session);
  if (!entry || (entry.provider ?? 'codex') !== 'codex') {
    return textResult(
      `No active execution found for session "${input.session}". The session may have already completed or the ID is invalid.`,
      true,
    );
  }

  entry.controller.abort();
  return jsonResult({ session: input.session, session_name: entry.sessionName, status: 'abort_requested' });
}

export async function handleWait(
  input: CodexWaitInput,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
  progressToken?: string | number,
): Promise<McpResult> {
  return handleRunnerWait('codex', input, notify, progressToken);
}

async function handleCodexOp(
  input: CodexOpInput,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
): Promise<McpResult> {
  switch (input.op) {
    case 'exec': {
      const { op: _op, session: sessionRef, ...rest } = input;
      if (sessionRef) {
        const { name: _name, ...sendRest } = rest;
        const entry = sessionManager.get('codex', sessionRef);
        if (!entry) return sessionNotFoundError(sessionRef);

        const preflight = await preflightCliCheck();
        if (!preflight.pass) return preflight.result;

        const sendInput: CodexSessionSendInput = { ...sendRest, session: sessionRef };
        return launchJob(
          entry.name,
          (signal, onEvent) => handleSessionSend(sendInput, sessionManager, signal, onEvent, preflight.cli, sessionRef),
          sessionManager,
          sendInput.working_directory ?? entry.workingDirectory,
        );
      }

      const preflight = await preflightCliCheck();
      if (!preflight.pass) return preflight.result;

      const sessionName = rest.name ?? `session-${Date.now()}`;
      const createInput: CodexSessionCreateInput & { name: string } = { ...rest, name: sessionName };
      return launchJob(
        sessionName,
        (signal, onEvent) => handleSessionCreate(createInput, sessionManager, signal, onEvent, preflight.cli),
        sessionManager,
        createInput.working_directory ?? process.cwd(),
      );
    }
    case 'list':
      return handleSessionList(sessionManager);
    case 'fork': {
      const { op: _op, ...forkInput } = input;
      const entry = sessionManager.get('codex', forkInput.session);
      if (!entry) return sessionNotFoundError(forkInput.session);

      const preflight = await preflightCliCheck();
      if (!preflight.pass) return preflight.result;

      const sessionLabel = forkInput.name ?? entry.name;
      return launchJob(
        sessionLabel,
        (signal, onEvent) => handleSessionFork(forkInput, sessionManager, signal, onEvent, preflight.cli),
        sessionManager,
        forkInput.working_directory ?? entry.workingDirectory,
      );
    }
    case 'wait':
      return handleWait(input, notify, progressToken);
    case 'abort':
      return handleSessionAbort(input, sessionManager);
    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as CodexOpInput).op}`, true);
    }
  }
}

async function handleCoralAgent(
  input: CoralAgentInput,
  mgr: SessionManager,
): Promise<McpResult> {
  const coralName = input.op.slice(6); // op already validated by coralAgentSchema
  let resolved;
  try {
    resolved = resolveCoralContent(coralName);
  } catch (err) {
    return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  const augmentedPrompt = `${resolved.content}\n\n---\n\n${input.prompt}`;

  if (input.session) {
    const entry = mgr.get('codex', input.session);
    if (!entry) {
      return sessionNotFoundError(input.session);
    }

    const preflight = await preflightCliCheck();
    if (!preflight.pass) return preflight.result;

    const sendInput: CodexSessionSendInput = {
      prompt: augmentedPrompt,
      session: input.session,
      model: input.model,
      working_directory: input.working_directory ?? entry.workingDirectory,
      reasoning_effort: input.reasoning_effort,
      bypass: input.bypass,
    };
    return launchJob(
      entry.name,
      (signal, onEvent) => handleSessionSend(sendInput, mgr, signal, onEvent, preflight.cli, input.session),
      mgr,
      sendInput.working_directory ?? entry.workingDirectory,
    );
  }

  const preflight = await preflightCliCheck();
  if (!preflight.pass) return preflight.result;

  const sessionName = input.name ?? `${coralName}-${Date.now()}`;
  const createInput: CodexSessionCreateInput & { name: string } = {
    prompt: augmentedPrompt,
    name: sessionName,
    model: input.model,
    working_directory: input.working_directory,
    reasoning_effort: input.reasoning_effort,
    bypass: input.bypass,
  };
  return launchJob(
    sessionName,
    (signal, onEvent) => handleSessionCreate(createInput, mgr, signal, onEvent, preflight.cli),
    mgr,
    createInput.working_directory ?? process.cwd(),
  );
}

/**
 * MCP tool call dispatcher. Routes tool calls to handlers.
 * Catches Zod validation errors and returns them as MCP error responses.
 */
export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
): Promise<McpResult> {
  try {
    if (name !== 'codex') {
      return textResult(`Unknown tool: ${name}`, true);
    }

    const rawOp = (rawArgs as { op?: unknown }).op;
    if (typeof rawOp === 'string' && rawOp.startsWith('coral:')) {
      const parsed = coralAgentSchema.safeParse(rawArgs);
      if (!parsed.success) throw parsed.error;
      return handleCoralAgent(parsed.data, sessionManager);
    }

    const parsed = codexOpSchema.safeParse(rawArgs);
    if (!parsed.success) {
      if (rawOp !== undefined && parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator')) {
        return jsonResult({ error: 'unknown_op', op: rawOp });
      }
      throw parsed.error;
    }

    return await handleCodexOp(parsed.data, sessionManager, progressToken, notify);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
