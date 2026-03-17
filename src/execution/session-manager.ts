import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pluginRootNamespace, sessionBase } from '../client/paths.js';
import type { SessionState } from '../types.js';
import { isNoEntryError, nowIsoString, providerIdentPattern } from '../shared/mcp-utils.js';
import { isValidSessionEntry } from '../client/readers.js';
import { eventBus } from './event-bus.js';

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
  projectRoot?: string;
  createdAt: string;
  lastUsedAt: string;
  version: number;
}

type CachedSession = {
  entry: SessionEntry;
};

function toSessionNamespace(dir: string): string {
  try {
    return pluginRootNamespace(dir);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 12);
    }
    throw error;
  }
}

function isValidEntry(value: unknown): value is SessionEntry {
  if (!isValidSessionEntry(value)) return false;
  if (!providerIdentPattern.test(value.provider)) return false;
  const raw = value as unknown as Record<string, unknown>;
  return raw.projectRoot === undefined || typeof raw.projectRoot === 'string';
}

export class SessionManager {
  private static readonly shardStamps = new Map<string, number>();
  private readonly sessionDir: string;
  private readonly cache = new Map<string, CachedSession>();
  private readonly knownSessionIds = new Set<string>();
  private shardStamp = 0;
  private cacheHydrated = false;

  constructor(workingDirectory: string) {
    this.sessionDir = join(sessionBase(), toSessionNamespace(workingDirectory));
    mkdirSync(this.sessionDir, { recursive: true });
    this.shardStamp = SessionManager.ensureShardStamp(this.sessionDir);
  }

  static openShard(shardDir: string): SessionManager {
    const manager = Object.create(SessionManager.prototype) as SessionManager;
    (manager as unknown as { sessionDir: string }).sessionDir = shardDir;
    (manager as unknown as { cache: Map<string, CachedSession> }).cache = new Map();
    (manager as unknown as { knownSessionIds: Set<string> }).knownSessionIds = new Set();
    (manager as unknown as { shardStamp: number }).shardStamp = SessionManager.ensureShardStamp(shardDir);
    (manager as unknown as { cacheHydrated: boolean }).cacheHydrated = false;
    return manager;
  }

  static listShards(): string[] {
    const sessionsRoot = sessionBase();
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

  private static ensureShardStamp(sessionDir: string): number {
    const current = SessionManager.shardStamps.get(sessionDir);
    if (current !== undefined) return current;
    SessionManager.shardStamps.set(sessionDir, 0);
    return 0;
  }

  private static bumpShardStamp(sessionDir: string): number {
    const next = SessionManager.ensureShardStamp(sessionDir) + 1;
    SessionManager.shardStamps.set(sessionDir, next);
    return next;
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

  private syncCacheWithShardStamp(): void {
    const currentStamp = SessionManager.ensureShardStamp(this.sessionDir);
    if (this.shardStamp === currentStamp) return;
    this.cache.clear();
    this.knownSessionIds.clear();
    this.cacheHydrated = false;
    this.shardStamp = currentStamp;
  }

  private populateCache(sessionId: string, entry: SessionEntry): void {
    this.cache.set(sessionId, { entry: { ...entry } });
    this.knownSessionIds.add(sessionId);
  }

  private readEntry(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    this.syncCacheWithShardStamp();

    if (!options?.forceFresh) {
      const cached = this.cache.get(sessionId);
      if (cached) return { ...cached.entry };
    }

    try {
      const data = readFileSync(this.sessionPath(sessionId), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isValidEntry(parsed)) {
        this.populateCache(sessionId, parsed);
        return { ...parsed };
      }
      this.cache.delete(sessionId);
      process.stderr.write(`Warning: Session file ${sessionId}.json has unexpected shape, skipping\n`);
      return null;
    } catch (error: unknown) {
      this.cache.delete(sessionId);
      if (isNoEntryError(error)) {
        this.knownSessionIds.delete(sessionId);
        return null;
      }
      if (error instanceof SyntaxError) {
        process.stderr.write(`Warning: Corrupt session file ${sessionId}.json, skipping\n`);
        return null;
      }
      throw error;
    }
  }

  private writeEntry(entry: SessionEntry): void {
    this.syncCacheWithShardStamp();
    const filePath = this.sessionPath(entry.sessionId);
    const tmpPath = filePath + '.tmp';
    entry.version = (entry.version ?? 0) + 1;
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
    this.shardStamp = SessionManager.bumpShardStamp(this.sessionDir);
    this.populateCache(entry.sessionId, entry);
    const shardHash = basename(this.sessionDir);
    eventBus.emit('session:updated', {
      sessionId: entry.sessionId,
      shardHash,
      version: entry.version,
      ...(entry.projectRoot !== undefined ? { projectRoot: entry.projectRoot } : {}),
    });
  }

  /** Allocate a new sessionId and persist as 'pending'. Returns the new entry. */
  allocate(provider: string, name: string, model: string, cwd: string, projectRoot?: string): SessionEntry {
    const now = nowIsoString();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      provider,
      name,
      state: 'pending',
      model,
      cwd,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
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
    entry.lastUsedAt = nowIsoString();
    this.writeEntry(entry);
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.state = 'non_resumable';
    entry.lastUsedAt = nowIsoString();
    this.writeEntry(entry);
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    const release = await this.acquireSessionLock(sessionId);
    try {
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (!entry || entry.activeJobId) return false;
      if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
      entry.activeJobId = jobId;
      entry.lastUsedAt = nowIsoString();
      this.writeEntry(entry);
      return true;
    } finally {
      release();
    }
  }

  /**
   * Claim the session synchronously (no lock). For test and startup-only paths
   * where concurrent access is not a concern.
   */
  claimForJobSync(sessionId: string, jobId: string): boolean {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId) return false;
    entry.activeJobId = jobId;
    entry.lastUsedAt = nowIsoString();
    this.writeEntry(entry);
    return true;
  }

  /** Release job claim: clear activeJobId, set lastJobId to completed job. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    entry.activeJobId = undefined;
    entry.lastJobId = jobId;
    entry.lastUsedAt = nowIsoString();
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
    this.syncCacheWithShardStamp();
    if (this.cacheHydrated) {
      return Array.from(this.knownSessionIds)
        .map((sessionId) => this.readEntry(sessionId))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
    }

    try {
      const files = readdirSync(this.sessionDir).filter((file) => file.endsWith('.json'));
      this.knownSessionIds.clear();
      for (const file of files) {
        this.knownSessionIds.add(file.slice(0, -5));
      }
      const entries = files
        .map((file) => this.readEntry(file.slice(0, -5)))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
      this.cacheHydrated = true;
      return entries;
    } catch {
      return [];
    }
  }
}
