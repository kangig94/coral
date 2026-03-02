/**
 * Progress file utilities for Codex execution visibility.
 * Pure helpers - no server dependencies.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexThreadEvent } from '../types.js';

export type SessionStatus = {
  status: 'running' | 'completed' | 'error';
  thread_id?: string;
  session_name?: string;
  model?: string;
  duration_ms?: number;
  error?: string;
  startedAt?: number;
};

export const SESSIONS_DIR = join(tmpdir(), 'coral-sessions');

const STATUS_FILE = 'status.json';
const STATUS_TMP_FILE = 'status.json.tmp';
export const PROGRESS_FILE = 'progress.jsonl';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readStatusFile(sessionDir: string): SessionStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(join(sessionDir, STATUS_FILE), 'utf-8')) as SessionStatus;
    if (parsed.status === 'running' || parsed.status === 'completed' || parsed.status === 'error') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStatusFile(sessionDir: string, status: Record<string, unknown>): void {
  const tmpPath = join(sessionDir, STATUS_TMP_FILE);
  const finalPath = join(sessionDir, STATUS_FILE);
  writeFileSync(tmpPath, JSON.stringify(status));
  renameSync(tmpPath, finalPath);
}

function isTerminal(status: SessionStatus): boolean {
  return status.status === 'completed' || status.status === 'error';
}

export function createSessionDir(sessionLabel: string): { id: string; dir: string } {
  const id = randomUUID();
  const dir = join(SESSIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeStatusFile(dir, {
    status: 'running',
    session_name: sessionLabel,
    startedAt: Date.now(),
  });
  writeFileSync(join(dir, PROGRESS_FILE), '');
  return { id, dir };
}

export function writeSessionResult(sessionDir: string, responseText: string, metadata: Record<string, unknown>): void {
  const currentStatus = readStatusFile(sessionDir);
  if (currentStatus && isTerminal(currentStatus)) {
    return;
  }

  const resultTmpPath = join(sessionDir, 'result.md.tmp');
  const resultPath = join(sessionDir, 'result.md');
  writeFileSync(resultTmpPath, responseText);
  renameSync(resultTmpPath, resultPath);

  writeStatusFile(sessionDir, {
    status: 'completed',
    ...metadata,
  });
}

export function writeSessionError(sessionDir: string, error: string): void {
  const currentStatus = readStatusFile(sessionDir);
  if (currentStatus && isTerminal(currentStatus)) {
    return;
  }

  writeStatusFile(sessionDir, { ...currentStatus, status: 'error', error });
}

export function readSessionStatus(sessionDir: string): SessionStatus {
  return readStatusFile(sessionDir) ?? { status: 'running' };
}

export function resolveSessionDir(id: string): string {
  if (!UUID_REGEX.test(id)) {
    throw new Error('Invalid session ID format');
  }
  return join(SESSIONS_DIR, id);
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

/** Format elapsed seconds since job start as a compact duration string. */
export function formatElapsed(startedAt: number | undefined): string {
  if (startedAt == null) return '';
  const total = Math.floor((Date.now() - startedAt) / 1000);
  if (total < 0) return '0s';
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

/** Append a progress event to the file. */
export function appendProgressEvent(filePath: string, eventType: string, message: string): void {
  try { appendFileSync(filePath, JSON.stringify({ ts: Date.now(), event: eventType, message }) + '\n'); }
  catch { /* file write must not break execution */ }
}
