import { basename, join, resolve } from 'node:path';
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
import type { Runtime, RuntimeIdsPort, RuntimePathsPort, RuntimeStoragePort, RuntimeTimePort } from './runtime.js';

export type SessionContinuityMutation =
  | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
  | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
  | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob };

export type SessionAllocateOptions = {
  provider: string;
  name: string;
  model?: string;
  cwd: string;
  projectRoot?: string;
  backendNamespace?: string;
  agentName?: string;
  instruction?: ProviderInstruction;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  controllerProfile?: SessionControllerProfile;
};

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;

function toSessionNamespace(
  dir: string,
  paths: Pick<RuntimePathsPort, 'pluginRootNamespace'>,
  ids: Pick<RuntimeIdsPort, 'sha256'>,
): string {
  try {
    return paths.pluginRootNamespace(dir);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return ids.sha256(resolve(dir)).slice(0, 12);
    }
    throw error;
  }
}

function isValidEntry(value: unknown): value is SessionEntry {
  if (!isValidSessionEntry(value)) return false;
  if (!providerIdentPattern.test(value.provider)) return false;
  return true;
}

function normalizeEntry(entry: SessionEntry): SessionEntry {
  return {
    ...entry,
    activeJobId: entry.activeJobId,
  };
}

export function listSessionShards(runtime: Pick<Runtime, 'storage' | 'paths'>): string[] {
  const sessionsRoot = runtime.paths.sessionBase();
  try {
    return runtime.storage
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name));
  } catch {
    return [];
  }
}

export class SessionManager {
  private readonly storage: RuntimeStoragePort;
  private readonly paths: RuntimePathsPort;
  private readonly time: RuntimeTimePort;
  private readonly ids: RuntimeIdsPort;
  private readonly sessionDir: string;
  private readonly eventBus: TypedEventBus;
  private readonly cache = new Map<string, SessionEntry>();
  private readonly knownSessionIds = new Set<string>();
  private shardStamp = 0;
  private cacheHydrated = false;

  constructor(workingDirectory: string, runtime: SessionRuntime, eventBus?: TypedEventBus, isRawShardPath = false) {
    this.storage = runtime.storage;
    this.paths = runtime.paths;
    this.time = runtime.time;
    this.ids = runtime.ids;
    this.sessionDir = isRawShardPath
      ? workingDirectory
      : join(this.paths.sessionBase(), toSessionNamespace(workingDirectory, this.paths, this.ids));
    this.eventBus = eventBus ?? new TypedEventBus();
    if (!isRawShardPath) {
      this.storage.mkdirSync(this.sessionDir, { recursive: true });
    }
    this.shardStamp = this.readShardStamp();
  }

