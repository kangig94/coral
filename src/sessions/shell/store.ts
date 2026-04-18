import { mkdirSync as nodeMkdirSync, readFileSync as nodeReadFileSync, readdirSync as nodeReaddirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';
import { currentBuildFlavor } from '../../infra/paths.js';
import { openStoreDatabase } from '../../store/db.js';
import { appendEvents } from '../../store/append.js';
import { createEmptyRegistry, type CoralEventInput } from '../../store/envelope.js';
import { composeReducers } from '../../store/reducers.js';
import { storePaths } from '../../store/paths.js';
import { backendLog } from '../../shared/backend-log.js';
import { acquireDirectoryLock } from '../../shared/fs-lock.js';
import { isValidSessionEntry } from '../../shared/session-entry.js';
import type { ProviderInstruction } from '../../shared/types.js';
import { isNoEntryError, nowIsoString, providerIdentPattern } from '../../shared/utils.js';
import type { Runtime, RuntimeIdsPort, RuntimePathsPort, RuntimeStoragePort, RuntimeTimePort } from '../../runtime/ports.js';
import {
  DEFAULT_SESSION_CONTROLLER,
  sessionControllerFromProfile,
  type SessionControllerProfile,
  type SessionEntry,
  type SessionHandle,
} from '../entry.js';
import type { ContinuitySnapshot, ProviderContinuityBlob } from '../continuity.js';
import type {
  SessionCloseReason,
  SessionInterruptedFault,
} from '../fault.js';
import { sessionsRegistry } from '../events.js';

const sessionReducers = composeReducers(sessionsRegistry);
const inMemoryJournalByStorage = new WeakMap<RuntimeStoragePort, BetterSqlite3.Database>();
const migrationStorage = {
  mkdirSync: nodeMkdirSync,
  readFileSync: nodeReadFileSync,
  readdirSync: nodeReaddirSync,
} as unknown as RuntimeStoragePort;

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

function cloneEntry(entry: SessionEntry): SessionEntry {
  return JSON.parse(JSON.stringify(entry)) as SessionEntry;
}

function storeDbPath(): string {
  return storePaths(currentBuildFlavor()).dbFile;
}

function isInMemoryStorage(storage: RuntimeStoragePort): boolean {
  return storage.constructor?.name === 'InMemoryStorage';
}

function snapshotFromEntry(entry: Pick<SessionEntry, 'conversationRef' | 'providerContinuity' | 'state'>): ContinuitySnapshot {
  return {
    conversationRef: entry.conversationRef ?? null,
    resumable: entry.state !== 'non_resumable' && typeof entry.conversationRef === 'string',
    providerContinuity: entry.providerContinuity ?? null,
  };
}

function sessionOpenedEvent(entry: SessionEntry): CoralEventInput {
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    bodyVersion: 1,
    body: {
      controller: sessionControllerFromProfile(entry.controllerProfile) || DEFAULT_SESSION_CONTROLLER,
      provider: entry.provider,
    },
  };
}

function sessionCheckpointedEvent(
  entry: SessionEntry,
  snapshot: ContinuitySnapshot,
): CoralEventInput {
  return {
    type: 'session.continuity.checkpointed',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    bodyVersion: 1,
    body: snapshot,
  };
}

function sessionInterruptedEvent(sessionId: string, fault: SessionInterruptedFault): CoralEventInput {
  return {
    type: 'session.interrupted',
    stream: { kind: 'session', id: sessionId },
    refs: { sessionId },
    bodyVersion: 1,
    body: fault,
  };
}

function sessionClosedEvent(sessionId: string, reason: SessionCloseReason): CoralEventInput {
  return {
    type: 'session.closed',
    stream: { kind: 'session', id: sessionId },
    refs: { sessionId },
    bodyVersion: 1,
    body: { reason },
  };
}

export class SessionManager {
  private readonly storage: RuntimeStoragePort;
  private readonly paths: RuntimePathsPort;
  private readonly time: RuntimeTimePort;
  private readonly ids: RuntimeIdsPort;
  private readonly sessionDir: string;
  private readonly cache = new Map<string, SessionEntry>();
  private readonly knownSessionIds = new Set<string>();
  private shardStamp = 0;
  private cacheHydrated = false;

  constructor(workingDirectory: string, runtime: SessionRuntime, isRawShardPath = false) {
    this.storage = runtime.storage;
    this.paths = runtime.paths;
    this.time = runtime.time;
    this.ids = runtime.ids;
    this.sessionDir = isRawShardPath
      ? workingDirectory
      : join(this.paths.sessionBase(), toSessionNamespace(workingDirectory, this.paths, this.ids));
    if (!isRawShardPath) {
      this.storage.mkdirSync(this.sessionDir, { recursive: true });
    }
    this.shardStamp = this.readShardStamp();
  }

