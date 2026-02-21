/**
 * Coral MCP Server — business logic handlers and utilities.
 * Extracted from server.ts to enable independent testing.
 * server.ts is the composition root (wiring only).
 */

import { executeOneShot, executeResume, executeFork, registerExecution, unregisterExecution, abortExecution, isExecutionActive } from './codex-executor.js';
import { SessionManager } from './session-manager.js';
import {
  codexSessionCreateSchema,
  codexSessionSendSchema,
  codexSessionListSchema,
  codexSessionForkSchema,
  codexSessionAbortSchema,
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

// Re-export shared primitives so existing imports from this module continue to work.
export { textResult, jsonResult, resultExtras } from '../shared/mcp-utils.js';

export type OnEventCallback = (line: string) => void;

export const tools = [
  {
    name: 'codex_session_create',
    description:
      'Execute a prompt with OpenAI Codex CLI. Creates a session and registers it for later continuation. This is the sole entry point for Codex execution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Session name (optional, auto-generated if omitted)' },
        prompt: { type: 'string', description: 'The prompt to send to Codex (required)' },
        model: { type: 'string', description: 'Codex model to use (default: gpt-5.3-codex)' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        background: { type: 'boolean', description: 'Run in background. Returns progress_id immediately.', default: false },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'codex_session_send',
    description: 'Send a follow-up prompt to an existing Codex session. Resumes the conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session name or Codex thread ID (required)' },
        prompt: { type: 'string', description: 'Follow-up prompt (required)' },
        model: { type: 'string', description: 'Codex model to use' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        background: { type: 'boolean', description: 'Run in background. Returns progress_id immediately.', default: false },
      },
      required: ['session', 'prompt'],
    },
  },
  {
    name: 'codex_session_list',
    description: 'List all Coral-registered Codex sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'codex_session_fork',
    description:
      'Fork an existing Codex session. Resumes the session with an optional new prompt (note: uses resume-based simulation since codex fork is TUI-only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session name or thread ID to fork from (required)' },
        name: { type: 'string', description: 'Name for the new forked session' },
        prompt: { type: 'string', description: 'Optional prompt for the forked session' },
        model: { type: 'string', description: 'Codex model to use' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        background: { type: 'boolean', description: 'Run in background. Returns progress_id immediately.', default: false },
      },
      required: ['session'],
    },
  },
  {
    name: 'codex_session_abort',
    description: 'Abort a running Codex session in the current process. The session can be resumed later with codex_session_send.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session: { type: 'string', description: 'Session name or Codex thread ID to abort (required)' },
      },
      required: ['session'],
    },
  },
];

/** Extract completion fields from a handler's JSON result for the progress file. */
export function extractCompletionData(result: McpResult, sessionLabel: string): Record<string, unknown> {
  const data = JSON.parse(result.content[0].text);
  const out: Record<string, unknown> = {
    response: data.response,
    thread_id: data.thread_id ?? null,
    session_name: sessionLabel,
    model: data.model,
    duration_ms: data.duration_ms,
  };
  if (data.notice) out.notice = data.notice;
  if (data.aborted) out.aborted = true;
  if (data.non_resumable) out.non_resumable = true;
  if (data.exit_code !== undefined) out.exit_code = data.exit_code;
  if (Array.isArray(data.errors)) out.errors = data.errors;
  if (Array.isArray(data.warnings)) out.warnings = data.warnings;
  return out;
}

