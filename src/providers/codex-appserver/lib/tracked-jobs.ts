import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.js";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso(): string {
  return new Date().toISOString();
}

interface ProgressEvent {
  message: string;
  phase: string | null;
  threadId: string | null;
  turnId: string | null;
  stderrMessage: string | null;
  logTitle: string | null;
  logBody: string | null;
}

interface ProgressEventInput {
  message?: unknown;
  phase?: unknown;
  threadId?: unknown;
  turnId?: unknown;
  stderrMessage?: unknown;
  logTitle?: unknown;
  logBody?: unknown;
}

interface JobBase {
  id: string;
  workspaceRoot: string;
  logFile?: string | null;
  [key: string]: unknown;
}

interface Execution {
  exitStatus: number;
  threadId?: string | null;
  turnId?: string | null;
  payload: unknown;
  rendered: string;
  summary: string;
}

interface RunTrackedJobOptions {
  logFile?: string | null;
}

interface CreateJobRecordOptions {
  env?: NodeJS.ProcessEnv;
  sessionIdEnv?: string;
}

interface CreateProgressReporterOptions {
  stderr?: boolean;
  logFile?: string | null;
  onEvent?: ((event: ProgressEvent) => void) | null;
}

function normalizeProgressEvent(value: unknown): ProgressEvent {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as ProgressEventInput;
    return {
      message: String(obj.message ?? "").trim(),
      phase: typeof obj.phase === "string" && (obj.phase).trim() ? (obj.phase).trim() : null,
      threadId: typeof obj.threadId === "string" && (obj.threadId).trim() ? (obj.threadId).trim() : null,
      turnId: typeof obj.turnId === "string" && (obj.turnId).trim() ? (obj.turnId).trim() : null,
      stderrMessage: obj.stderrMessage == null ? null : String(obj.stderrMessage).trim(),
      logTitle: typeof obj.logTitle === "string" && (obj.logTitle).trim() ? (obj.logTitle).trim() : null,
      logBody: obj.logBody == null ? null : String(obj.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile: string | null, message: unknown): void {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile: string | null, title: string | null, body: unknown): void {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot: string, jobId: string, title: string | null): string {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base: Record<string, unknown>, options: CreateJobRecordOptions = {}): Record<string, unknown> {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot: string, jobId: string): (event: unknown) => void {
  let lastPhase: string | null = null;
  let lastThreadId: string | null = null;
  let lastTurnId: string | null = null;

  return (event: unknown) => {
    const normalized = normalizeProgressEvent(event);
    const patch: Record<string, unknown> = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch as { id: string; [key: string]: unknown });

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile) as Record<string, unknown>;
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null }: CreateProgressReporterOptions = {}): ((eventOrMessage: unknown) => void) | null {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage: unknown) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot: string, jobId: string): Record<string, unknown> | null {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile) as Record<string, unknown>;
}

export async function runTrackedJob(job: JobBase, runner: () => Promise<Execution>, options: RunTrackedJobOptions = {}): Promise<Execution> {
  const runningRecord: Record<string, unknown> = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord as { id: string; [key: string]: unknown });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? (existing).logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
