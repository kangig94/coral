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
import { writeFile, rename } from 'node:fs/promises';
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

// Allocated per-call in readNewLines to avoid shared mutable state

export type ReplayCursor = { lastOffset: number; remainder: string };

export function jobResultPath(jobId: string): string {
  return join(JOBS_DIR, jobId, 'result.md');
}

export function createReplayCursor(): ReplayCursor {
  return { lastOffset: 0, remainder: '' };
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const s = String(seconds).padStart(2, ' ');
  const m = String(minutes).padStart(2, ' ');
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${m}m ${s}s`;
}

export class ProgressStore {
  private readonly eventCounters = new Map<string, number>();
  private readonly jobStartedAt = new Map<string, number>();
  private readonly statusCache = new Map<string, PersistedStatusRecord>();
  private readonly writeGeneration = new Map<string, number>();
  private liveCount = 0;
  private changeSeq = 0;
  private waiters: Array<() => void> = [];

  /**
   * Returns a snapshot of the change sequence counter.
   * Pass this to `waitForChange()` to avoid missing notifications.
   */
  getChangeSeq(): number {
    return this.changeSeq;
  }

  /**
   * Waits until the change sequence advances past `sinceSeq`.
   * Returns immediately if changes have already occurred since `sinceSeq`.
   */
  waitForChange(sinceSeq: number): Promise<void> {
    if (this.changeSeq !== sinceSeq) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notifyWaiters(): void {
    this.changeSeq++;
    const batch = this.waiters;
    this.waiters = [];
    for (const resolve of batch) resolve();
  }

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

  private isLivePhase(phase: JobPhase): boolean {
    return phase === 'queued' || phase === 'launching' || phase === 'running';
  }

  liveJobCount(): number {
    return this.liveCount;
  }

  private nextWriteGeneration(jobId: string): number {
    const next = (this.writeGeneration.get(jobId) ?? 0) + 1;
    this.writeGeneration.set(jobId, next);
    return next;
  }

  private applyStatusRecord(jobId: string, record: PersistedStatusRecord): void {
    const oldRecord = this.statusCache.get(jobId);
    const wasLive = oldRecord ? this.isLivePhase(oldRecord.phase) : false;
    const isLive = this.isLivePhase(record.phase);
    if (!wasLive && isLive) this.liveCount++;
    if (wasLive && !isLive) this.liveCount--;
    this.statusCache.set(jobId, { ...record });
    this.notifyWaiters();
  }

  private persistStatusSync(jobId: string, record: PersistedStatusRecord): void {
    const filePath = this.statusPath(jobId);
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  /** Create the job directory and write initial status.json. */
  initJob(
    jobId: string,
    sessionId: string,
    provider: string,
    projectRoot?: string,
    jobKind?: JobKind,
    initialPhase: JobPhase = 'launching',
  ): void {
    const dir = this.jobDir(jobId);
    mkdirSync(dir, { recursive: true });
    const record: PersistedStatusRecord = {
      jobId,
      sessionId,
      provider,
      phase: initialPhase,
      launch: { state: 'pending', updatedAt: new Date().toISOString() },
    };
    if (projectRoot !== undefined) {
      record.projectRoot = projectRoot;
    }
    if (jobKind !== undefined) {
      record.jobKind = jobKind;
    }
    this.nextWriteGeneration(jobId);
    this.persistStatusSync(jobId, record);
    this.applyStatusRecord(jobId, record);
    writeFileSync(this.progressPath(jobId), '');
    this.jobStartedAt.set(jobId, Date.now());
  }

  /** Atomically write status.json. */
  writeStatus(jobId: string, record: PersistedStatusRecord): void {
    const generation = this.nextWriteGeneration(jobId);
    const isTerminal = record.phase === 'completed' || record.phase === 'error' || record.phase === 'aborted';

    if (isTerminal) {
      this.persistStatusSync(jobId, record);
      this.applyStatusRecord(jobId, record);
      return;
    }

    this.applyStatusRecord(jobId, record);

    const filePath = this.statusPath(jobId);
    const tmpPath = filePath + '.tmp';
    const payload = JSON.stringify(record, null, 2);
    void writeFile(tmpPath, payload, 'utf-8')
      .then(() => {
        if (this.writeGeneration.get(jobId) !== generation) return;
        return rename(tmpPath, filePath);
      })
      .catch(() => {
        /* status write must not break execution */
      });
  }

  /** Read status.json. Returns null if not found or corrupt. */
  readStatus(jobId: string): PersistedStatusRecord | null {
    const cached = this.statusCache.get(jobId);
    if (cached) return { ...cached };

    try {
      const data = readFileSync(this.statusPath(jobId), 'utf-8');
      const record = JSON.parse(data) as PersistedStatusRecord;
      this.statusCache.set(jobId, { ...record });
      if (this.isLivePhase(record.phase)) this.liveCount++;
      return { ...record };
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
    const elapsed = Date.now() - (this.jobStartedAt.get(jobId) ?? Date.now());
    const stamped = `[${formatElapsed(elapsed)}] ${message}`;
    const entry: PersistedProgressRecord = {
      jobId,
      sessionId,
      eventId,
      type: 'progress',
      ts: new Date().toISOString(),
      message: stamped,
    };
    try {
      appendFileSync(this.progressPath(jobId), JSON.stringify(entry) + '\n');
    } catch {
      /* progress write must not break execution */
    }
    this.notifyWaiters();
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
    this.jobStartedAt.delete(jobId);
    this.writeGeneration.delete(jobId);
    return eventId;
  }

  /** Write result.md as a debugging/recovery artifact. */
  writeResultMd(jobId: string, text: string): void {
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
      const buf = Buffer.alloc(READ_CHUNK);
      let nextOffset = cursor.lastOffset;
      while (true) {
        const bytesRead = readSync(fd, buf, 0, READ_CHUNK, nextOffset);
        if (bytesRead <= 0) break;
        nextOffset += bytesRead;
        chunks.push(buf.toString('utf-8', 0, bytesRead));
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