/** Session-not-found error message with recovery hint. */
export function sessionNotFoundError(ref: string): McpResult {
  return textResult(
    `Session not found: "${ref}". Use codex_session_create to start a new session, or codex_session_list to see registered sessions.`,
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
      if (opts.progressToken != null && opts.notify) {
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
  const hasPT = progressToken != null && notify != null;
  const pFile = hasPT ? createProgressFile(sessionLabel, toolName) : undefined;
  const cb = hasPT ? makeEventCallback({ progressFile: pFile!, progressToken, notify }) : undefined;
  try {
    return await handler(cb);
  } finally {
    if (pFile) removeProgressFile(pFile);
  }
}

export async function handleSessionCreate(input: CodexSessionCreateInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  // input.name is always set by the dispatcher before calling this handler.
  // The fallback here is defensive — ensures safe direct invocation.
  const sessionName = input.name ?? `session-${Date.now()}`;
  const controller = registerExecution(sessionName);
  try {
    const result = await executeOneShot(input.prompt, input.model, input.working_directory, input.reasoning_effort, onEvent, controller.signal);

    if (!result.threadId) {
      return jsonResult({
        response: result.response,
        notice: result.aborted
          ? 'Aborted before thread ID was received. This session cannot be resumed.'
          : 'No thread ID returned by Codex. Session not registered.',
        ...(result.aborted ? { aborted: true, non_resumable: true } : {}),
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result),
      });
    }

    mgr.register(sessionName, result.threadId, result.model, input.working_directory ?? process.cwd());

    return jsonResult({
      response: result.response,
      thread_id: result.threadId,
      session_name: sessionName,
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  } finally {
    unregisterExecution(sessionName, controller);
  }
}

export async function handleSessionSend(input: CodexSessionSendInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  // Note: dispatcher also checks session existence for send before calling here.
  // This internal guard ensures safe direct invocation of this handler.
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const controller = registerExecution(entry.name);
  try {
    const result = await executeResume(entry.codexThreadId, input.prompt, input.model, input.working_directory ?? entry.workingDirectory, input.reasoning_effort, onEvent, controller.signal);
    mgr.updateSession(entry.name, input.model ? { model: input.model } : undefined);

    return jsonResult({
      response: result.response,
      // Fall back to the known entry thread ID when abort fires before thread.started re-emits.
      // The session remains resumable regardless; callers should rely on session name for resume.
      thread_id: result.threadId ?? entry.codexThreadId,
      session_name: entry.name,
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  } finally {
    unregisterExecution(entry.name, controller);
  }
}

export function handleSessionList(mgr: SessionManager): McpResult {
  const registered = mgr.list().map((s) => ({
    name: s.name,
    thread_id: s.codexThreadId,
    model: s.model,
    created_at: s.createdAt,
    last_used_at: s.lastUsedAt,
    working_directory: s.workingDirectory,
    status: isExecutionActive(s.name) ? 'running' : 'completed',
  }));

  return jsonResult({ sessions: registered, total: registered.length });
}

export async function handleSessionFork(input: CodexSessionForkInput, mgr: SessionManager, onEvent?: OnEventCallback): Promise<McpResult> {
  // Note: dispatcher checks session existence for fork background mode only.
  // Foreground path delegates this check here — intentional asymmetry to avoid double lookup.
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const cwd = input.working_directory ?? entry.workingDirectory;
  const forkName = input.name ?? entry.name;
  const controller = registerExecution(forkName);
  try {
    const result = await executeFork(entry.codexThreadId, input.prompt, input.model, cwd, input.reasoning_effort, onEvent, controller.signal);

    if (input.name && result.threadId) {
      mgr.register(input.name, result.threadId, result.model, cwd ?? process.cwd());
    }

    return jsonResult({
      response: result.response,
      thread_id: result.threadId,
      forked_from: entry.codexThreadId,
      ...(input.name ? { session_name: input.name } : {}),
      model: result.model,
      duration_ms: result.durationMs,
      ...resultExtras(result),
    });
  } finally {
    unregisterExecution(forkName, controller);
  }
}

export async function handleSessionAbort(input: CodexSessionAbortInput, mgr: SessionManager): Promise<McpResult> {
  const entry = mgr.get(input.session);
  const sessionName = entry?.name ?? input.session;
  const aborted = abortExecution(sessionName);
  if (!aborted) {
    return textResult(
      `No active execution found for session "${input.session}" in this process. The session may have already completed, still be initializing (thread ID not yet registered), or belong to a different MCP server instance.`,
      true,
    );
  }
  return jsonResult({ session_name: sessionName, status: 'abort_requested' });
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
      case 'codex_session_create': {
        const input = codexSessionCreateSchema.parse(rawArgs);
        // Dispatcher owns session name generation to ensure a consistent label for background tracking.
        const sessionName = input.name ?? `session-${Date.now()}`;
        const createInput = { ...input, name: sessionName };

        if (input.background) {
          return launchBackground(sessionName, name, (cb) =>
            handleSessionCreate(createInput, sessionManager, cb));
        }

        return runForeground(sessionName, name, progressToken, notify, (cb) =>
          handleSessionCreate(createInput, sessionManager, cb));
      }
      case 'codex_session_send': {
        const input = codexSessionSendSchema.parse(rawArgs);
        // Early session check at dispatcher level.
        // handleSessionSend also checks internally for safe direct invocation (defense in depth).
        const entry = sessionManager.get(input.session);
        if (!entry) return sessionNotFoundError(input.session);

        if (input.background) {
          return launchBackground(entry.name, name, (cb) =>
            handleSessionSend(input, sessionManager, cb));
        }

        return runForeground(entry.name, name, progressToken, notify, (cb) =>
          handleSessionSend(input, sessionManager, cb));
      }
      case 'codex_session_list':
        codexSessionListSchema.parse(rawArgs);
        return handleSessionList(sessionManager);
      case 'codex_session_fork': {
        const input = codexSessionForkSchema.parse(rawArgs);
        const entry = sessionManager.get(input.session);

        if (input.background) {
          // Background requires session to exist for label resolution before launching.
          if (!entry) return sessionNotFoundError(input.session);
          return launchBackground(input.name ?? entry.name, name, (cb) =>
            handleSessionFork(input, sessionManager, cb));
        }

        // Foreground: session existence check is delegated to handleSessionFork.
        // This avoids a double lookup since the handler always reads the session anyway.
        const label = input.name ?? entry?.name ?? input.session;
        return runForeground(label, name, progressToken, notify, (cb) =>
          handleSessionFork(input, sessionManager, cb));
      }
      case 'codex_session_abort': {
        const input = codexSessionAbortSchema.parse(rawArgs);
        return handleSessionAbort(input, sessionManager);
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
