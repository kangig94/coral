import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionState } from '../types.js';
import { isNoEntryError, providerIdentPattern } from '../shared/mcp-utils.js';

export interface SessionEntry {
  sessionId: string;
  provider: string;
  name: string;
  state: SessionState;
  activeJobId?: string;
  lastJobId?: string;
  conversationRef?: string;
  model: string;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  version: number;
}

type CachedSession = {
  entry: SessionEntry;
  mtimeMs: number;
  size: number;
};

function projectHash(dir: string): string {
  return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
}

function isValidEntry(value: unknown): value is SessionEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.sessionId === 'string'
    && typeof v.provider === 'string'
    && typeof v.name === 'string'
    && typeof v.state === 'string'
    && (v.state === 'pending' || v.state === 'ready' || v.state === 'non_resumable')
    && typeof v.model === 'string'
    && typeof v.cwd === 'string'
    && typeof v.version === 'number'
    && providerIdentPattern.test(v.provider);
}

export class SessionManager {
  private readonly sessionDir: string;
  private readonly cache = new Map<string, CachedSession>();

  constructor(workingDirectory: string) {
    this.sessionDir = join(homedir(), '.claude', 'coral', 'execution', 'sessions', projectHash(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
  }

  static openShard(shardDir: string): SessionManager {
    const manager = Object.create(SessionManager.prototype) as SessionManager;
    (manager as unknown as { sessionDir: string }).sessionDir = shardDir;
    (manager as unknown as { cache: Map<string, CachedSession> }).cache = new Map();
    return manager;
  }

  static listShards(): string[] {
    const sessionsRoot = join(homedir(), '.claude', 'coral', 'execution', 'sessions');
    try {
      return readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sessionsRoot, entry.name));
    } catch {
      return [];
    }
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.json`);
  }

  private lockPath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.lock`);
  }

  private async acquireSessionLock(sessionId: string, timeoutMs = 5000): Promise<() => void> {
    const lockDir = this.lockPath(sessionId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        mkdirSync(lockDir);
        return () => {
          try {
            rmdirSync(lockDir);
          } catch {}
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const stats = statSync(lockDir);
          if (Date.now() - stats.mtimeMs > 30000) {
            try {
              rmdirSync(lockDir);
            } catch {}
            continue;
          }
        } catch {}
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }

    throw new Error(`Session lock timeout: ${sessionId}`);
  }

  private getFileStats(sessionId: string): { mtimeMs: number; size: number } | null {
    try {
      const stats = statSync(this.sessionPath(sessionId));
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }

  private populateCache(sessionId: string, entry: SessionEntry): void {
    const stats = this.getFileStats(sessionId);
    if (stats) {
      this.cache.set(sessionId, {
        entry: { ...entry },
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    }
  }

  private readEntry(sessionId: string): SessionEntry | null {
    const cached = this.cache.get(sessionId);
    if (cached) {
      const stats = this.getFileStats(sessionId);
      if (stats && stats.mtimeMs === cached.mtimeMs && stats.size === cached.size) {
        return { ...cached.entry };
      }
      this.cache.delete(sessionId);
    }

    try {
      const data = readFileSync(this.sessionPath(sessionId), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isValidEntry(parsed)) {
        this.populateCache(sessionId, parsed);
        return { ...parsed };
      }
      process.stderr.write(`Warning: Session file ${sessionId}.json has unexpected shape, skipping\n`);
      return null;
    } catch (error: unknown) {
      if (isNoEntryError(error)) return null;
      if (error instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session file ${sessionId}.json, skipping\n`);
        return null;
      }
      throw error;
    }
  }

  private writeEntry(entry: SessionEntry): void {
    const filePath = this.sessionPath(entry.sessionId);
    const tmpPath = filePath + '.tmp';
    entry.version = (entry.version ?? 0) + 1;
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
    this.populateCache(entry.sessionId, entry);
  }

  /** Allocate a new sessionId and persist as 'pending'. Returns the new entry. */
  allocate(provider: string, name: string, model: string, cwd: string): SessionEntry {
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      provider,
      name,
      state: 'pending',
      model,
      cwd,
      createdAt: now,
      lastUsedAt: now,
      version: 0,
    };
    this.writeEntry(entry);
    return entry;
  }

  /** Set conversationRef and transition state from pending -> ready. */
  setConversationRef(sessionId: string, conversationRef: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.conversationRef = conversationRef;
    entry.state = 'ready';
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.state = 'non_resumable';
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    const release = await this.acquireSessionLock(sessionId);
    try {
      const entry = this.readEntry(sessionId);
      if (!entry || entry.activeJobId) return false;
      if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
      entry.activeJobId = jobId;
      entry.lastUsedAt = new Date().toISOString();
      this.writeEntry(entry);
      return true;
    } finally {
      release();
    }
  }

  /**
   * Claim the session for a new job. Enforces single-active-job invariant.
   * Returns false if session is already running (activeJobId is set).
   * @deprecated Use claimForJobAtomic() instead.
   */
  claimForJob(sessionId: string, jobId: string): boolean {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId) return false;
    entry.activeJobId = jobId;
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
    return true;
  }

  /** Release job claim: clear activeJobId, set lastJobId to completed job. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    entry.activeJobId = undefined;
    entry.lastJobId = jobId;
    entry.lastUsedAt = new Date().toISOString();
    this.writeEntry(entry);
  }

  /** Provider-scoped lookup. Returns null if sessionId not found or provider mismatch. */
  get(provider: string, sessionId: string): SessionEntry | null {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.provider !== provider) return null;
    return entry;
  }

  /** List all sessions for a provider. */
  list(provider: string): SessionEntry[] {
    try {
      const files = readdirSync(this.sessionDir).filter((file) => file.endsWith('.json'));
      return files
        .map((file) => this.readEntry(file.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
    } catch {
      return [];
    }
  }
}
