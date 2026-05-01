import { resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import { commit as commitJournalEvents, type CommitEventsFn } from '../../store/append.js';
import { noProviderLookupPort } from '../../providers/catalog.js';
import type { CoralEventInput } from '../../store/envelope.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { nowDate, nowIsoString } from '../../infra/time.js';
import { providerIdentPattern } from '../../infra/identifiers.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import type { Runtime, IdPort, TimePort } from '../../runtime/ports.js';
import { composeReducers } from '../../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../../store/upcaster-registry.js';
import {
  DEFAULT_SESSION_CONTROLLER,
  sessionControllerFromProfile,
  sessionEntrySchema,
  type SessionEntry,
} from '../entry.js';
import type { SessionAllocateOptions } from '../contracts.js';
import { sessionsRegistry } from '../events.js';
import type {
  SessionClaimedBody,
  SessionClaimReleasedBody,
  SessionContinuityCheckpointedBody,
  SessionOpenedBody,
} from '../event-bodies.js';
import type { SessionContinuityMutation } from '../continuity-mutation.js';
import type { ContinuitySnapshot, ProviderContinuityBlob } from '../continuity.js';
import { listProjectionSessionEntries, readProjectionSession } from '../projections.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;
type SessionReleasedEmitter = (payload: { sessionId: string; jobId: string }) => void;
type Database = BetterSqlite3.Database;
type SessionStoreEventBody =
  | SessionOpenedBody
  | SessionContinuityCheckpointedBody
  | SessionClaimedBody
  | SessionClaimReleasedBody;

export type SessionManagerOptions = {
  db: Database;
};

function toSessionNamespace(dir: string, ids: Pick<IdPort, 'sha256'>): string {
  try {
    return pluginRootNamespace(dir);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return ids.sha256(resolve(dir)).slice(0, 12);
    }
    throw error;
  }
}

function isValidEntry(value: unknown): value is SessionEntry {
  const parsed = sessionEntrySchema.safeParse(value);
  if (!parsed.success) return false;
  if (!providerIdentPattern.test(parsed.data.provider)) return false;
  return true;
}

function normalizeEntry(entry: SessionEntry): SessionEntry {
  return {
    ...entry,
    activeJobId: entry.activeJobId,
  };
}

function snapshotFromEntry(
  entry: Pick<SessionEntry, 'conversationRef' | 'providerContinuity' | 'state'>,
): ContinuitySnapshot {
  return {
    conversationRef: entry.conversationRef ?? null,
    resumable: entry.state === 'ready',
    providerContinuity: entry.providerContinuity ?? null,
  };
}

function sessionOpenedEvent(entry: SessionEntry, scopeKey: string): CoralEventInput<SessionOpenedBody> {
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    bodyVersion: 1,
    body: {
      entry,
      controller: sessionControllerFromProfile(entry.controllerProfile) || DEFAULT_SESSION_CONTROLLER,
      provider: entry.provider,
      scope_key: scopeKey,
    },
  };
}

function sessionCheckpointedEvent(
  entry: SessionEntry,
  snapshot: ContinuitySnapshot,
): CoralEventInput<SessionContinuityCheckpointedBody> {
  return {
    type: 'session.continuity.checkpointed',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId },
    bodyVersion: 1,
    body: {
      entry,
      snapshot,
    },
  };
}

function sessionClaimedEvent(entry: SessionEntry, jobId: string): CoralEventInput<SessionClaimedBody> {
  return {
    type: 'session.claimed',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    bodyVersion: 1,
    body: {
      entry,
      jobId,
    },
  };
}

function sessionClaimReleasedEvent(entry: SessionEntry, jobId: string): CoralEventInput<SessionClaimReleasedBody> {
  return {
    type: 'session.claim.released',
    stream: { kind: 'session', id: entry.sessionId },
    refs: { sessionId: entry.sessionId, jobId },
    bodyVersion: 1,
    body: {
      entry,
      jobId,
    },
  };
}

function createLocalSessionCommit(db: Database, time: TimePort): CommitEventsFn {
  const reducers = composeReducers(sessionsRegistry);
  const upcasters = createDefaultUpcasterRegistry();

  return (cb) =>
    commitJournalEvents(db, cb, {
      now: () => nowDate(time),
      reducers,
      upcasters,
      // Sessions domain has no append-time provider validators today
      // (validateWorkflowPlanValidity is workflow-only). Fail-closed baseline:
      // any future session validator that consults providers will reject
      // unless a real port is wired through composition.
      providers: noProviderLookupPort,
    });
}

