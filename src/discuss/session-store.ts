import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderEntries, renderHeader } from './transcript.js';
import { randomSuffix, formatDateId, topicSlug } from './state-machine.js';
import type { DiscussState } from './types.js';

function tryRemoveSync(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStateAtomic(filePath: string, state: DiscussState): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseLockOwner(filePath: string): { pid: number; startedAt: number } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const [rawPid, rawStartedAt] = content.split('-', 2);
    if (!rawPid || !rawStartedAt) return null;
    const pid = Number.parseInt(rawPid, 10);
    const startedAt = Number.parseInt(rawStartedAt, 10);
    if (Number.isNaN(pid) || Number.isNaN(startedAt)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStaleOwner(owner: { pid: number; startedAt: number } | null, staleThresholdMs: number): boolean {
  if (!owner) return true;
  if (!isProcessAlive(owner.pid)) return true;
  return Date.now() - owner.startedAt > staleThresholdMs;
}

class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    const maxRetries = 10;
    const baseDelay = 50;
    const staleThresholdMs = 30_000;
    const clearLockFiles = (): void => {
      tryRemoveSync(pidFile);
      tryRemoveSync(lockDir);
    };

    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.mkdirSync(lockDir); // atomic: fails EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}-${Date.now()}`);
        try {
          return await fn();
        } finally {
          clearLockFiles();
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') {
          const owner = parseLockOwner(pidFile);
          const isStale = isStaleOwner(owner, staleThresholdMs);
          if (isStale) {
            clearLockFiles();
            continue;
          }
          await sleep(baseDelay * Math.pow(2, Math.min(i, 5)) + Math.random() * baseDelay);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Lock timeout for session ${sessionDir}`);
  }
}

export class SessionStore {
  private readonly discussDir: string;
  private lock = new SessionLock();

  constructor(projectRoot: string) {
    this.discussDir = path.join(projectRoot, '.claude', 'coral', 'discuss');
    fs.mkdirSync(this.discussDir, { recursive: true });
  }

  createSessionDir(topic: string): { sessionId: string; sessionDir: string; fullPath: string } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sessionId = `${formatDateId(new Date())}-${randomSuffix()}`;
      const sessionDir = `${sessionId}-${topicSlug(topic)}`;
      const fullPath = path.join(this.discussDir, sessionDir);
      try {
        fs.mkdirSync(fullPath, { recursive: false });
        return { sessionId, sessionDir, fullPath };
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error('Failed to create session after 3 attempts (collision)');
  }

  resolveDir(sessionId: string): string | null {
    if (!fs.existsSync(this.discussDir)) return null;

    const exactPath = path.join(this.discussDir, sessionId);
    if (fs.existsSync(exactPath)) {
      return exactPath;
    }

    const match = fs.readdirSync(this.discussDir).find((entry) => entry.startsWith(`${sessionId}-`));
    return match ? path.join(this.discussDir, match) : null;
  }

  statePath(fullSessionPath: string): string {
    return path.join(fullSessionPath, 'state.json');
  }

  load(fullSessionPath: string): DiscussState {
    return JSON.parse(fs.readFileSync(this.statePath(fullSessionPath), 'utf8')) as DiscussState;
  }

  save(fullSessionPath: string, state: DiscussState): void {
    const newEntries = state.transcript.slice(state.transcript_rendered);
    if (newEntries.length > 0) {
      const md = renderEntries(newEntries, state.agents);
      fs.appendFileSync(path.join(fullSessionPath, 'transcript.md'), md, 'utf8');
    }
    const toWrite = newEntries.length > 0
      ? { ...state, transcript_rendered: state.transcript.length }
      : state;
    writeStateAtomic(this.statePath(fullSessionPath), toWrite);
  }

  initTranscript(fullSessionPath: string, topic: string): void {
    fs.writeFileSync(path.join(fullSessionPath, 'transcript.md'), renderHeader(topic), 'utf8');
  }

  async withLock<T>(fullSessionPath: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(fullSessionPath, fn);
  }

  cleanupExpiredSessions(): number {
    const ttlDays = Number.parseInt(process.env.CORAL_DISCUSS_TTL_DAYS ?? '', 10);
    const ttl = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30;
    const cutoff = Date.now() - ttl * 24 * 60 * 60 * 1000;
    let removed = 0;

    if (!fs.existsSync(this.discussDir)) return 0;
    for (const entry of fs.readdirSync(this.discussDir)) {
      const fullPath = path.join(this.discussDir, entry);
      const statePath = path.join(fullPath, 'state.json');
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        if (raw['status'] !== 'ended') continue;
        const ts = String(raw['last_activity_at'] || '');
        if (new Date(ts).getTime() < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        continue;
      }
    }
    return removed;
  }
}
