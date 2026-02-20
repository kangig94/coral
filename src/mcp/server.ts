/** Coral MCP Server — stdio transport for Codex CLI integration. */

declare const __VERSION__: string;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { executeOneShot, executeResume, executeFork, killAllChildren } from './codex-executor.js';
import { SessionManager } from './session-manager.js';
import {
  codexSessionCreateSchema,
  codexSessionSendSchema,
  codexSessionListSchema,
  codexSessionForkSchema,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
} from './schemas.js';
import type { CodexThreadEvent } from '../types.js';
import { createProgressFile, removeProgressFile, extractProgressId, extractProgressMessage, appendProgressEvent, appendFinalResult } from './progress.js';

const tools = [
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
    description:
      'Send a follow-up prompt to an existing Codex session. Resumes the conversation.',
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
    description:
      'List all Coral-registered Codex sessions.',
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
];

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

function jsonResult(data: Record<string, unknown>) {
  return textResult(JSON.stringify(data, null, 2));
}

/** Conditional error/warning fields for Codex result responses. */
function resultExtras(result: { exitCode: number | null; errors: string[]; warnings: string[] }): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (result.exitCode !== 0 && result.exitCode !== null) extras.exit_code = result.exitCode;
  if (result.errors.length > 0) extras.errors = result.errors;
  if (result.warnings.length > 0) extras.warnings = result.warnings;
  return extras;
}

type OnEventCallback = (line: string) => void;

/** Build an onEvent callback that writes to a progress file and optionally sends MCP notifications. */
function makeEventCallback(opts: {
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
const activeBackgroundFiles = new Set<string>();

/** Extract completion fields from a handler's JSON result for the progress file. */
function extractCompletionData(result: ReturnType<typeof jsonResult>, sessionLabel: string): Record<string, unknown> {
  const data = JSON.parse(result.content[0].text);
  return {
    response: data.response,
    thread_id: data.thread_id ?? null,
    session_name: sessionLabel,
    model: data.model,
    duration_ms: data.duration_ms,
    ...(data.notice ? { notice: data.notice } : {}),
  };
}

/**
 * Launch a handler in the background with a progress file.
 * Writes final result/error events and returns immediately with a "launched" response.
 */
function launchBackground(
  sessionLabel: string,
  toolName: string,
  handler: (cb: OnEventCallback) => Promise<ReturnType<typeof jsonResult>>,
): ReturnType<typeof jsonResult> {
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
async function runForeground(
  sessionLabel: string,
  toolName: string,
  progressToken: string | number | undefined,
  notify: ((n: { method: string; params: Record<string, unknown> }) => Promise<void>) | undefined,
  handler: (cb?: OnEventCallback) => Promise<ReturnType<typeof jsonResult>>,
): Promise<ReturnType<typeof jsonResult>> {
  const hasPT = progressToken != null && notify != null;
  const pFile = hasPT ? createProgressFile(sessionLabel, toolName) : undefined;
  const cb = hasPT ? makeEventCallback({ progressFile: pFile!, progressToken, notify }) : undefined;
  try {
    return await handler(cb);
  } finally {
    if (pFile) removeProgressFile(pFile);
  }
}

/** Session-not-found error message. */
function sessionNotFoundError(ref: string): ReturnType<typeof textResult> {
  return textResult(
    `Session not found: "${ref}". Use codex_session_create to start a new session, or codex_session_list to see registered sessions.`,
    true,
  );
}

async function handleSessionCreate(input: CodexSessionCreateInput, mgr: SessionManager, onEvent?: OnEventCallback) {
  const sessionName = input.name ?? `session-${Date.now()}`;
  const result = await executeOneShot(input.prompt, input.model, input.working_directory, input.reasoning_effort, onEvent);

  if (!result.threadId) {
    return jsonResult({
      response: result.response,
      notice: 'No thread ID returned by Codex. Session not registered.',
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
}

async function handleSessionSend(input: CodexSessionSendInput, mgr: SessionManager, onEvent?: OnEventCallback) {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const result = await executeResume(entry.codexThreadId, input.prompt, input.model, input.working_directory ?? entry.workingDirectory, input.reasoning_effort, onEvent);
  mgr.updateSession(entry.name, input.model ? { model: input.model } : undefined);

  return jsonResult({
    response: result.response,
    thread_id: result.threadId,
    session_name: entry.name,
    model: result.model,
    duration_ms: result.durationMs,
    ...resultExtras(result),
  });
}

async function handleSessionList(mgr: SessionManager) {
  const registered = mgr.list().map((s) => ({
    name: s.name,
    thread_id: s.codexThreadId,
    model: s.model,
    created_at: s.createdAt,
    last_used_at: s.lastUsedAt,
    working_directory: s.workingDirectory,
  }));

  return jsonResult({ sessions: registered, total: registered.length });
}

async function handleSessionFork(input: CodexSessionForkInput, mgr: SessionManager, onEvent?: OnEventCallback) {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const cwd = input.working_directory ?? entry.workingDirectory;
  const result = await executeFork(entry.codexThreadId, input.prompt, input.model, cwd, input.reasoning_effort, onEvent);

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
}

const server = new Server(
  { name: 'coral', version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};

  const progressToken = extra._meta?.progressToken;
  const notify = (progressToken != null && extra.sendNotification)
    ? extra.sendNotification.bind(extra)
    : undefined;

  try {
    switch (name) {
      case 'codex_session_create': {
        const input = codexSessionCreateSchema.parse(rawArgs);
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
        const entry = sessionManager.get(input.session);

        if (input.background) {
          if (!entry) return sessionNotFoundError(input.session);
          return launchBackground(entry.name, name, (cb) =>
            handleSessionSend(input, sessionManager, cb));
        }

        const label = entry?.name ?? input.session;
        return runForeground(label, name, progressToken, notify, (cb) =>
          handleSessionSend(input, sessionManager, cb));
      }
      case 'codex_session_list':
        codexSessionListSchema.parse(rawArgs);
        return await handleSessionList(sessionManager);
      case 'codex_session_fork': {
        const input = codexSessionForkSchema.parse(rawArgs);
        const entry = sessionManager.get(input.session);

        if (input.background) {
          if (!entry) return sessionNotFoundError(input.session);
          return launchBackground(input.name ?? entry.name, name, (cb) =>
            handleSessionFork(input, sessionManager, cb));
        }

        const label = input.name ?? entry?.name ?? input.session;
        return runForeground(label, name, progressToken, notify, (cb) =>
          handleSessionFork(input, sessionManager, cb));
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
});

function shutdown() {
  process.stderr.write('Coral MCP Server shutting down...\n');
  for (const pFile of activeBackgroundFiles) {
    appendFinalResult(pFile, 'error', { error: 'Server shutting down' });
  }
  activeBackgroundFiles.clear();
  killAllChildren();
  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let sessionManager: SessionManager;

async function main() {
  sessionManager = new SessionManager(process.cwd());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Coral MCP Server running on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