export class SessionManager {
  private readonly time: TimePort;
  private readonly ids: IdPort;
  private readonly commitEvents: CommitEventsFn;
  private readonly releaseEmitter: SessionReleasedEmitter;
  private readonly scopeKey: string;
  private readonly db: Database;
  private readonly cache = new Map<string, SessionEntry>();
  private readonly knownSessionIds = new Set<string>();

  constructor(
    workingDirectory: string,
    runtime: SessionRuntime,
    commitEvents: CommitEventsFn | undefined,
    releaseEmitter: SessionReleasedEmitter = () => {},
    db: Database,
  ) {
    this.time = runtime.time;
    this.ids = runtime.ids;
    this.db = db;
    this.commitEvents = commitEvents ?? createLocalSessionCommit(this.db, this.time);
    this.releaseEmitter = releaseEmitter;
    this.scopeKey = toSessionNamespace(workingDirectory, this.ids);
  }

  static forProduction(
    workingDirectory: string,
    runtime: SessionRuntime,
    commitEvents: CommitEventsFn | undefined,
    releaseEmitter: SessionReleasedEmitter,
    options: SessionManagerOptions,
  ): SessionManager {
    return new SessionManager(workingDirectory, runtime, commitEvents, releaseEmitter, options.db);
  }

  private populateCache(sessionId: string, entry: SessionEntry): void {
    this.cache.set(sessionId, normalizeEntry(entry));
    this.knownSessionIds.add(sessionId);
  }

  private readEntry(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    if (!options?.forceFresh) {
      const cached = this.cache.get(sessionId);
      if (cached) return normalizeEntry(cached);
    }

    const projected = readProjectionSession(this.db, sessionId);
    if (projected === null || projected.scopeKey !== this.scopeKey) {
      this.cache.delete(sessionId);
      this.knownSessionIds.delete(sessionId);
      return null;
    }

    if (!isValidEntry(projected.entry)) {
      this.cache.delete(sessionId);
      this.knownSessionIds.delete(sessionId);
      return null;
    }

    const normalized = normalizeEntry(projected.entry);
    this.populateCache(sessionId, normalized);
    return normalized;
  }

  readById(sessionId: string, options?: { forceFresh?: boolean }): SessionEntry | null {
    return this.readEntry(sessionId, options);
  }

  private appendSessionEvent(input: CoralEventInput<SessionStoreEventBody>): void {
    this.commitEvents((c) => {
      c.append(input);
      return undefined;
    });
  }

  private appendEntryEvent(nextEntry: SessionEntry, eventInput: CoralEventInput<SessionStoreEventBody>): SessionEntry {
    this.appendSessionEvent(eventInput);
    this.populateCache(nextEntry.sessionId, nextEntry);
    return normalizeEntry(nextEntry);
  }

  private bumpVersion(entry: SessionEntry): number {
    return (entry.version ?? 0) + 1;
  }

  open(options: SessionAllocateOptions): SessionEntry {
    const now = nowIsoString(this.time);
    const entry: SessionEntry = {
      sessionId: this.ids.uuid(),
      provider: options.provider,
      name: options.name,
      state: 'pending',
      model: options.model,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      backendNamespace: options.backendNamespace,
      ...(options.agentName !== undefined ? { agentName: options.agentName } : {}),
      ...(options.instruction !== undefined ? { instruction: options.instruction } : {}),
      ...(options.bypassPermissions !== undefined ? { bypassPermissions: options.bypassPermissions } : {}),
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.controllerProfile !== undefined ? { controllerProfile: options.controllerProfile } : {}),
      createdAt: now,
      lastUsedAt: now,
      version: 1,
    };

    return this.appendEntryEvent(entry, sessionOpenedEvent(entry, this.scopeKey));
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
        ? (() => {
            const resolvedCwd = cwd ?? '';
            const resolvedProjectRoot = projectRoot ?? resolvedCwd;
            return {
              provider: optionsOrProvider,
              name: name ?? `session-${this.time.now()}`,
              model,
              cwd: resolvedCwd,
              projectRoot: resolvedProjectRoot,
              backendNamespace: pluginRootNamespace(resolvedProjectRoot),
            };
          })()
        : optionsOrProvider;