  /** Open an existing shard directory without creating it (recovery path). */
  static openShard(shardDir: string, runtime: SessionRuntime): SessionManager {
    return new SessionManager(shardDir, runtime, true);
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

  private persistEntry(entry: SessionEntry, options: { incrementVersion?: boolean } = {}): SessionEntry {
    this.syncCacheWithShardStamp();
    const filePath = this.sessionPath(entry.sessionId);
    const stored: SessionEntry = {
      ...entry,
      version: options.incrementVersion === false ? entry.version : (entry.version ?? 0) + 1,
    };
    const didWrite = this.storage.writeAtomicSync(filePath, JSON.stringify(stored, null, 2), { encoding: 'utf-8' });
    if (!didWrite) return stored;
    this.shardStamp = this.readShardStamp();
    this.populateCache(stored.sessionId, stored);
    return stored;
  }

  private rollbackEntry(previousEntry: SessionEntry | null, sessionId: string): void {
    if (previousEntry) {
      this.persistEntry(previousEntry, { incrementVersion: false });
      return;
    }

    this.storage.rmSync(this.sessionPath(sessionId), { force: true });
    this.cache.delete(sessionId);
    this.knownSessionIds.delete(sessionId);
    this.shardStamp = this.readShardStamp();
  }

  private appendSessionEvent(input: CoralEventInput): void {
    const { db, close } = isInMemoryStorage(this.storage)
      ? {
          db:
            inMemoryJournalByStorage.get(this.storage)
            ?? (() => {
                const created = openStoreDatabase({
                  path: ':memory:',
                  storage: migrationStorage,
                });
                inMemoryJournalByStorage.set(this.storage, created);
                return created;
              })(),
          close: () => {},
        }
      : {
          ...(() => {
            const db = openStoreDatabase({
              path: storeDbPath(),
              storage: this.storage,
            });
            return {
              db,
              close: () => db.close(),
            };
          })(),
        };

    try {
      appendEvents(
        db,
        [input],
        {
          now: () => new Date(this.time.now()),
          reducers: sessionReducers,
          upcasters: createEmptyRegistry(),
        },
      );
    } finally {
      close();
    }
  }

  private persistAndAppend(
    nextEntry: SessionEntry,
    eventInput: CoralEventInput,
    previousEntry: SessionEntry | null,
  ): SessionEntry {
    const stored = this.persistEntry(nextEntry);
    try {
      this.appendSessionEvent(eventInput);
      return stored;
    } catch (error: unknown) {
      this.rollbackEntry(previousEntry, nextEntry.sessionId);
      throw error;
    }
  }

  open(options: SessionAllocateOptions): SessionHandle {
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

    return this.persistAndAppend(entry, sessionOpenedEvent(entry), null);
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
    const options =
      typeof optionsOrProvider === 'string'
        ? {
            provider: optionsOrProvider,
            name: name ?? `session-${this.time.now()}`,
            model,
            cwd: cwd ?? '',
            ...(projectRoot !== undefined ? { projectRoot } : {}),
          }
        : optionsOrProvider;

    return this.open(options);
  }

  checkpoint(sessionId: string, snapshot: ContinuitySnapshot): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;
    const previous = cloneEntry(entry);

    entry.providerContinuity = snapshot.providerContinuity ?? undefined;
    entry.conversationRef = snapshot.conversationRef ?? undefined;
    entry.state = snapshot.resumable ? 'ready' : 'non_resumable';
    entry.lastUsedAt = nowIsoString(this.time);

    this.persistAndAppend(entry, sessionCheckpointedEvent(entry, snapshot), previous);
  }

  interrupt(sessionId: string, fault: SessionInterruptedFault): void {
    const entry = this.readEntry(sessionId);
    if (!entry) {
      this.appendSessionEvent(sessionInterruptedEvent(sessionId, fault));
      return;
    }

    const previous = cloneEntry(entry);
    entry.lastUsedAt = nowIsoString(this.time);
    this.persistAndAppend(entry, sessionInterruptedEvent(sessionId, fault), previous);
  }

  close(sessionId: string, reason: SessionCloseReason): void {
    const entry = this.readEntry(sessionId);
    if (!entry) {
      this.appendSessionEvent(sessionClosedEvent(sessionId, reason));
      return;
    }

    const previous = cloneEntry(entry);
    entry.lastUsedAt = nowIsoString(this.time);
    this.persistAndAppend(entry, sessionClosedEvent(sessionId, reason), previous);
  }

  /** Set conversationRef and transition state from pending -> ready. */
  setConversationRef(sessionId: string, conversationRef: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;

    const previous = cloneEntry(entry);
    entry.conversationRef = conversationRef;
    entry.state = 'ready';
    entry.lastUsedAt = nowIsoString(this.time);

    this.persistAndAppend(entry, sessionCheckpointedEvent(entry, snapshotFromEntry(entry)), previous);
  }

  checkpointProviderContinuity(
    sessionId: string,
    update: { providerContinuity: ProviderContinuityBlob; conversationRef?: string },
  ): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;

    const previous = cloneEntry(entry);
    entry.providerContinuity = update.providerContinuity;
    if (update.conversationRef) {
      entry.conversationRef = update.conversationRef;
      entry.state = 'ready';
    }
    entry.lastUsedAt = nowIsoString(this.time);

    this.persistAndAppend(entry, sessionCheckpointedEvent(entry, snapshotFromEntry(entry)), previous);
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry) return;

    const previous = cloneEntry(entry);
    entry.state = 'non_resumable';
    entry.lastUsedAt = nowIsoString(this.time);

    this.persistAndAppend(entry, sessionCheckpointedEvent(entry, snapshotFromEntry(entry)), previous);
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    const release = await this.acquireSessionLock(sessionId);
    try {
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (!entry || entry.activeJobId) return false;
      if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
      entry.activeJobId = jobId;
      entry.lastUsedAt = nowIsoString(this.time);
      this.persistEntry(entry);
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

      const previous = cloneEntry(entry);
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

      this.persistAndAppend(entry, sessionCheckpointedEvent(entry, snapshotFromEntry(entry)), previous);
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
    this.persistEntry(entry);
    return true;
  }

  /** Release job claim: clear activeJobId, set lastJobId to completed job. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    entry.activeJobId = undefined;
    entry.lastJobId = jobId;
    entry.lastUsedAt = nowIsoString(this.time);
    this.persistEntry(entry);
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
