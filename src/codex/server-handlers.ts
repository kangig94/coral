/**
 * Coral MCP Server - business logic handlers and utilities.
 * Extracted from server.ts to enable independent testing.
 * server.ts is the composition root (wiring only).
 */

import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { executeOneShot, executeResume, executeFork } from './codex-executor.js';
import { detectCodexCli, type CliInfo } from './cli-detection.js';
import { SessionManager } from './session-manager.js';
import {
  codexOpSchema,
  type CodexOpInput,
  type CodexSessionCreateInput,
  type CodexSessionSendInput,
  type CodexSessionForkInput,
  type CodexSessionAbortInput,
  type CodexWaitInput,
} from './schemas.js';
import type { CodexThreadEvent } from '../types.js';
import {
  createJobDir,
  writeJobResult,
  writeJobError,
  readJobStatus,
  resolveJobDir,
  JOBS_DIR,
  extractProgressMessage,
  appendProgressEvent,
} from './progress.js';
import { type McpResult, textResult, jsonResult, resultExtras } from '../shared/mcp-utils.js';

export type OnEventCallback = (line: string) => void;

export const tools = [
  {
    name: 'codex',
    description: 'Execute a prompt with OpenAI Codex CLI. Use op field to select exec/list/fork/wait/abort.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        op: {
          type: 'string',
          enum: ['exec', 'list', 'fork', 'wait', 'abort'],
          description: 'Operation to run',
        },
        session: { type: 'string', description: 'Session identifier (exec/fork/abort)' },
        prompt: { type: 'string', description: 'Prompt to send (exec required, fork optional)' },
        name: { type: 'string', description: 'Session name (exec/fork optional)' },
        model: { type: 'string', description: 'Codex model to use' },
        working_directory: { type: 'string', description: 'Working directory for Codex execution' },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Model reasoning effort level' },
        bypass: { type: 'boolean', description: 'Bypass Codex sandbox and approval checks. Only set when the user explicitly requests bypass mode.', default: false },
        job_ids: { type: 'array', items: { type: 'string' }, description: 'Job IDs to monitor (UUID, from exec/fork response)' },
        timeout_seconds: { type: 'number', description: 'Max wait time in seconds (1-600, default 300)' },
        cursors: { type: 'object', description: 'Byte offsets from prior wait call to avoid progress replay' },
        job_id: { type: 'string', description: 'Job ID (UUID) for abort. Preferred over session for deterministic abort.' },
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

type JobEntry = {
  jobDir: string;
  controller: AbortController;
  sessionName: string;
  session?: string;
  terminalState: 'running' | 'terminalizing' | 'completed' | 'error';
};

export const activeJobs = new Map<string, JobEntry>();

/** Atomically transition a job from 'running' to 'terminalizing'. Returns true if claim succeeded. */
export function tryClaimTerminalWrite(jobId: string, _finalStatus: 'completed' | 'error'): boolean {
  const entry = activeJobs.get(jobId);
  if (!entry || entry.terminalState !== 'running') return false;
  entry.terminalState = 'terminalizing';
  return true;
}

export const shutdownSignal = new AbortController();

export function extractCompletionData(
  result: McpResult,
  sessionLabel: string,
): { responseText: string; metadata: Record<string, unknown> } {
  const data = JSON.parse(result.content[0].text);
  const metadata: Record<string, unknown> = {
    session_name: sessionLabel,
    session: data.session ?? null,
    model: data.model,
    duration_ms: data.duration_ms,
  };
  if (data.notice) metadata.notice = data.notice;
  if (data.aborted) metadata.aborted = true;
  if (data.non_resumable) metadata.non_resumable = true;
  if (data.exit_code !== undefined) metadata.exit_code = data.exit_code;
  if (Array.isArray(data.errors)) metadata.errors = data.errors;
  if (Array.isArray(data.warnings)) metadata.warnings = data.warnings;
  return { responseText: data.response ?? '', metadata };
}

export function launchJob(
  sessionLabel: string,
  handler: (signal: AbortSignal, onEvent: OnEventCallback) => Promise<McpResult>,
  mgr: SessionManager,
  registerOnComplete: boolean = true,
): McpResult {
  const { jobId, jobDir } = createJobDir(sessionLabel);
  const controller = new AbortController();
  const entry: JobEntry = {
    jobDir,
    controller,
    sessionName: sessionLabel,
    terminalState: 'running',
  };
  activeJobs.set(jobId, entry);

  const progressFile = join(jobDir, 'progress.jsonl');
  const onEvent = makeEventCallback(progressFile);

  handler(controller.signal, onEvent)
    .then((result) => {
      if (!tryClaimTerminalWrite(jobId, 'completed')) return;

      const { responseText, metadata } = extractCompletionData(result, sessionLabel);
      writeJobResult(jobDir, responseText, metadata);

      const sessionId = typeof metadata.session === 'string' ? metadata.session : undefined;
      if (sessionId) {
        entry.session = sessionId;
        if (registerOnComplete) {
          const model = typeof metadata.model === 'string' ? metadata.model : 'unknown';
          mgr.register(sessionLabel, sessionId, model, process.cwd());
        }
      }

      entry.terminalState = 'completed';
    })
    .catch((err) => {
      if (!tryClaimTerminalWrite(jobId, 'error')) return;
      writeJobError(jobDir, err instanceof Error ? err.message : String(err));
      entry.terminalState = 'error';
    })
    .finally(() => {
      activeJobs.delete(jobId);
    });

  return jsonResult({ job_id: jobId, job_dir: jobDir, session_name: sessionLabel, status: 'running' });
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
    session: result.sessionId,
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
): Promise<McpResult> {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);
  const sessionName = entry.name;
  const workingDirectory = input.working_directory ?? entry.workingDirectory;
  const modelUpdate = input.model ? { model: input.model } : undefined;

  const result = await executeResume(
    entry.sessionId,
    input.prompt,
    input.model,
    workingDirectory,
    input.reasoning_effort,
    input.bypass,
    onEvent,
    signal,
    preChecked,
  );

  mgr.updateSession(sessionName, modelUpdate);

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
}

