import { executeClaudeOneShot, executeClaudeResume, ClaudeExecParseError } from '../claude/claude-executor.js';
import { detectClaudeCli, type ClaudeCliInfo } from '../claude/cli-detection.js';
import {
  claudeOpSchema,
  coralClaudeSchema,
  type ClaudeOpInput,
  type ClaudeCoralInput,
  type ClaudeSessionCreateInput,
  type ClaudeSessionSendInput,
  type ClaudeSessionAbortInput,
  type ClaudeWaitInput,
} from '../claude/schemas.js';
import { handleToolCall as handleCodexToolCall, tools as codexTools } from '../codex/server-handlers.js';
import { coralAgentSchema as codexCoralSchema, type CoralAgentInput as CodexCoralInput } from '../codex/schemas.js';
import {
  activeSessions,
  launchJob as launchRunnerJob,
  handleWait as handleRunnerWait,
  type OnEventCallback,
} from '../runner/job-manager.js';
import { resolveCoralContent, stripAgentMetadata } from '../runner/coral-resolver.js';
import { SessionManager } from '../runner/session-manager.js';
import type { CompletionMetadata } from '../runner/types.js';
import { type McpResult, textResult, jsonResult } from '../shared/mcp-utils.js';

type NotifyFn = (n: { method: string; params: Record<string, unknown> }) => Promise<void>;

const CORAL_OP_PREFIX = 'coral:';

const claudeTool = {
  name: 'claude',
  description: 'Execute a prompt with Claude CLI. Use op field to select exec/list/wait/abort. For agent delegation, use op: "coral:<agent-name>" (e.g., coral:architect, coral:critic).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      op: { type: 'string', description: 'Operation: exec/list/wait/abort, or coral:<agent-name> for agent delegation' },
      prompt: { type: 'string', description: 'Prompt to send (exec required)' },
      session: { type: 'string', description: 'Session ID for resume (exec with existing session)' },
      name: { type: 'string', description: 'Session name (exec optional)' },
      model: { type: 'string', description: 'Claude model to use (e.g., sonnet, opus, haiku)' },
      working_directory: { type: 'string', description: 'Working directory for execution' },
      system_prompt: { type: 'string', description: 'Additional system prompt (appended to default)' },
      bypass: { type: 'boolean', description: 'Bypass Claude permission checks. Only set when the user explicitly requests bypass mode.', default: false },
      sessions: { type: 'array', items: { type: 'string' }, description: 'Session UUIDs to monitor (wait op)' },
      timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-1200, default 600)' },
    },
    required: ['op'],
  },
};

export const tools = [codexTools[0], claudeTool];

function claudeSessionNotFoundError(ref: string): McpResult {
  return textResult(
    `Session not found: "${ref}". To resume, use a coral session UUID. Use claude({ op: "list" }) to see registered sessions, or claude({ op: "exec" }) to start a new session.`,
    true,
  );
}

const noopEventCallback: OnEventCallback = () => {};

function launchClaudeJob(
  sessionLabel: string,
  handler: (signal: AbortSignal, onEvent: OnEventCallback) => Promise<McpResult>,
  mgr: SessionManager,
  workingDirectory: string = process.cwd(),
): McpResult {
  return launchRunnerJob({
    provider: 'claude',
    sessionLabel,
    workingDirectory,
    handler,
    mgr,
    makeOnEvent: () => noopEventCallback,
    extractCompletion: (result) => extractClaudeCompletionData(result),
  });
}

