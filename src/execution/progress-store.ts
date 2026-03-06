import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  JobKind,
  JobPhase,
  LaunchState,
  PersistedProgressRecord,
  PersistedStatusRecord,
  TerminalResult,
} from '../types.js';
import { isNoEntryError } from '../shared/mcp-utils.js';

export const JOBS_DIR = join(tmpdir(), 'coral-jobs');

const STATUS_FILE = 'status.json';
const PROGRESS_FILE = 'progress.jsonl';
const READ_CHUNK = 8 * 1024;

const readBuffer = Buffer.alloc(READ_CHUNK);

export type ReplayCursor = { lastOffset: number; remainder: string };

export function jobResultPath(jobId: string): string {
  return join(JOBS_DIR, jobId, 'result.md');
}

export function createReplayCursor(): ReplayCursor {
  return { lastOffset: 0, remainder: '' };
}

export class ProgressStore {
  private readonly eventCounters = new Map<string, number>();

  jobDir(jobId: string): string {
    return join(JOBS_DIR, jobId);
  }

  private statusPath(jobId: string): string {
    return join(this.jobDir(jobId), STATUS_FILE);
  }

  private progressPath(jobId: string): string {
    return join(this.jobDir(jobId), PROGRESS_FILE);
  }

  private nextEventId(jobId: string): number {
    const current = this.eventCounters.get(jobId) ?? 0;
    const next = current + 1;
    this.eventCounters.set(jobId, next);
    return next;
  }

  /** Create the job directory and write initial status.json. */
  initJob(jobId: string, sessionId: string, provider: string, jobKind?: JobKind): void {
    const dir = this.jobDir(jobId);
    mkdirSync(dir, { recursive: true });
    const record: PersistedStatusRecord = {
      jobId,
      sessionId,
      provider,
      phase: 'launching',
      launch: { state: 'pending', updatedAt: new Date().toISOString() },
    };
    if (jobKind !== undefined) {
      record.jobKind = jobKind;
    }
    this.writeStatus(jobId, record);
    writeFileSync(this.progressPath(jobId), '');
  }

  /** Atomically write status.json. */
  writeStatus(jobId: string, record: PersistedStatusRecord): void {
    const filePath = this.statusPath(jobId);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  /** Read status.json. Returns null if not found or corrupt. */
  readStatus(jobId: string): PersistedStatusRecord | null {
    try {
      const data = readFileSync(this.statusPath(jobId), 'utf-8');
      return JSON.parse(data) as PersistedStatusRecord;
    } catch {
      return null;
    }
  }

  /** Update launch state in status.json (read-modify-write atomically). */
  updateLaunchState(jobId: string, state: LaunchState, message?: string): void {
    const record = this.readStatus(jobId);
    if (!record) return;
    record.launch = { state, message, updatedAt: new Date().toISOString() };
    this.writeStatus(jobId, record);
  }

  /** Update job phase in status.json. */
  updatePhase(jobId: string, phase: JobPhase): void {
    const record = this.readStatus(jobId);
    if (!record) return;
    record.phase = phase;
    this.writeStatus(jobId, record);
  }

  /** Append a progress event to progress.jsonl. Returns the eventId. */
  appendProgress(jobId: string, sessionId: string, message: string): number {
    const eventId = this.nextEventId(jobId);
    const entry: PersistedProgressRecord = {
      jobId,
      sessionId,
      eventId,
      type: 'progress',
      ts: new Date().toISOString(),
      message,
    };
    try {
      appendFileSync(this.progressPath(jobId), JSON.stringify(entry) + '\n');
    } catch {
      /* progress write must not break execution */
    }
    return eventId;
  }

  /** Append a terminal event to progress.jsonl and update status.json with terminal result. */
  appendTerminal(jobId: string, sessionId: string, result: TerminalResult, phase: JobPhase): number {
    const eventId = this.nextEventId(jobId);
    const entry: PersistedProgressRecord = {
      jobId,
      sessionId,
      eventId,
      type: 'terminal',
      ts: new Date().toISOString(),
      result,
    };
    try {
      appendFileSync(this.progressPath(jobId), JSON.stringify(entry) + '\n');
    } catch {
      /* progress write must not break execution */
    }

    const record = this.readStatus(jobId);
    if (record) {
      record.phase = phase;
      record.result = result;
      this.writeStatus(jobId, record);
    }

    this.eventCounters.delete(jobId);
    return eventId;
  }

  /** Write result.md as a debugging/recovery artifact. */
  writeResultMd(jobId: string, text: string): void {
    const dir = this.jobDir(jobId);
    const tmpPath = `${jobResultPath(jobId)}.tmp`;
    const finalPath = jobResultPath(jobId);
    try {
      writeFileSync(tmpPath, text, 'utf-8');
      renameSync(tmpPath, finalPath);
    } catch {
      /* result.md write must not break execution */
    }
  }

  writeWorkflowResultMdOrThrow(jobId: string, text: string): void {
    const dir = this.jobDir(jobId);
    const finalPath = jobResultPath(jobId);
    const tmpPath = `${finalPath}.tmp`;
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(tmpPath, text, 'utf-8');
      renameSync(tmpPath, finalPath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  /**
   * Replay progress events from a job starting after fromEventId (exclusive).
   * Returns all events with eventId > fromEventId, in order.
   */
  replayFrom(jobId: string, fromEventId: number, cursor: ReplayCursor): PersistedProgressRecord[] {
    const lines = this.readNewLines(this.progressPath(jobId), cursor);
    const events: PersistedProgressRecord[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as PersistedProgressRecord;
        if (typeof record.eventId === 'number' && record.eventId > fromEventId) {
          events.push(record);
        }
      } catch {
        // malformed line - skip
      }
    }
    return events;
  }

  private readNewLines(filePath: string, cursor: ReplayCursor): string[] {
    let fd: number;
    try {
      fd = openSync(filePath, 'r');
    } catch (error: unknown) {
      if (isNoEntryError(error)) return [];
      throw error;
    }
    try {
      const chunks: string[] = [];
      let nextOffset = cursor.lastOffset;
      while (true) {
        const bytesRead = readSync(fd, readBuffer, 0, READ_CHUNK, nextOffset);
        if (bytesRead <= 0) break;
        nextOffset += bytesRead;
        chunks.push(readBuffer.toString('utf-8', 0, bytesRead));
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
}
