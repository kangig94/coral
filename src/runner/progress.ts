import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvider } from './types.js';

export type SessionStatus = {
  status: 'running' | 'completed' | 'error';
  provider?: SessionProvider;
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
const READ_CHUNK = 8 * 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function readNewProgressLines(progressFile: string, cursor: ProgressCursor): string[] {
  let fd: number;
  try {
    fd = openSync(progressFile, 'r');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }

  try {
    const chunks: string[] = [];
    const buffer = Buffer.alloc(READ_CHUNK);
    let nextOffset = cursor.lastOffset;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, READ_CHUNK, nextOffset);
      if (bytesRead <= 0) break;
      nextOffset += bytesRead;
      chunks.push(buffer.toString('utf-8', 0, bytesRead));
      if (bytesRead < READ_CHUNK) break;
    }

    cursor.lastOffset = nextOffset;
    if (chunks.length === 0) return [];

    const combined = cursor.remainder + chunks.join('');
    const lines = combined.split('\n');
    cursor.remainder = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    closeSync(fd);
  }
}

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

export function createSessionDir(sessionLabel: string, provider: SessionProvider = 'codex'): { id: string; dir: string } {
  const id = randomUUID();
  const dir = join(SESSIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeStatusFile(dir, {
    status: 'running',
    provider,
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
    ...(currentStatus?.provider ? { provider: currentStatus.provider } : {}),
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

export function appendProgressEvent(filePath: string, eventType: string, message: string): void {
  try { appendFileSync(filePath, JSON.stringify({ ts: Date.now(), event: eventType, message }) + '\n'); }
  catch { /* file write must not break execution */ }
}

export type ProgressEvent = { ts: number; event: string; message: string };

export type ProgressCursor = {
  lastOffset: number;
  remainder: string;
};

export function createProgressCursor(): ProgressCursor {
  return { lastOffset: 0, remainder: '' };
}

export function readProgressEvents(progressFile: string, cursor: ProgressCursor): ProgressEvent[] {
  const lines = readNewProgressLines(progressFile, cursor);
  const events: ProgressEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.message === 'string' && parsed.message) {
        events.push({
          ts: typeof parsed.ts === 'number' ? parsed.ts : 0,
          event: typeof parsed.event === 'string' ? parsed.event : '',
          message: parsed.message,
        });
      }
    } catch {
      // malformed progress line should not fail reads
    }
  }
  return events;
}
