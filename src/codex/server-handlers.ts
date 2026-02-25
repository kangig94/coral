/**
 * Coral MCP Server - business logic handlers and utilities.
 * Extracted from server.ts to enable independent testing.
 * server.ts is the composition root (wiring only).
 */

import { executeOneShot, executeResume, executeFork, registerExecution, unregisterExecution, abortExecution, isExecutionActive } from './codex-executor.js';
import { SessionManager } from './session-manager.js';
import {
  codexOpSchema,
  type CodexOpInput,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
  type CodexSessionAbortInput,
} from './schemas.js';
import type { CodexThreadEvent } from '../types.js';
import {
  createProgressFile,
  removeProgressFile,
  extractProgressId,
  extractProgressMessage,
  appendProgressEvent,
  appendFinalResult,
} from './progress.js';
import { type McpResult, textResult, jsonResult, resultExtras } from '../shared/mcp-utils.js';

export type OnEventCallback = (line: string) => void;

export const tools = [
  {
    name: 'codex',
    description: 'Execute a prompt with OpenAI Codex CLI. Use op field to select exec/list/fork/abort.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          enum: ['exec', 'list', 'fork', 'abort'],
          description: 'Operation to run',
        },
        session: { type: 'string', description: 'Session identifier (exec/fork/abort)' },
        prompt: { type: 'string', description: 'Prompt to send (exec required, fork optional)' },
        name: { type: 'string', description: 'Session name (exec/fork optional)' },
        model: { type: 'string', description: 'Codex model to use' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        background: { type: 'boolean', description: 'Run in background, return progress_id immediately.', default: false },
        bypass: { type: 'boolean', description: 'Bypass Codex sandbox and approval checks. Only set when the user explicitly requests bypass mode.', default: false },
      },
      required: ['op'],
    },
  },
];

/** Session-not-found error message with recovery hint. */
export function sessionNotFoundError(ref: string): McpResult {
  return textResult(
    `Session not found: "${ref}". Use codex({ op: "exec" }) to start a new session, or codex({ op: "list" }) to see registered sessions.`,
    true,
  );
}

/** Build an onEvent callback that writes to a progress file and optionally sends MCP notifications. */
export function makeEventCallback(opts: {
  progressFile: string;
  progressToken?: string | number;
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
}): OnEventCallback {
  let counter = 0;
  return (line: string) => {
    try {
      const event = JSON.parse(line) as CodexThreadEvent;
      const message = extractProgressMessage(event);
      if (!message) return;
      if (opts.progressToken != null && opts.notify != null) {
        void opts.notify({
          method: 'notifications/progress',
          params: { progressToken: opts.progressToken, progress: ++counter, message: `[Codex] ${message}` },
        }).catch(() => {});
      }
      appendProgressEvent(opts.progressFile, event.type, message);
    } catch { /* ignore non-JSON lines */ }
  };
}

/** Track active background progress files for shutdown cleanup. */
export const activeBackgroundFiles = new Set<string>();

/** Extract completion fields from a handler's JSON result for the progress file. */
export function extractCompletionData(result: McpResult, sessionLabel: string): Record<string, unknown> {
  const data = JSON.parse(result.content[0].text);
  const completion: Record<string, unknown> = {
    response: data.response,
    session: data.session ?? null,
    session_name: sessionLabel,
    model: data.model,
    duration_ms: data.duration_ms,
  };
  if (data.notice) completion.notice = data.notice;
  if (data.aborted) completion.aborted = true;
  if (data.non_resumable) completion.non_resumable = true;
  if (data.exit_code !== undefined) completion.exit_code = data.exit_code;
  if (Array.isArray(data.errors)) completion.errors = data.errors;
  if (Array.isArray(data.warnings)) completion.warnings = data.warnings;
  return completion;
}

/**
 * Launch a handler in the background with a progress file.
 * Writes final result/error events and returns immediately with a "launched" response.
 */
export function launchBackground(
  sessionLabel: string,
  toolName: string,
  handler: (cb: OnEventCallback) => Promise<McpResult>,
): McpResult {
  const pFile = createProgressFile(sessionLabel, toolName);
  const progressId = extractProgressId(pFile);
  const cb = makeEventCallback({ progressFile: pFile });
  activeBackgroundFiles.add(pFile);

  handler(cb).then((result) => {
    appendFinalResult(pFile, 'completed', extractCompletionData(result, sessionLabel));
  }).catch((err) => {
    try { appendFinalResult(pFile, 'error', { error: err instanceof Error ? err.message : String(err) }); } catch {}
  }).finally(() => { activeBackgroundFiles.delete(pFile); });

  return jsonResult({ progress_id: progressId, progress_file: pFile, session_name: sessionLabel, status: 'launched' });
}

/**
 * Run a handler in the foreground, optionally with MCP progress notifications.
 * Creates and cleans up a progress file when a progress token is present.
 */
