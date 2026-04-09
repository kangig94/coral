import { readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pluginRootNamespace, sessionBase } from '../infra/paths.js';
import { backendLog } from '../shared/backend-log.js';
import { acquireDirectoryLock } from '../shared/fs-lock.js';
import { isValidSessionEntry } from '../shared/session-entry.js';
import type {
  ProviderContinuityBlob,
  ProviderInstruction,
  SessionControllerProfile,
  SessionEntry,
} from '../shared/types.js';
import { isNoEntryError, nowIsoString, providerIdentPattern } from '../shared/utils.js';
import { TypedEventBus } from './event-bus.js';

export type SessionContinuityMutation =
  | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
  | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
  | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob };

export type SessionAllocateOptions = {
  provider: string;
  name: string;
  model: string;
  cwd: string;
  projectRoot?: string;
  backendNamespace?: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
};

type CachedSessionLookup = {
  shardDir: string;
  shardStamp: number;
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
  return true;
}

export class SessionManager {
  private static readonly shardStamps = new Map<string, number>();
  private static readonly sessionLookupCache = new Map<string, CachedSessionLookup>();
  private readonly sessionDir: string;
  private readonly eventBus: TypedEventBus;
  private readonly cache = new Map<string, SessionEntry>();
  private readonly knownSessionIds = new Set<string>();
  private shardStamp = 0;
  private cacheHydrated = false;

  constructor(workingDirectory: string, eventBus: TypedEventBus = new TypedEventBus(), isRawShardPath = false) {
    this.sessionDir = isRawShardPath ? workingDirectory : join(sessionBase(), toSessionNamespace(workingDirectory));
    this.eventBus = eventBus;
    if (!isRawShardPath) {
      mkdirSync(this.sessionDir, { recursive: true });
    }
    this.shardStamp = SessionManager.ensureShardStamp(this.sessionDir);
  }

