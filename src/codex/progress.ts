/**
 * Progress file utilities for Codex execution visibility.
 * Pure helpers - no server dependencies.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexThreadEvent } from '../types.js';

export type JobStatus = {
  status: 'running' | 'completed' | 'error';
  session?: string;
  session_name?: string;
  model?: string;
  duration_ms?: number;
  error?: string;
  startedAt?: number;
};

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

const STATUS_FILE = 'status.json';
const STATUS_TMP_FILE = 'status.json.tmp';
const PROGRESS_FILE = 'progress.jsonl';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStatusFile(jobDir: string): JobStatus | null {
  try {
    return JSON.parse(readFileSync(join(jobDir, STATUS_FILE), 'utf-8')) as JobStatus;
  } catch {
    return null;
  }
}

function writeStatusFile(jobDir: string, status: Record<string, unknown>): void {
  const tmpPath = join(jobDir, STATUS_TMP_FILE);
  const finalPath = join(jobDir, STATUS_FILE);
  writeFileSync(tmpPath, JSON.stringify(status));
  renameSync(tmpPath, finalPath);
}

function isTerminal(status: JobStatus): boolean {
  return status.status === 'completed' || status.status === 'error';
}

export function createJobDir(sessionLabel: string): { jobId: string; jobDir: string } {
  const jobId = randomUUID();
  const jobDir = join(JOBS_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });
  writeStatusFile(jobDir, {
    status: 'running',
    session_name: sessionLabel,
    startedAt: Date.now(),
  });
  writeFileSync(join(jobDir, PROGRESS_FILE), '');
  return { jobId, jobDir };
}

export function writeJobResult(jobDir: string, responseText: string, metadata: Record<string, unknown>): void {
  const currentStatus = readStatusFile(jobDir);
  if (currentStatus && isTerminal(currentStatus)) {
    return;
  }

  const resultTmpPath = join(jobDir, 'result.md.tmp');
  const resultPath = join(jobDir, 'result.md');
  writeFileSync(resultTmpPath, responseText);
  renameSync(resultTmpPath, resultPath);

  writeStatusFile(jobDir, {
    status: 'completed',
    ...metadata,
  });
}

export function writeJobError(jobDir: string, error: string): void {
  const currentStatus = readStatusFile(jobDir);
  if (currentStatus && isTerminal(currentStatus)) {
    return;
  }

  writeStatusFile(jobDir, {
    status: 'error',
    error,
    ...(currentStatus?.session_name ? { session_name: currentStatus.session_name } : {}),
    ...(currentStatus?.session ? { session: currentStatus.session } : {}),
  });
}

export function readJobStatus(jobDir: string): JobStatus {
  try {
    const parsed = JSON.parse(readFileSync(join(jobDir, STATUS_FILE), 'utf-8')) as JobStatus;
    if (parsed.status === 'running' || parsed.status === 'completed' || parsed.status === 'error') {
      return parsed;
    }
  } catch {}
  return { status: 'running' };
}

export function resolveJobDir(jobId: string): string {
  if (!UUID_REGEX.test(jobId)) {
    throw new Error('Invalid job ID format');
  }
  return join(JOBS_DIR, jobId);
}

/** Extract a human-readable progress message from a Codex JSONL event. */
export function extractProgressMessage(event: CodexThreadEvent): string | null {
  if (event.type === 'turn.started') return 'Processing...';
  if (event.type !== 'item.completed') return null;

  const item = event.item;
  switch (item.type) {
    case 'reasoning':
      return typeof item.text === 'string' ? item.text.slice(0, 120) : null;
    case 'web_search':
      return typeof item.query === 'string' ? `Searching: ${item.query}` : null;
    case 'agent_message':
      return 'Generating response...';
    case 'command_execution':
      return typeof item.command === 'string' ? `Running: ${item.command}` : null;
    case 'file_change': {
      const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined;
      return `Editing: ${typeof firstChange?.path === 'string' ? firstChange.path : 'file'}`;
    }
    case 'mcp_tool_call':
      return typeof item.tool === 'string' ? `Calling: ${item.tool}` : null;
    default:
      return null;
  }
}

/** Append a progress event to the file. */
export function appendProgressEvent(filePath: string, eventType: string, message: string): void {
  try { appendFileSync(filePath, JSON.stringify({ ts: Date.now(), event: eventType, message }) + '\n'); }
  catch { /* file write must not break execution */ }
}
