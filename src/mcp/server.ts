/**
 * Coral MCP Server — stdio transport.
 *
 * Exposes 5 tools for Codex CLI integration:
 * - codex_execute: One-shot execution
 * - codex_session_create: Create a named session
 * - codex_session_send: Continue an existing session
 * - codex_session_list: List sessions
 * - codex_session_fork: Fork a session (resume-based simulation)
 */

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
  codexExecuteSchema,
  codexSessionCreateSchema,
  codexSessionSendSchema,
  codexSessionListSchema,
  codexSessionForkSchema,
  type CodexExecuteInput,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'codex_execute',
    description:
      'Execute a one-shot prompt with OpenAI Codex CLI. Returns the Codex response, thread ID, model, duration, and any errors/warnings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to Codex (required)' },
        model: { type: 'string', description: 'Codex model to use (default: gpt-5.3-codex)' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        save_session: { type: 'string', description: 'If provided, save the session with this name to the registry' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'codex_session_create',
    description:
      'Create a new named Codex session. Executes the prompt and registers the session for later continuation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name for this session (required)' },
        prompt: { type: 'string', description: 'Initial prompt to start the session (required)' },
        model: { type: 'string', description: 'Codex model to use (default: gpt-5.3-codex)' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
      },
      required: ['name', 'prompt'],
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
      },
      required: ['session'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

/** Conditional fields shared by all Codex result responses. */
function resultExtras(result: { exitCode: number | null; errors: string[]; warnings: string[] }) {
  return {
    ...(result.exitCode !== 0 && result.exitCode !== null ? { exit_code: result.exitCode } : {}),
    ...(result.errors.length > 0 ? { errors: result.errors } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

async function handleCodexExecute(input: CodexExecuteInput, mgr: SessionManager) {
  const result = await executeOneShot(input.prompt, input.model, input.working_directory);

  if (input.save_session && result.threadId) {
    mgr.register(input.save_session, result.threadId, result.model, input.working_directory ?? process.cwd());
  }

  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        model: result.model,
        duration_ms: result.durationMs,
        ...(input.save_session ? { saved_as: input.save_session } : {}),
        ...resultExtras(result),
      },
      null,
      2,
    ),
  );
}

async function handleSessionCreate(input: CodexSessionCreateInput, mgr: SessionManager) {
  const result = await executeOneShot(input.prompt, input.model, input.working_directory);

  if (!result.threadId) {
    return textResult(
      JSON.stringify({
        response: result.response,
        notice: 'No thread ID returned by Codex. Session not registered.',
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result),
      }, null, 2),
    );
  }

  mgr.register(input.name, result.threadId, result.model, input.working_directory ?? process.cwd());

  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        session_name: input.name,
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result),
      },
      null,
      2,
    ),
  );
}

async function handleSessionSend(input: CodexSessionSendInput, mgr: SessionManager) {
  const entry = mgr.get(input.session);

  if (!entry) {
    // Fallback: treat input.session as a raw Codex thread ID.
    // Safe: spawn() without shell:true passes args as-is to execve (no injection).
    const result = await executeResume(input.session, input.prompt, input.model, input.working_directory);
    return textResult(
      JSON.stringify(
        {
          response: result.response,
          thread_id: result.threadId,
          model: result.model,
          duration_ms: result.durationMs,
          ...(result.exitCode !== 0 && result.exitCode !== null ? { exit_code: result.exitCode } : {}),
          ...(result.errors.length > 0 ? { errors: result.errors } : {}),
          ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        },
        null,
        2,
      ),
    );
  }

  const result = await executeResume(entry.codexThreadId, input.prompt, input.model, input.working_directory ?? entry.workingDirectory);
  mgr.updateSession(entry.name, input.model ? { model: input.model } : undefined);

  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        session_name: entry.name,
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result),
      },
      null,
      2,
    ),
  );
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

  return textResult(
    JSON.stringify(
      { sessions: registered, total: registered.length },
      null,
      2,
    ),
  );
}

async function handleSessionFork(input: CodexSessionForkInput, mgr: SessionManager) {
  const entry = mgr.get(input.session);
  const sourceId = entry?.codexThreadId ?? input.session;
  const cwd = input.working_directory ?? entry?.workingDirectory;

  const result = await executeFork(sourceId, input.prompt, input.model, cwd);

  if (input.name && result.threadId) {
    mgr.register(input.name, result.threadId, result.model, cwd ?? process.cwd());
  }

  return textResult(
    JSON.stringify(
      {
        response: result.response,
        thread_id: result.threadId,
        forked_from: sourceId,
        ...(input.name ? { session_name: input.name } : {}),
        model: result.model,
        duration_ms: result.durationMs,
        ...resultExtras(result),
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'coral', version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const rawArgs = args ?? {};

  try {
    switch (name) {
      case 'codex_execute':
        return await handleCodexExecute(codexExecuteSchema.parse(rawArgs), sessionManager);
      case 'codex_session_create':
        return await handleSessionCreate(codexSessionCreateSchema.parse(rawArgs), sessionManager);
      case 'codex_session_send':
        return await handleSessionSend(codexSessionSendSchema.parse(rawArgs), sessionManager);
      case 'codex_session_list':
        codexSessionListSchema.parse(rawArgs);
        return await handleSessionList(sessionManager);
      case 'codex_session_fork':
        return await handleSessionFork(codexSessionForkSchema.parse(rawArgs), sessionManager);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  process.stderr.write('Coral MCP Server shutting down...\n');
  killAllChildren();
  server.close().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