  /** Open an existing shard directory without creating it (recovery path). */
  static openShard(shardDir: string, eventBus: TypedEventBus = new TypedEventBus()): SessionManager {
    return new SessionManager(shardDir, eventBus, true);
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

  static getById(sessionId: string): SessionEntry | null {
    const cached = SessionManager.sessionLookupCache.get(sessionId);
    if (cached) {
      const currentStamp = SessionManager.ensureShardStamp(cached.shardDir);
      if (currentStamp === cached.shardStamp) {
        return { ...cached.entry };
      }

      const refreshed = SessionManager.openShard(cached.shardDir).readEntry(sessionId, { forceFresh: true });
      if (refreshed !== null) {
        return refreshed;
      }

      SessionManager.clearLookupCache(sessionId, cached.shardDir);
    }

    for (const shardDir of SessionManager.listShards()) {
      const entry = SessionManager.openShard(shardDir).readEntry(sessionId, { forceFresh: true });
      if (entry !== null) {
        return entry;
      }
    }

    return null;
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

  private static cacheLookupEntry(shardDir: string, entry: SessionEntry): void {
    SessionManager.sessionLookupCache.set(entry.sessionId, {
      shardDir,
      shardStamp: SessionManager.ensureShardStamp(shardDir),
      entry: { ...entry },
    });
  }

  private static clearLookupCache(sessionId: string, shardDir?: string): void {
    const cached = SessionManager.sessionLookupCache.get(sessionId);
    if (!cached) return;
    if (shardDir !== undefined && cached.shardDir !== shardDir) return;
    SessionManager.sessionLookupCache.delete(sessionId);
  }

  private async acquireSessionLock(sessionId: string, timeoutMs = 5000): Promise<() => void> {
    return acquireDirectoryLock(this.lockPath(sessionId), timeoutMs);
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
    this.cache.set(sessionId, { ...entry });
    this.knownSessionIds.add(sessionId);
    SessionManager.cacheLookupEntry(this.sessionDir, entry);
  }

  private readEntry(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    this.syncCacheWithShardStamp();

    if (!options?.forceFresh) {
      const cached = this.cache.get(sessionId);
      if (cached) return { ...cached };
    }

    try {
      const data = readFileSync(this.sessionPath(sessionId), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isValidEntry(parsed)) {
        this.populateCache(sessionId, parsed);
        return { ...parsed };
      }
      this.cache.delete(sessionId);
      SessionManager.clearLookupCache(sessionId, this.sessionDir);
      backendLog.warn(`Session file ${sessionId}.json has unexpected shape, skipping`);
      return null;
    } catch (error: unknown) {
      this.cache.delete(sessionId);
      SessionManager.clearLookupCache(sessionId, this.sessionDir);
      if (isNoEntryError(error)) {
        this.knownSessionIds.delete(sessionId);
        return null;
      }
      if (error instanceof SyntaxError) {
        backendLog.warn(`Corrupt session file ${sessionId}.json, skipping`);
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
    try {
      writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) return;
      throw error;
    }
    this.shardStamp = SessionManager.bumpShardStamp(this.sessionDir);
    this.populateCache(entry.sessionId, entry);
    const shardHash = basename(this.sessionDir);
    this.eventBus.emit('session:updated', {
      sessionId: entry.sessionId,
      shardHash,
      version: entry.version,
      ...(entry.projectRoot !== undefined ? { projectRoot: entry.projectRoot } : {}),
    });
  }

  /** Allocate a new sessionId and persist as 'pending'. Returns the new entry. */
  allocate(options: SessionAllocateOptions): SessionEntry;
  allocate(provider: string, name: string, model: string, cwd: string, projectRoot?: string): SessionEntry;
  allocate(
    optionsOrProvider: SessionAllocateOptions | string,
    name?: string,
    model?: string,
    cwd?: string,
    projectRoot?: string,
  ): SessionEntry {
    const options =
      typeof optionsOrProvider === 'string'
        ? {
            provider: optionsOrProvider,
            name: name ?? `session-${Date.now()}`,
            model: model ?? 'unknown',
            cwd: cwd ?? '',
            ...(projectRoot !== undefined ? { projectRoot } : {}),
          }
        : optionsOrProvider;
    const now = nowIsoString();
    const entry: SessionEntry = {
      sessionId: randomUUID(),
      provider: options.provider,
      name: options.name,
      state: 'pending',
      model: options.model,
      cwd: options.cwd,
      ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
      ...(options.backendNamespace !== undefined ? { backendNamespace: options.backendNamespace } : {}),
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
      ...(options.bypassPermissions !== undefined ? { bypassPermissions: options.bypassPermissions } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.controllerProfile !== undefined ? { controllerProfile: options.controllerProfile } : {}),
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

  checkpointProviderContinuity(
    sessionId: string,
    update: { providerContinuity: ProviderContinuityBlob; conversationRef?: string },
  ): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.providerContinuity = update.providerContinuity;
    if (update.conversationRef) {
      entry.conversationRef = update.conversationRef;
      entry.state = 'ready';
    }
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

  async finalizeJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      mutation: SessionContinuityMutation;
    },
  ): Promise<boolean> {
    const release = await this.acquireSessionLock(sessionId);
    try {
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (!entry) return false;
      if (entry.activeJobId !== options.expectedActiveJobId) return false;
      if (entry.version !== options.expectedVersion) return false;

      entry.activeJobId = undefined;
      entry.lastJobId = options.expectedActiveJobId;
      entry.lastUsedAt = nowIsoString();
      if (options.mutation.providerContinuity) {
        entry.providerContinuity = options.mutation.providerContinuity;
      }

      if (options.mutation.type === 'set_resumable') {
        entry.conversationRef = options.mutation.conversationRef;
        entry.state = 'ready';
      } else if (options.mutation.type === 'clear_non_resumable') {
        entry.conversationRef = undefined;
        entry.state = 'non_resumable';
      }

      this.writeEntry(entry);
      return true;
    } finally {
      release();
    }
  }

  async clearConversationRefAndMarkNonResumableAtomic(
    sessionId: string,
    expectedActiveJobId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    return this.finalizeJobContinuityAtomic(sessionId, {
      expectedActiveJobId,
      expectedVersion,
      mutation: { type: 'clear_non_resumable' },
    });
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
