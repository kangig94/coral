/**
 * Session store — I/O shell for discuss sessions.
 * Handles atomic writes, cross-process locking, session directory management,
 * incremental transcript append, and legacy state migration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderEntries, renderHeader } from './transcript.js';
import { parseDisplayName, randomSuffix, formatDateId, topicSlug } from './state-machine.js';
import type { AgentState, DiscussState } from './types.js';

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

// ─── Session lock ─────────────────────────────────────────────────────────────

/**
 * Cross-process mkdir-based lock (POSIX atomic test-and-set).
 * No external dependencies — uses filesystem atomicity.
 */
class SessionLock {
  async acquire<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(sessionDir, 'state.lock');
    const pidFile = path.join(lockDir, 'pid');
    const maxRetries = 10;
    const baseDelay = 50;

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
          try {
            const content = fs.readFileSync(pidFile, 'utf8');
            const dashIdx = content.indexOf('-');
            const ownerPid = parseInt(content.slice(0, dashIdx), 10);
            const lockTime = parseInt(content.slice(dashIdx + 1), 10);
            const isAlive = (() => {
              try { process.kill(ownerPid, 0); return true; } catch { return false; }
            })();
            // 30s staleness threshold — 150x the lock hold budget (~200ms max)
            const isStale = !isAlive || (Date.now() - lockTime > 30_000);
            if (isStale) {
              try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
              try { fs.rmdirSync(lockDir); } catch { /* ignore */ }
              continue;
            }
          } catch { /* pid file unreadable — retry with backoff */ }
          await sleep(baseDelay * Math.pow(2, Math.min(i, 5)) + Math.random() * baseDelay);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Lock timeout for session ${sessionDir}`);
  }
}

// ─── State migration ──────────────────────────────────────────────────────────

/**
 * Normalize legacy state.json to v2 schema.
 * Safe to call on already-normalized state.
 */
export function normalizeState(raw: Record<string, unknown>): DiscussState {
  // Work on raw dict to avoid TypeScript narrowing conflicts on required fields
  if (raw['last_speech_step'] === undefined) raw['last_speech_step'] = 0;
  if (raw['transcript'] === undefined) raw['transcript'] = [];
  if (raw['transcript_rendered'] === undefined) raw['transcript_rendered'] = 0;
  // Intentionally 50, not the original 30 — threshold was raised after real-world testing
  // showed 30 was too permissive (discussions resolved before all agents were ready).
  if (raw['bid_threshold'] === undefined) raw['bid_threshold'] = 50;
  if (raw['transcript_read_step'] === undefined) raw['transcript_read_step'] = {};
  // display_name migration: parse from persona if missing or empty
  const agents = raw['agents'] as Record<string, AgentState>;
  for (const [name, a] of Object.entries(agents)) {
    if (!a.display_name) {
      a.display_name = parseDisplayName(a.persona, name);
    }
  }
  // speaker_type migration: 'designated' → 'cold_start'
  if (raw['speaker_type'] === 'designated') {
    raw['speaker_type'] = 'cold_start';
  }
  return raw as unknown as DiscussState;
}

// ─── Session store ────────────────────────────────────────────────────────────

/** Manages discuss session directories, state persistence, and locking. */
export class SessionStore {
  private discussDir: string;
  private lock = new SessionLock();

  constructor(projectRoot: string) {
    this.discussDir = path.join(projectRoot, '.claude', 'coral', 'discuss');
    fs.mkdirSync(this.discussDir, { recursive: true });
  }

  /** Create a new session directory with collision detection. Returns sessionId and dirs. */
  createSessionDir(topic: string): { sessionId: string; sessionDir: string; fullPath: string } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const sessionId = `${formatDateId(new Date())}-${randomSuffix()}`;
      const sessionDir = `${sessionId}_${topicSlug(topic)}`;
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
    const match = entries.find((e) => e.startsWith(sessionId + '_') || e === sessionId);
    return match ? path.join(this.discussDir, match) : null;
  }

  /** Full filesystem path for a session directory. */
  fullPath(sessionDir: string): string {
    return path.join(this.discussDir, path.basename(sessionDir));
  }

  /** Path to state.json for a session. */
  statePath(fullSessionPath: string): string {
    return path.join(fullSessionPath, 'state.json');
  }

  /** Load and normalize state. Call inside withLock for mutations. */
  load(fullSessionPath: string): DiscussState {
    const raw = JSON.parse(fs.readFileSync(this.statePath(fullSessionPath), 'utf8')) as Record<string, unknown>;
    return normalizeState(raw);
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
}