export function handleSessionList(mgr: SessionManager): McpResult {
  const runningSessionNames = new Set(
    [...activeJobs.values()]
      .filter((j) => j.terminalState === 'running')
      .map((j) => j.sessionName),
  );

  const registered = mgr.list().map((s) => ({
    name: s.name,
    session: s.sessionId,
    model: s.model,
    created_at: s.createdAt,
    last_used_at: s.lastUsedAt,
    working_directory: s.workingDirectory,
    status: runningSessionNames.has(s.name) ? 'running' : 'completed',
  }));

  return jsonResult({ sessions: registered, total: registered.length });
}

export async function handleSessionFork(
  input: CodexSessionForkInput,
  mgr: SessionManager,
  signal: AbortSignal,
  onEvent?: OnEventCallback,
  preChecked?: CliInfo & { available: true },
): Promise<McpResult> {
  const entry = mgr.get(input.session);
  if (!entry) return sessionNotFoundError(input.session);

  const cwd = input.working_directory ?? entry.workingDirectory;
  const result = await executeFork(
    entry.sessionId,
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
    session: result.sessionId,
    forked_from: entry.sessionId,
    ...(input.name ? { session_name: input.name } : {}),
    model: result.model,
    duration_ms: result.durationMs,
    ...resultExtras(result),
  });
}

export async function handleSessionAbort(input: CodexSessionAbortInput, _mgr: SessionManager): Promise<McpResult> {
  if (input.job_id && input.session) {
    return textResult('Error: Provide exactly one of job_id or session, not both.', true);
  }

  if (!input.job_id && !input.session) {
    return textResult('Error: Provide exactly one of job_id or session.', true);
  }

  if (input.job_id) {
    const entry = activeJobs.get(input.job_id);
    if (!entry) {
      return textResult(
        `No active job found for job_id "${input.job_id}". The job may have already completed or the ID is invalid.`,
        true,
      );
    }

    entry.controller.abort();
    return jsonResult({ job_id: input.job_id, session_name: entry.sessionName, status: 'abort_requested' });
  }

  const matched: string[] = [];
  for (const [jobId, entry] of activeJobs) {
    if (entry.session === input.session) {
      entry.controller.abort();
      matched.push(jobId);
    }
  }

  if (matched.length === 0) {
    return textResult(
      `No active execution found for session "${input.session}". The session may have completed, not yet emitted a session ID, or belong to a different process.`,
      true,
    );
  }

  return jsonResult({ session: input.session, matched_job_ids: matched, status: 'abort_requested' });
}