function extractClaudeCompletionData(
  result: McpResult,
  _sessionLabel?: string,
): { responseText: string; metadata: CompletionMetadata; sessionId?: string } {
  const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
  const threadId = typeof data.thread_id === 'string'
    ? data.thread_id
    : typeof data.session === 'string'
      ? data.session
      : undefined;

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

async function handleClaudeSessionCreate(
  input: ClaudeSessionCreateInput,
  _mgr: SessionManager,
  signal: AbortSignal,
  _onEvent?: OnEventCallback,
  _preChecked?: ClaudeCliInfo & { available: true },
): Promise<McpResult> {
  const sessionName = input.name ?? `session-${Date.now()}`;

  let result;
  try {
    result = await executeClaudeOneShot(input.prompt, {
      model: input.model,
      workingDirectory: input.working_directory,
      systemPrompt: input.system_prompt,
      bypassPermissions: input.bypass,
      signal,
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

async function handleClaudeSessionSend(
  input: ClaudeSessionSendInput,
  mgr: SessionManager,
  signal: AbortSignal,
  _onEvent?: OnEventCallback,
  _preChecked?: ClaudeCliInfo & { available: true },
  sourceSessionId?: string,
): Promise<McpResult> {
  const entry = mgr.get('claude', input.session);
  if (!entry) return claudeSessionNotFoundError(input.session);

  const sessionName = entry.name;
  const workingDirectory = input.working_directory ?? entry.workingDirectory;

  let result;
  try {
    result = await executeClaudeResume(entry.threadId, input.prompt, {
      model: input.model,
      workingDirectory,
      systemPrompt: input.system_prompt,
      bypassPermissions: input.bypass,
      signal,
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

function handleClaudeSessionList(mgr: SessionManager): McpResult {
  const registered = mgr.list('claude').map((s) => {
    const active = activeSessions.get(s.id);
    const owner = active?.provider ?? 'codex';
    return {
      name: s.name,
      session: s.id,
      model: s.model,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      working_directory: s.workingDirectory,
      status: owner === 'claude' && active?.terminalState === 'running' ? 'running' : 'completed',
    };
  });

  return jsonResult({ sessions: registered, total: registered.length });
}

async function handleClaudeSessionAbort(input: ClaudeSessionAbortInput): Promise<McpResult> {
  const entry = activeSessions.get(input.session);
  if (!entry || entry.provider !== 'claude') {
    return textResult(
      `No active execution found for session "${input.session}". The session may have already completed or the ID is invalid.`,
      true,
    );
  }

  entry.controller.abort();
  return jsonResult({ session: input.session, session_name: entry.sessionName, status: 'abort_requested' });
}

export async function handleClaudeCoralAgent(
  input: ClaudeCoralInput,
  sessionManager: SessionManager,
): Promise<McpResult> {
  const coralName = input.op.slice(CORAL_OP_PREFIX.length);
  const resolved = resolveCoralContent(coralName);
  const systemPrompt = stripAgentMetadata(resolved.content);
  const preflight = await preflightClaudeCliCheck();
  if (!preflight.pass) return preflight.result;

  if (input.session) {
    const entry = sessionManager.get('claude', input.session);
    if (!entry) return claudeSessionNotFoundError(input.session);

    const sendInput: ClaudeSessionSendInput = {
      session: input.session,
      prompt: input.prompt,
      model: input.model,
      working_directory: input.working_directory ?? entry.workingDirectory,
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

export async function handleClaudeOp(
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  const rawOp = (rawArgs as { op?: unknown }).op;
  if (typeof rawOp === 'string' && rawOp.startsWith(CORAL_OP_PREFIX)) {
    const parsed = coralClaudeSchema.safeParse(rawArgs);
    if (!parsed.success) throw parsed.error;
    return handleClaudeCoralAgent(parsed.data, sessionManager);
  }

  const parsed = claudeOpSchema.safeParse(rawArgs);
  if (!parsed.success) {
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
        if (!entry) return claudeSessionNotFoundError(sessionRef);

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
    case 'wait':
      return handleRunnerWait('claude', input as ClaudeWaitInput, notify, progressToken);
    case 'abort':
      return handleClaudeSessionAbort(input as ClaudeSessionAbortInput);
    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as ClaudeOpInput).op}`, true);
    }
  }
}

async function handleCodexOpWithCoralResolution(
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  const rawOp = (rawArgs as { op?: unknown }).op;
  if (typeof rawOp !== 'string' || !rawOp.startsWith(CORAL_OP_PREFIX)) {
    return handleCodexToolCall('codex', rawArgs, sessionManager, progressToken, notify);
  }

  const parsed = codexCoralSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;

  const codexCoralInput: CodexCoralInput = parsed.data;
  const coralName = codexCoralInput.op.slice(CORAL_OP_PREFIX.length);
  const resolved = resolveCoralContent(coralName);
  const injectedPrompt = `${resolved.content}\n\n---\n\n${codexCoralInput.prompt}`;

  return handleCodexToolCall(
    'codex',
    {
      op: 'exec',
      prompt: injectedPrompt,
      session: codexCoralInput.session,
      name: codexCoralInput.name,
      model: codexCoralInput.model,
      working_directory: codexCoralInput.working_directory,
      reasoning_effort: codexCoralInput.reasoning_effort,
      bypass: true,
    },
    sessionManager,
    progressToken,
    notify,
  );
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  progressToken?: string | number,
  notify?: NotifyFn,
): Promise<McpResult> {
  try {
    if (name === 'codex') {
      return await handleCodexOpWithCoralResolution(rawArgs, sessionManager, progressToken, notify);
    }
    if (name === 'claude') {
      return await handleClaudeOp(rawArgs, sessionManager, progressToken, notify);
    }
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Tool ${name} error: ${message}\n`);
    return textResult(`Error: ${message}`, true);
  }
}
