/**
 * Coral MCP Server - business logic handlers and utilities.
 * Extracted from server.ts to enable independent testing.
 * server.ts is the composition root (wiring only).
 */

import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli, type CliInfo } from './cli-detection.js';
import type { SessionManager } from '../../runner/session-manager.js';
import {
  codexOpSchema,
  coralAgentSchema,
  type CodexOpInput,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
  type CodexSessionAbortInput,
} from './schemas.js';
import type { CodexThreadEvent } from '../../types.js';
import {
  extractProgressMessage,
  appendProgressEvent,
} from './progress.js';
import {
  launchJob as launchRunnerJob,
  type OnEventCallback,
} from '../../runner/job-manager.js';
import type { CompletionMetadata } from '../../runner/types.js';
import { type McpResult, textResult, jsonResult } from '../../shared/mcp-utils.js';
import { sessionNotFoundError, handleSessionList, handleSessionAbort } from '../session-ops.js';
import { resultExtras } from './mcp-utils.js';
import type { NotifyFn, ProviderAdapter } from '../types.js';

export const codexTool = {
  name: 'codex',
  description: 'Execute a prompt with OpenAI Codex CLI. Use op field to select exec/list/fork/abort. For agent delegation, use op: "coral:<agent-name>" (e.g., coral:scanner, coral:architect).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      op: {
        type: 'string',
        description: 'Operation to run: exec/list/fork/abort, or coral:<agent> for agent delegation (e.g., coral:scanner, coral:architect)',
      },
      session: { type: 'string', description: 'Session UUID for resume (exec/fork/abort)' },
      prompt: { type: 'string', description: 'Prompt to send (exec required, fork optional)' },
      name: { type: 'string', description: 'Session name (exec/fork optional)' },
      model: { type: 'string', description: 'Codex model to use' },
      working_directory: { type: 'string', description: 'Working directory for Codex execution' },
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
      bypass: { type: 'boolean', description: 'Bypass Codex sandbox and approval checks. Only set when the user explicitly requests bypass mode.', default: false },
    },
    required: ['op'],
  },
};

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
  const threadId = typeof data.thread_id === 'string' ? data.thread_id : null;
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
    sessionId: threadId ?? undefined,
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
  _mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
): Promise<McpResult> {
  const sessionName = input.name ?? `session-${Date.now()}`;
  const result = await executeOneShot(
    input.prompt,
    input.model,
    input.working_directory,
    input.effort,
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
  if (!entry) return sessionNotFoundError(input.session, 'codex');
  const sessionName = entry.name;
  const workingDirectory = input.working_directory ?? entry.workingDirectory;
  const modelUpdate = input.model ? { model: input.model } : undefined;

  const result = await executeResume(
    entry.threadId,
    input.prompt,
    input.model,
    workingDirectory,
    input.effort,
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

export function handleCodexSessionList(mgr: SessionManager): McpResult {
  return handleSessionList(mgr, 'codex');
}

export async function handleSessionFork(
  input: CodexSessionForkInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
): Promise<McpResult> {
  const entry = mgr.get('codex', input.session);
  if (!entry) return sessionNotFoundError(input.session, 'codex');

  const cwd = input.working_directory ?? entry.workingDirectory;
  const result = await executeFork(
    entry.threadId,
    input.prompt,
    input.model,
    cwd,
    input.effort,
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

export function handleCodexSessionAbort(input: CodexSessionAbortInput): McpResult {
  return handleSessionAbort(input.session, 'codex');
}

async function handleExecOp(
  input: Extract<CodexOpInput, { op: 'exec' }>,
  sessionManager: SessionManager,
): Promise<McpResult> {
  const { op: _op, session: sessionRef, ...rest } = input;

  if (!sessionRef) {
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

  const { name: _name, ...sendRest } = rest;
  const entry = sessionManager.get('codex', sessionRef);
  if (!entry) return sessionNotFoundError(sessionRef, 'codex');

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

async function handleForkOp(
  input: Extract<CodexOpInput, { op: 'fork' }>,
  sessionManager: SessionManager,
): Promise<McpResult> {
  const { op: _op, ...forkInput } = input;
  const entry = sessionManager.get('codex', forkInput.session);
  if (!entry) return sessionNotFoundError(forkInput.session, 'codex');

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

async function handleParsedCodexOp(
  input: CodexOpInput,
  sessionManager: SessionManager,
): Promise<McpResult> {
  switch (input.op) {
    case 'exec':
      return handleExecOp(input, sessionManager);
    case 'list':
      return handleCodexSessionList(sessionManager);
    case 'fork':
      return handleForkOp(input, sessionManager);
    case 'abort':
      return handleCodexSessionAbort(input);
    default: {
      const _exhaustive: never = input;
      return textResult(`Unhandled op: ${(_exhaustive as CodexOpInput).op}`, true);
    }
  }
}

export async function handleCodexCoralOp(
  coralName: string,
  coralContent: string,
  rawArgs: Record<string, unknown>,
  mgr: SessionManager,
  _progressToken?: string | number,
  _notify?: NotifyFn,
): Promise<McpResult> {
  const parsed = coralAgentSchema.safeParse(rawArgs);
  if (!parsed.success) throw parsed.error;
  const input = parsed.data;

  const augmentedPrompt = `${coralContent}\n\n---\n\n${input.prompt}`;

  if (!input.session) {
    const preflight = await preflightCliCheck();
    if (!preflight.pass) return preflight.result;

    const sessionName = input.name ?? `${coralName}-${Date.now()}`;
    const createInput: CodexSessionCreateInput & { name: string } = {
      prompt: augmentedPrompt,
      name: sessionName,
      model: input.model,
      working_directory: input.working_directory,
      effort: input.effort,
      bypass: true,
    };
    return launchJob(
      sessionName,
      (signal, onEvent) => handleSessionCreate(createInput, mgr, signal, onEvent, preflight.cli),
      mgr,
      createInput.working_directory ?? process.cwd(),
    );
  }

  const entry = mgr.get('codex', input.session);
  if (!entry) return sessionNotFoundError(input.session, 'codex');

  const preflight = await preflightCliCheck();
  if (!preflight.pass) return preflight.result;

  const workingDirectory = input.working_directory ?? entry.workingDirectory;
  const sendInput: CodexSessionSendInput = {
    prompt: augmentedPrompt,
    session: input.session,
    model: input.model,
    working_directory: workingDirectory,
    effort: input.effort,
    bypass: true,
  };
  return launchJob(
    entry.name,
    (signal, onEvent) => handleSessionSend(sendInput, mgr, signal, onEvent, preflight.cli, input.session),
    mgr,
    workingDirectory,
  );
}

export async function handleCodexOp(
  rawArgs: Record<string, unknown>,
  sessionManager: SessionManager,
  _progressToken?: string | number,
  _notify?: NotifyFn,
): Promise<McpResult> {
  const rawOp = (rawArgs as { op?: unknown }).op;
  const parsed = codexOpSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const hasUnknownDiscriminator = parsed.error.issues.some((issue) => issue.code === 'invalid_union_discriminator');
    if (rawOp !== undefined && hasUnknownDiscriminator) {
      return jsonResult({ error: 'unknown_op', op: rawOp });
    }
    throw parsed.error;
  }

  return handleParsedCodexOp(parsed.data, sessionManager);
}

export const codexAdapter: ProviderAdapter = {
  name: 'codex',
  tool: codexTool,
  handleOp: handleCodexOp,
  handleCoralOp: handleCodexCoralOp,
  extractCompletion: extractCompletionData,
  makeOnEvent: ({ progressFile }) => makeEventCallback(progressFile),
};