export async function handleWait(
  input: CodexWaitInput,
  notify?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>,
  progressToken?: string | number,
): Promise<McpResult> {
  const { job_ids, timeout_seconds = 300, cursors: inputCursors } = input;

  const jobDirs: Record<string, string> = {};
  for (const id of job_ids) {
    resolveJobDir(id);
    const dir = join(JOBS_DIR, id);
    if (!existsSync(dir)) {
      return textResult(`Unknown job_id: "${id}". No job directory found.`, true);
    }
    jobDirs[id] = dir;
  }

  const fds = new Map<string, number | null>(job_ids.map((id) => [id, null]));
  const cursors = new Map<string, number>(
    job_ids.map((id) => [id, inputCursors?.[id] ?? 0]),
  );

  let notifCounter = 0;
  const startMs = Date.now();
  const timeoutMs = timeout_seconds * 1000;

  const timeoutResponse = (): McpResult => {
    const running = job_ids.filter((id) => readJobStatus(jobDirs[id]!).status === 'running');
    const cursorRecord: Record<string, number> = {};
    for (const [id, offset] of cursors) cursorRecord[id] = offset;
    return jsonResult({ status: 'timeout', running_jobs: running, cursors: cursorRecord });
  };

  try {
    while (true) {
      if (shutdownSignal.signal.aborted) {
        return timeoutResponse();
      }

      if (Date.now() - startMs >= timeoutMs) {
        return timeoutResponse();
      }

      let completedId: string | null = null;
      let completedStatus: 'completed' | 'error' | null = null;

      for (const id of job_ids) {
        const dir = jobDirs[id]!;
        const progressFile = join(dir, 'progress.jsonl');

        let fd = fds.get(id) ?? null;
        if (fd === null) {
          try {
            fd = openSync(progressFile, 'r');
            fds.set(id, fd);
          } catch {
            // progress.jsonl may not exist yet
          }
        }

        if (fd !== null) {
          const offset = cursors.get(id) ?? 0;
          const chunkSize = 4096;
          const buf = Buffer.allocUnsafe(chunkSize);

          let bytesRead = 0;
          try {
            bytesRead = readSync(fd, buf, 0, chunkSize, offset);
          } catch {
            // fd read errors are ignored for this poll tick
          }

          if (bytesRead > 0) {
            const chunk = buf.subarray(0, bytesRead);
            let lastNewline = -1;
            for (let i = bytesRead - 1; i >= 0; i--) {
              if (chunk[i] === 0x0a) {
                lastNewline = i;
                break;
              }
            }

            if (lastNewline >= 0) {
              const completeBytes = chunk.subarray(0, lastNewline + 1);
              const text = completeBytes.toString('utf-8');
              const lines = text.split('\n').filter((line) => line.trim());

              for (const line of lines) {
                try {
                  const parsed = JSON.parse(line) as { event?: string; message?: string };
                  if (typeof parsed.message === 'string' && parsed.message && progressToken != null && notify != null) {
                    const statusForName = readJobStatus(dir);
                    const prefix = statusForName.session_name ?? id;
                    void notify({
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: ++notifCounter,
                        message: `[${prefix}] ${parsed.message}`,
                      },
                    }).catch(() => {});
                  }
                } catch {
                  // malformed progress line should not fail wait
                }
              }

              cursors.set(id, offset + lastNewline + 1);
            }
          }
        }

        const jobStatus = readJobStatus(dir);
        if ((jobStatus.status === 'completed' || jobStatus.status === 'error') && completedId === null) {
          completedId = id;
          completedStatus = jobStatus.status;
        }
      }

      if (completedId !== null && completedStatus !== null) {
        const dir = jobDirs[completedId]!;
        const statusData = readJobStatus(dir);
        const cursorRecord: Record<string, number> = {};
        for (const [id, offset] of cursors) {
          if (id !== completedId) cursorRecord[id] = offset;
        }

        return jsonResult({
          status: completedStatus,
          completed_job_id: completedId,
          job_dir: dir,
          session_name: statusData.session_name ?? completedId,
          cursors: cursorRecord,
        });
      }

      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          shutdownSignal.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const timer = setTimeout(() => {
          shutdownSignal.signal.removeEventListener('abort', onAbort);
          resolve();
        }, 500);
        shutdownSignal.signal.addEventListener('abort', onAbort);
      });
    }
  } finally {
    for (const [, fd] of fds) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors
        }
      }
    }
  }
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
        const entry = sessionManager.get(sessionRef);
        if (!entry) return sessionNotFoundError(sessionRef);

        const preflight = await preflightCliCheck();
        if (!preflight.pass) return preflight.result;

        const sendInput: CodexSessionSendInput = { ...sendRest, session: sessionRef };
        return launchJob(
          entry.name,
          (signal, onEvent) => handleSessionSend(sendInput, sessionManager, signal, onEvent, preflight.cli),
          sessionManager,
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
      );
    }
    case 'list':
      return handleSessionList(sessionManager);
    case 'fork': {
      const { op: _op, ...forkInput } = input;
      const entry = sessionManager.get(forkInput.session);
      if (!entry) return sessionNotFoundError(forkInput.session);

      const preflight = await preflightCliCheck();
      if (!preflight.pass) return preflight.result;

      const sessionLabel = forkInput.name ?? entry.name;
      return launchJob(
        sessionLabel,
        (signal, onEvent) => handleSessionFork(forkInput, sessionManager, signal, onEvent, preflight.cli),
        sessionManager,
        !!forkInput.name,
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

    const parsed = codexOpSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const rawOp = (rawArgs as { op?: unknown }).op;
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