export async function runForeground(
  sessionLabel: string,
  toolName: string,
  progressToken: string | number | undefined,
  notify: ((n: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
  handler: (cb?: OnEventCallback) => Promise<McpResult>,
): Promise<McpResult> {
  const hasProgress = progressToken != null && notify != null;
  const progressFile = hasProgress ? createProgressFile(sessionLabel, toolName) : undefined;
  const cb = hasProgress
    ? makeEventCallback({ progressFile: progressFile!, progressToken, notify })
    : undefined;
  try {
    return await handler(cb);
  } finally {
    if (progressFile) removeProgressFile(progressFile);
  }
}

async function withExecution<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = registerExecution(name);
  try {
    return await fn(controller.signal);
  } finally {
    unregisterExecution(name, controller);
  }
}

function dispatchExecution(
  sessionLabel: string,
  background: boolean,
  progressToken: string | number | undefined,
  notify: ((n: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
  handler: (cb?: OnEventCallback) => Promise<McpResult>,
): Promise<McpResult> {
  if (background) {
    return Promise.resolve(launchBackground(sessionLabel, 'codex', handler));
  }
  return runForeground(sessionLabel, 'codex', progressToken, notify, handler);
}

export async function handleSessionCreate(input: CodexSessionCreateInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  const sessionName = input.name ?? `session-${Date.now()}`;
  return withExecution(sessionName, async (signal) => {
    const result = await executeOneShot(input.prompt, input.model, input.working_directory, input.reasoning_effort, input.bypass, onEvent, signal);

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

    mgr.register(sessionName, result.sessionId, result.model, input.working_directory ?? process.cwd());

    return jsonResult({
      response: result.response,
      session: result.sessionId,
      session_name: sessionName,
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  });
}

export async function handleSessionSend(input: CodexSessionSendInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);
  const sessionName = entry.name;

  return withExecution(sessionName, async (signal) => {
    const result = await executeResume(entry.sessionId, input.prompt, input.model, input.working_directory ?? entry.workingDirectory, input.reasoning_effort, input.bypass, onEvent, signal);
    mgr.updateSession(sessionName, input.model ? { model: input.model } : undefined);

    return jsonResult({
      response: result.response,
      // Fall back to the known entry session ID when abort fires before session ID re-emits.
      // The session remains resumable regardless; callers should rely on session name for resume.
      session: result.sessionId ?? entry.sessionId,
      session_name: sessionName,
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  });
}

export function handleSessionList(mgr: SessionManager): McpResult {
  const registered = mgr.list().map((s) => ({
    name: s.name,
    session: s.sessionId,
    model: s.model,
    created_at: s.createdAt,
    last_used_at: s.lastUsedAt,
    working_directory: s.workingDirectory,
    status: isExecutionActive(s.name) ? 'running' : 'completed',
  }));

  return jsonResult({ sessions: registered, total: registered.length });
}

export async function handleSessionFork(input: CodexSessionForkInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const cwd = input.working_directory ?? entry.workingDirectory;
  const forkName = input.name ?? entry.name;
  return withExecution(forkName, async (signal) => {
    const result = await executeFork(entry.sessionId, input.prompt, input.model, cwd, input.reasoning_effort, input.bypass, onEvent, signal);

    if (input.name && result.sessionId) {
      mgr.register(forkName, result.sessionId, result.model, cwd ?? process.cwd());
    }

    return jsonResult({
      response: result.response,
      session: result.sessionId,
      forked_from: entry.sessionId,
      ...(input.name ? { session_name: input.name } : {}),
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  });
}

export async function handleSessionAbort(input: CodexSessionAbortInput, mgr: SessionManager): Promise<McpResult> {
  const entry = mgr.get(input.session);
  const sessionName = entry?.name ?? input.session;
  const aborted = abortExecution(sessionName);
  if (!aborted) {
    return textResult(
      `No active execution found for session "${input.session}" in this process. The session may have already completed, still be initializing, or belong to a different MCP server instance.`,
      true,
    );
  }
  return jsonResult({ session_name: sessionName, status: 'abort_requested' });
}

async function handleCodexOp(
  input: CodexOpInput,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
): Promise<McpResult> {
  switch (input.op) {
    case 'exec': {
      const { op: _, session: sessionRef, ...rest } = input;
      if (sessionRef) {
        const { name: _, ...sendRest } = rest;
        const entry = sessionManager.get(sessionRef);
        if (!entry) return sessionNotFoundError(sessionRef);
        const sendInput: CodexSessionSendInput = { ...sendRest, session: sessionRef };
        return dispatchExecution(entry.name, sendInput.background, progressToken, notify, (cb) =>
          handleSessionSend(sendInput, sessionManager, cb));
      }
      const { name, ...createRest } = rest;
      const sessionName = name ?? `session-${Date.now()}`;
      const createInput: CodexSessionCreateInput & { name: string } = {
        ...createRest,
        name: sessionName,
      };
      return dispatchExecution(sessionName, createRest.background, progressToken, notify, (cb) =>
        handleSessionCreate(createInput, sessionManager, cb));
    }
    case 'list':
      return handleSessionList(sessionManager);
    case 'fork': {
      const { op: _, ...forkInput } = input;
      const entry = sessionManager.get(forkInput.session);
      if (!entry) return sessionNotFoundError(forkInput.session);
      const sessionLabel = forkInput.name ?? entry.name;
      return dispatchExecution(sessionLabel, forkInput.background, progressToken, notify, (cb) =>
        handleSessionFork(forkInput, sessionManager, cb));
    }
    case 'abort': {
      return handleSessionAbort(input, sessionManager);
    }
    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as CodexOpInput).op}`, true);
    }
  }
}

/**
 * MCP tool call dispatcher. Routes tool calls to handlers with background/foreground support.
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
    switch (name) {
      case 'codex': {
        const parsed = codexOpSchema.safeParse(rawArgs);
        if (!parsed.success) {
          const rawOp = (rawArgs as { op?: unknown }).op;
          if (rawOp !== undefined && parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator')) {
            return jsonResult({ error: 'unknown_op', op: rawOp });
          }
          throw parsed.error;
        }
        return await handleCodexOp(parsed.data, sessionManager, progressToken, notify);
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