  /** Open an existing shard directory without creating it (recovery path). */
  static openShard(shardDir: string, runtime: SessionRuntime, eventBus?: TypedEventBus): SessionManager {
    return new SessionManager(shardDir, runtime, eventBus, true);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.json`);
  }

  private lockPath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.lock`);
  }

  private async acquireSessionLock(sessionId: string, timeoutMs = 5000): Promise<() => void> {
    return acquireDirectoryLock(
      this.lockPath(sessionId),
      { storage: this.storage, time: this.time },
      timeoutMs,
    );
  }

  private syncCacheWithShardStamp(): void {
    const currentStamp = this.readShardStamp();
    if (this.shardStamp === currentStamp) return;
    this.cache.clear();
    this.knownSessionIds.clear();
    this.cacheHydrated = false;
    this.shardStamp = currentStamp;
  }

  private populateCache(sessionId: string, entry: SessionEntry): void {
    this.cache.set(sessionId, normalizeEntry(entry));
    this.knownSessionIds.add(sessionId);
  }

  private readEntry(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    this.syncCacheWithShardStamp();

    if (!options?.forceFresh) {
      const cached = this.cache.get(sessionId);
      if (cached) return normalizeEntry(cached);
    }

    try {
      const data = this.storage.readFileSync(this.sessionPath(sessionId), 'utf-8');
      const parsed: unknown = JSON.parse(data);
      if (isValidEntry(parsed)) {
        const normalized = normalizeEntry(parsed);
        this.populateCache(sessionId, normalized);
        return normalized;
      }
      this.cache.delete(sessionId);
      backendLog.warn(`Session file ${sessionId}.json has unexpected shape, skipping`);
      return null;
    } catch (error: unknown) {
      this.cache.delete(sessionId);
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

  readById(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    return this.readEntry(sessionId, options);
  }

  private writeEntry(entry: SessionEntry): void {
    this.syncCacheWithShardStamp();
    const filePath = this.sessionPath(entry.sessionId);
    entry.version = (entry.version ?? 0) + 1;
    const didWrite = this.storage.writeAtomicSync(filePath, JSON.stringify(entry, null, 2), { encoding: 'utf-8' });
    if (!didWrite) return;
    this.shardStamp = this.readShardStamp();
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
  allocate(provider: string, name: string, model: string | undefined, cwd: string, projectRoot?: string): SessionEntry;
  allocate(
    optionsOrProvider: SessionAllocateOptions | string,
    name?: string,
    model?: string,
    cwd?: string,
    projectRoot?: string,
  ): SessionEntry {
    let options: SessionAllocateOptions;
    if (typeof optionsOrProvider === 'string') {
      options = {
        provider: optionsOrProvider,
        name: name ?? `session-${this.time.now()}`,
        model,
        cwd: cwd ?? '',
        ...(projectRoot !== undefined ? { projectRoot } : {}),
      };
    } else {
      options = optionsOrProvider;
    }
    const now = nowIsoString(this.time);
    const entry: SessionEntry = {
      sessionId: this.ids.uuid(),
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
    entry.lastUsedAt = nowIsoString(this.time);
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
    entry.lastUsedAt = nowIsoString(this.time);
    this.writeEntry(entry);
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    entry.state = 'non_resumable';
    entry.lastUsedAt = nowIsoString(this.time);
    this.writeEntry(entry);
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    const release = await this.acquireSessionLock(sessionId);
    try {
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (!entry || entry.activeJobId) return false;
      if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
      entry.activeJobId = jobId;
      entry.lastUsedAt = nowIsoString(this.time);
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
      const { expectedActiveJobId, expectedVersion, mutation } = options;
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (!entry) return false;
      if (entry.activeJobId !== expectedActiveJobId) return false;
      if (entry.version !== expectedVersion) return false;

      entry.activeJobId = undefined;
      entry.lastJobId = expectedActiveJobId;
      entry.lastUsedAt = nowIsoString(this.time);
      if (mutation.providerContinuity) {
        entry.providerContinuity = mutation.providerContinuity;
      }

      if (mutation.type === 'set_resumable') {
        entry.conversationRef = mutation.conversationRef;
        entry.state = 'ready';
      } else if (mutation.type === 'clear_non_resumable') {
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
    entry.lastUsedAt = nowIsoString(this.time);
    this.writeEntry(entry);
    return true;
  }

  /** Release job claim: clear activeJobId, set lastJobId to completed job. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    entry.activeJobId = undefined;
    entry.lastJobId = jobId;
    entry.lastUsedAt = nowIsoString(this.time);
    this.writeEntry(entry);
  }

  /** Provider-scoped lookup. Returns null if sessionId not found or provider mismatch. */
  get(provider: string, sessionId: string): SessionEntry | null {
    const entry = this.readEntry(sessionId, { forceFresh: true });
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
      const sessionIds = this.storage
        .readdirSync(this.sessionDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -5));
      this.knownSessionIds.clear();
      for (const sessionId of sessionIds) {
        this.knownSessionIds.add(sessionId);
      }
      const entries = sessionIds
        .map((sessionId) => this.readEntry(sessionId))
        .filter((entry): entry is SessionEntry => entry !== null && entry.provider === provider);
      this.cacheHydrated = true;
      return entries;
    } catch {
      return [];
    }
  }

  private readShardStamp(): number {
    try {
      return this.storage.statSync(this.sessionDir).mtimeMs;
    } catch {
      return 0;
    }
  }
}

export function getSessionById(
  sessionId: string,
  runtime: SessionRuntime,
  eventBus?: TypedEventBus,
): SessionEntry | null {
  for (const shardDir of listSessionShards(runtime)) {
    const entry = SessionManager.openShard(shardDir, runtime, eventBus).readById(sessionId, { forceFresh: true });
    if (entry !== null) {
      return entry;
    }
  }
  return null;
}