    return this.open(options);
  }

  checkpoint(sessionId: string, snapshot: ContinuitySnapshot): void {
    const currentEntry = this.readEntry(sessionId);
    if (!currentEntry) return;

    const nextEntry: SessionEntry = {
      ...currentEntry,
      providerContinuity: snapshot.providerContinuity ?? undefined,
      conversationRef: snapshot.conversationRef ?? undefined,
      state: snapshot.resumable ? 'ready' : 'non_resumable',
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshot));
  }

  /** Set conversationRef and transition state from pending -> ready. */
  setConversationRef(sessionId: string, conversationRef: string): void {
    const currentEntry = this.readEntry(sessionId);
    if (!currentEntry) return;

    const nextEntry: SessionEntry = {
      ...currentEntry,
      conversationRef,
      state: 'ready',
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshotFromEntry(nextEntry)));
  }

  checkpointProviderContinuity(
    sessionId: string,
    update: { providerContinuity: ProviderContinuityBlob; conversationRef?: string },
  ): void {
    const currentEntry = this.readEntry(sessionId);
    if (!currentEntry) return;

    const nextEntry: SessionEntry = {
      ...currentEntry,
      providerContinuity: update.providerContinuity,
      ...(update.conversationRef ? { conversationRef: update.conversationRef, state: 'ready' as const } : {}),
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshotFromEntry(nextEntry)));
  }

  /** Transition session to non_resumable (provider completed without yielding a conversationRef). */
  setNonResumable(sessionId: string): void {
    const currentEntry = this.readEntry(sessionId);
    if (!currentEntry) return;

    const nextEntry: SessionEntry = {
      ...currentEntry,
      state: 'non_resumable',
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshotFromEntry(nextEntry)));
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    const entry = this.readEntry(sessionId, { forceFresh: true });
    if (!entry || entry.activeJobId) return false;
    if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: jobId,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionClaimedEvent(nextEntry, jobId));
    return true;
  }

  async finalizeJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      mutation: SessionContinuityMutation;
    },
  ): Promise<boolean> {
    const { expectedActiveJobId, expectedVersion, mutation } = options;
    const currentEntry = this.readEntry(sessionId, { forceFresh: true });
    if (!currentEntry) return false;
    if (currentEntry.activeJobId !== expectedActiveJobId) return false;
    if (currentEntry.version !== expectedVersion) return false;

    const baseNextEntry: SessionEntry = {
      ...currentEntry,
      activeJobId: undefined,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
      ...(mutation.providerContinuity ? { providerContinuity: mutation.providerContinuity } : {}),
    };
    const nextEntry: SessionEntry = (() => {
      switch (mutation.type) {
        case 'set_resumable':
          return {
            ...baseNextEntry,
            conversationRef: mutation.conversationRef,
            state: 'ready',
          };
        case 'clear_non_resumable':
          return {
            ...baseNextEntry,
            conversationRef: undefined,
            state: 'non_resumable',
          };
        case 'preserve':
          return baseNextEntry;
      }
    })();

    this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshotFromEntry(nextEntry)));
    this.releaseEmitter({ sessionId, jobId: expectedActiveJobId });
    return true;
  }

  async checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ContinuitySnapshot;
    },
  ): Promise<{ ok: true; nextVersion: number } | { ok: false }> {
    const { expectedActiveJobId, expectedVersion, snapshot } = options;
    const currentEntry = this.readEntry(sessionId, { forceFresh: true });
    if (!currentEntry) return { ok: false };
    if (currentEntry.activeJobId !== expectedActiveJobId) return { ok: false };
    if (currentEntry.version !== expectedVersion) return { ok: false };

    const nextEntry: SessionEntry = {
      ...currentEntry,
      conversationRef: snapshot.conversationRef ?? undefined,
      providerContinuity: snapshot.providerContinuity ?? undefined,
      state: snapshot.resumable ? 'ready' : 'non_resumable',
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    const stored = this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshot));
    return { ok: true, nextVersion: stored.version };
  }

  async releaseJobClaimAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
    },
  ): Promise<boolean> {
    const { expectedActiveJobId, expectedVersion } = options;
    const entry = this.readEntry(sessionId, { forceFresh: true });
    if (!entry) return false;
    if (entry.activeJobId !== expectedActiveJobId) return false;
    if (entry.version !== expectedVersion) return false;

    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: undefined,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionClaimReleasedEvent(nextEntry, expectedActiveJobId));
    this.releaseEmitter({ sessionId, jobId: expectedActiveJobId });
    return true;
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
    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: jobId,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionClaimedEvent(nextEntry, jobId));
    return true;
  }

  /** Release job claim: clear activeJobId. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: undefined,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionClaimReleasedEvent(nextEntry, jobId));
    this.releaseEmitter({ sessionId, jobId });
  }

  /** Provider-scoped lookup. Returns null if sessionId not found or provider mismatch. */
  get(provider: string, sessionId: string): SessionEntry | null {
    const entry = this.readEntry(sessionId, { forceFresh: true });
    if (!entry || entry.provider !== provider) return null;
    return entry;
  }

  /** List all sessions for a provider. */
  list(provider: string): SessionEntry[] {
    const entries = listProjectionSessionEntries(this.db, provider, this.scopeKey);
    this.knownSessionIds.clear();
    for (const entry of entries) {
      this.populateCache(entry.sessionId, entry);
    }
    return entries.map(normalizeEntry);
  }
}
