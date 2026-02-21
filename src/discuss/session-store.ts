/**
 * Session store - I/O shell for discuss sessions.
 * Handles atomic writes, cross-process locking, session directory management,
 * and incremental transcript append.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderEntries, renderHeader } from './transcript.js';
import { randomSuffix, formatDateId, topicSlug } from './state-machine.js';
import type { DiscussState } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Atomic write ─────────────────────────────────────────────────────────────

function writeStateAtomic(filePath: string, state: DiscussState): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseLockOwner(filePath: string): { pid: number; startedAt: number } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const dashIndex = content.indexOf('-');
    if (dashIndex < 0) return null;
    const pid = Number.parseInt(content.slice(0, dashIndex), 10);
    const startedAt = Number.parseInt(content.slice(dashIndex + 1), 10);
    if (Number.isNaN(pid) || Number.isNaN(startedAt)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

// ─── Session lock ─────────────────────────────────────────────────────────────

/**
 * Cross-process mkdir-based lock (POSIX atomic test-and-set).
 * No external dependencies - uses filesystem atomicity.
 */
class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    const maxRetries = 10;
    const baseDelay = 50;
    const staleThresholdMs = 30_000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.mkdirSync(lockDir); // atomic: fails EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}-${Date.now()}`);
        try {
          return await fn();
        } finally {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') {
          const owner = parseLockOwner(pidFile);
          const ownerAlive = owner ? (() => {
            try {
              process.kill(owner.pid, 0);
              return true;
            } catch {
              return false;
            }
          })() : false;
          const isStale = !ownerAlive || (owner ? Date.now() - owner.startedAt > staleThresholdMs : true);
          if (isStale) {
            try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
            try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
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

// ─── Session store ────────────────────────────────────────────────────────────

/** Manages discuss session directories, state persistence, and locking. */
export class SessionStore {
  private readonly discussDir: string;
  private lock = new SessionLock();

  constructor(projectRoot: string) {
    this.discussDir = path.join(projectRoot, '.claude', 'coral', 'discuss');
    fs.mkdirSync(this.discussDir, { recursive: true });
  }

  /** Create a new session directory with collision detection. Returns sessionId and dirs. */
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

  /** Resolve session directory from session_id prefix. Returns null if not found. */
  resolveDir(sessionId: string): string | null {
    if (!fs.existsSync(this.discussDir)) return null;
    const entries = fs.readdirSync(this.discussDir);
    const match = entries.find((e) => e.startsWith(sessionId + '-') || e === sessionId);
    return match ? path.join(this.discussDir, match) : null;
  }

  /** Path to state.json for a session. */
  statePath(fullSessionPath: string): string {
    return path.join(fullSessionPath, 'state.json');
  }

  /** Load state from disk. Call inside withLock for mutations. */
  load(fullSessionPath: string): DiscussState {
    return JSON.parse(fs.readFileSync(this.statePath(fullSessionPath), 'utf8')) as DiscussState;
  }

  /**
   * Save state atomically and append new transcript entries to transcript.md.
   * transcript_rendered tracks how many entries have been written to .md.
   */
  save(fullSessionPath: string, state: DiscussState): void {
    const newEntries = state.transcript.slice(state.transcript_rendered);
    if (newEntries.length > 0) {
      const md = renderEntries(newEntries, state.agents);
      fs.appendFileSync(path.join(fullSessionPath, 'transcript.md'), md, 'utf8');
    }
    // Write updated transcript_rendered without mutating the caller's state object
    const toWrite = newEntries.length > 0
      ? { ...state, transcript_rendered: state.transcript.length }
      : state;
    writeStateAtomic(this.statePath(fullSessionPath), toWrite);
  }

  /** Initialize transcript.md with topic header. */
  initTranscript(fullSessionPath: string, topic: string): void {
    fs.writeFileSync(path.join(fullSessionPath, 'transcript.md'), renderHeader(topic), 'utf8');
  }

  /** Acquire lock and run fn. Returns fn's result. */
  async withLock<T>(fullSessionPath: string, fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(fullSessionPath, fn);
  }

  /** Remove ended sessions older than CORAL_DISCUSS_TTL_DAYS (default 30). Returns count removed. */
  cleanupExpiredSessions(): number {
    const ttlDays = parseInt(process.env.CORAL_DISCUSS_TTL_DAYS ?? '', 10);
    const ttl = (Number.isFinite(ttlDays) && ttlDays > 0) ? ttlDays : 30;
    const cutoff = Date.now() - ttl * 24 * 60 * 60 * 1000;
    let removed = 0;

    if (!fs.existsSync(this.discussDir)) return 0;
    for (const entry of fs.readdirSync(this.discussDir)) {
      const fullPath = path.join(this.discussDir, entry);
      const statePath = path.join(fullPath, 'state.json');
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
        if (raw['status'] !== 'ended') continue; // never delete active sessions
        const ts = String(raw['last_activity_at'] || '');
        if (new Date(ts).getTime() < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          removed++;
        }
      } catch { continue; } // skip unreadable/corrupt sessions
    }
    return removed;
  }
}
