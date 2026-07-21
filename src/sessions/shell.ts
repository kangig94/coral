import { resolve } from 'node:path';
import type { Database } from '../store/db.js';

import { commit as commitJournalEvents, type CommitEventsFn } from '../store/append.js';
import { noProviderLookupPort } from '../providers/catalog.js';
import type { CoralEventInput } from '../store/envelope.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { nowDate, nowIsoString } from '../infra/time.js';
import { providerIdentPattern } from '../infra/identifiers.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime, IdPort } from '../runtime/ports.js';
import { composeReducers } from '../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../store/upcaster-registry.js';
import { providerArtifactIdentityKey } from '../providers/artifact-identity.js';
import {
  claimContinuationLeaseInputSchema,
  clearContinuationLeaseInputSchema,
  type ClaimedContinuationLease,
  type ClearedContinuationLease,
  type ClaimContinuationLeaseInput,
  type ClearContinuationLeaseInput,
  hasUnterminalRetentionDiscardRequest,
  isProtectiveContinuationLease,
  type PendingContinuationLease,
  type ProviderArtifactHandle,
  recordContinuationLeaseInputSchema,
  type RecordContinuationLeaseInput,
  sessionControllerFromProfile,
  type SessionContinuationLease,
  sessionEntrySchema,
  type SessionEntry,
} from './entry.js';
import type {
  SessionAllocateOptions,
  SessionArtifactHandleRecordOptions,
  SessionArtifactHandleRecordResult,
} from './contracts.js';
import { sessionsRegistry } from './events.js';
import type {
  SessionArtifactHandleRecordedBody,
  SessionClaimedBody,
  SessionClaimReleasedBody,
  SessionContinuationLeaseClaimedBody,
  SessionContinuationLeaseClearedBody,
  SessionContinuationLeaseExpiredBody,
  SessionContinuationLeaseRecordedBody,
  SessionContinuityCheckpointedBody,
  SessionOpenedBody,
} from './event-bodies.js';
import {
  sessionContinuationLeaseClaimedEvent,
  sessionContinuationLeaseClearedEvent,
  sessionContinuationLeaseRecordedEvent,
} from './continuation-lease-events.js';
import type { SessionContinuityMutation } from './continuity-mutation.js';
import { readContinuityRef, type ContinuitySnapshot, type ProviderContinuityBlob } from './continuity.js';
import { normalizeSessionEntry as normalizeEntry } from './entry-normalization.js';
import { listProjectionSessionEntries, readProjectionSession } from './projections.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;
type SessionReleasedEmitter = (payload: { sessionId: string; jobId: string }) => void;
type SessionStoreEventBody =
  | SessionOpenedBody
  | SessionContinuityCheckpointedBody
  | SessionArtifactHandleRecordedBody
  | SessionClaimedBody
  | SessionClaimReleasedBody
  | SessionContinuationLeaseRecordedBody
  | SessionContinuationLeaseClaimedBody
  | SessionContinuationLeaseClearedBody
  | SessionContinuationLeaseExpiredBody;

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

function withoutConversationRef(entry: SessionEntry): SessionEntry {
  const { conversationRef: _conversationRef, ...rest } = entry;
  return rest;
}

function withoutActiveJobId(entry: SessionEntry): SessionEntry {
  const { activeJobId: _activeJobId, ...rest } = entry;
  return rest;
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
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      controller: sessionControllerFromProfile(normalizedEntry.controllerProfile),
      provider: normalizedEntry.provider,
      scope_key: scopeKey,
    },
  };
}

function sessionCheckpointedEvent(
  entry: SessionEntry,
  snapshot: ContinuitySnapshot,
): CoralEventInput<SessionContinuityCheckpointedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.continuity.checkpointed',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      snapshot,
    },
  };
}

function sessionArtifactHandleRecordedEvent(
  entry: SessionEntry,
  artifact: ProviderArtifactHandle,
): CoralEventInput<SessionArtifactHandleRecordedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.artifact.handle.recorded',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: {
      sessionId: normalizedEntry.sessionId,
      ...(artifact.sourceJobId !== undefined ? { jobId: artifact.sourceJobId } : {}),
    },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      provider: artifact.provider,
      handle: artifact.handle,
      identity: artifact.identity,
      identityKey: artifact.identityKey,
      ...(artifact.sourceJobId !== undefined ? { sourceJobId: artifact.sourceJobId } : {}),
    },
  };
}

function sessionClaimedEvent(entry: SessionEntry, jobId: string): CoralEventInput<SessionClaimedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.claimed',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      jobId,
    },
  };
}

function sessionClaimReleasedEvent(entry: SessionEntry, jobId: string): CoralEventInput<SessionClaimReleasedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.claim.released',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId },
    bodyVersion: 1,
    body: {
      entry: normalizedEntry,
      jobId,
    },
  };
}

function claimLease(
  lease: SessionContinuationLease | undefined,
  input: ClaimContinuationLeaseInput,
  now: string,
): ClaimedContinuationLease | null {
  if (lease === undefined) {
    return null;
  }
  if (
    lease.status === 'claimed' &&
    lease.staleJobId === input.staleJobId &&
    lease.resumedJobId === input.resumedJobId
  ) {
    return lease;
  }
  if (lease.status !== 'pending' || lease.staleJobId !== input.staleJobId) {
    return null;
  }
  if (!isProtectiveContinuationLease(lease, Date.parse(now))) {
    return null;
  }
  return {
    ...lease,
    status: 'claimed',
    resumedJobId: input.resumedJobId,
    claimedAt: now,
  };
}

function clearLease(
  lease: SessionContinuationLease | undefined,
  input: ClearContinuationLeaseInput,
  now: string,
): ClearedContinuationLease | null {
  if (lease === undefined || lease.status === 'cleared' || lease.status === 'expired') {
    return null;
  }
  if (lease.status === 'pending' && lease.staleJobId !== input.jobId) {
    return null;
  }
  if (lease.status === 'claimed' && lease.staleJobId !== input.jobId && lease.resumedJobId !== input.jobId) {
    return null;
  }

  return {
    staleJobId: lease.staleJobId,
    reason: lease.reason,
    expiresAt: lease.expiresAt,
    recordedAt: lease.recordedAt,
    status: 'cleared',
    ...(lease.status === 'claimed'
      ? {
          resumedJobId: lease.resumedJobId,
          claimedAt: lease.claimedAt,
        }
      : {}),
    clearedAt: now,
    clearedByJobId: input.jobId,
    outcome: input.outcome,
  };
}

/**
 * Non-production, test-only session appender. It intentionally does not install
 * the lifecycle post-commit observer; production session lifecycle facts must
 * flow through the coordinator-bound commit function supplied to forProduction.
 */
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
    commitEvents: CommitEventsFn,
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

  recordContinuationLease(input: RecordContinuationLeaseInput): void {
    const parsed = recordContinuationLeaseInputSchema.parse(input);
    const entry = this.readEntry(parsed.sessionId, { forceFresh: true });
    if (!entry) {
      throw new Error(`Cannot record continuation lease for unknown session ${parsed.sessionId}.`);
    }

    const now = nowIsoString(this.time);
    const lease: PendingContinuationLease = {
      status: 'pending',
      staleJobId: parsed.jobId,
      reason: parsed.reason,
      expiresAt: parsed.expiresAt,
      recordedAt: now,
    };
    const nextEntry: SessionEntry = {
      ...entry,
      continuationLease: lease,
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionContinuationLeaseRecordedEvent(nextEntry, lease));
  }

  async claimContinuationLease(input: ClaimContinuationLeaseInput): Promise<boolean> {
    const parsed = claimContinuationLeaseInputSchema.parse(input);
    const entry = this.readEntry(parsed.sessionId, { forceFresh: true });
    if (!entry) return false;

    const now = nowIsoString(this.time);
    const lease = claimLease(entry.continuationLease, parsed, now);
    if (lease === null) return false;
    if (entry.continuationLease?.status === 'claimed' && entry.continuationLease.resumedJobId === parsed.resumedJobId) {
      return true;
    }

    const nextEntry: SessionEntry = {
      ...entry,
      continuationLease: lease,
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionContinuationLeaseClaimedEvent(nextEntry, lease));
    return true;
  }

  async clearContinuationLease(input: ClearContinuationLeaseInput): Promise<boolean> {
    const parsed = clearContinuationLeaseInputSchema.parse(input);
    const entry = this.readEntry(parsed.sessionId, { forceFresh: true });
    if (!entry) return false;

    const now = nowIsoString(this.time);
    const lease = clearLease(entry.continuationLease, parsed, now);
    if (lease === null) return false;

    const nextEntry: SessionEntry = {
      ...entry,
      continuationLease: lease,
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionContinuationLeaseClearedEvent(nextEntry, lease));
    return true;
  }

  open(options: SessionAllocateOptions): SessionEntry {
    const now = nowIsoString(this.time);
    const entry: SessionEntry = {
      sessionId: this.ids.uuid(),
      provider: options.provider,
      sessionAuthority: options.sessionAuthority,
      name: options.name,
      state: 'pending',
      retention: options.retention ?? 'retain',
      artifactHandles: [],
      retentionDiscard: { attempts: [] },
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      backendNamespace: options.backendNamespace,
      providerContinuity: null,
      ...(options.model !== undefined ? { model: options.model } : {}),
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
  allocate(options: SessionAllocateOptions): SessionEntry {
    return this.open(options);
  }

  checkpoint(sessionId: string, snapshot: ContinuitySnapshot): void {
    const currentEntry = this.readEntry(sessionId);
    if (!currentEntry) return;

    const checkpointBase = withoutConversationRef(currentEntry);
    const nextEntry: SessionEntry = {
      ...checkpointBase,
      providerContinuity: snapshot.providerContinuity,
      ...(snapshot.conversationRef === null ? {} : { conversationRef: snapshot.conversationRef }),
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
    const conversationRef = readContinuityRef(update.conversationRef);

    const nextEntry: SessionEntry = {
      ...currentEntry,
      providerContinuity: update.providerContinuity,
      ...(conversationRef !== undefined ? { conversationRef, state: 'ready' as const } : {}),
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
    if (hasUnterminalRetentionDiscardRequest(entry)) return false;
    if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
    const now = nowIsoString(this.time);
    const lease =
      entry.continuationLease?.status === 'pending'
        ? claimLease(
            entry.continuationLease,
            {
              sessionId,
              staleJobId: entry.continuationLease.staleJobId,
              resumedJobId: jobId,
            },
            now,
          )
        : null;
    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: jobId,
      ...(lease === null ? {} : { continuationLease: lease }),
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    const claimedEvent = sessionClaimedEvent(nextEntry, jobId);
    if (lease === null) {
      this.appendEntryEvent(nextEntry, claimedEvent);
      return true;
    }
    this.commitEvents((c) => {
      c.append(claimedEvent);
      c.append(sessionContinuationLeaseClaimedEvent(nextEntry, lease));
      return undefined;
    });
    this.populateCache(sessionId, nextEntry);
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

    const checkpointBaseEntry: SessionEntry = {
      ...currentEntry,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
      ...(mutation.providerContinuity ? { providerContinuity: mutation.providerContinuity } : {}),
    };
    const checkpointEntry: SessionEntry = (() => {
      switch (mutation.kind) {
        case 'set_resumable':
          return {
            ...checkpointBaseEntry,
            conversationRef: mutation.conversationRef,
            state: 'ready',
          };
        case 'clear_non_resumable':
          return {
            ...withoutConversationRef(checkpointBaseEntry),
            state: 'non_resumable',
          };
        case 'preserve':
          return checkpointBaseEntry;
      }
    })();

    const releasedBase = withoutActiveJobId(checkpointEntry);
    const now = nowIsoString(this.time);
    const clearedLease =
      checkpointEntry.continuationLease?.status === 'claimed' &&
      checkpointEntry.continuationLease.resumedJobId === expectedActiveJobId
        ? clearLease(
            checkpointEntry.continuationLease,
            { sessionId, jobId: expectedActiveJobId, outcome: 'resumed_released' },
            now,
          )
        : null;
    const releaseEntry: SessionEntry = {
      ...releasedBase,
      ...(clearedLease === null ? {} : { continuationLease: clearedLease }),
      version: this.bumpVersion(checkpointEntry),
    };
    const checkpointEvent = sessionCheckpointedEvent(checkpointEntry, snapshotFromEntry(checkpointEntry));
    const claimReleasedEvent = sessionClaimReleasedEvent(releaseEntry, expectedActiveJobId);

    this.commitEvents((c) => {
      c.append(checkpointEvent);
      c.append(claimReleasedEvent);
      if (clearedLease !== null) {
        c.append(sessionContinuationLeaseClearedEvent(releaseEntry, clearedLease));
      }
      return undefined;
    });
    this.populateCache(sessionId, releaseEntry);
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

    const checkpointBase = withoutConversationRef(currentEntry);
    const nextEntry: SessionEntry = {
      ...checkpointBase,
      ...(snapshot.conversationRef === null ? {} : { conversationRef: snapshot.conversationRef }),
      providerContinuity: snapshot.providerContinuity,
      state: snapshot.resumable ? 'ready' : 'non_resumable',
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    const stored = this.appendEntryEvent(nextEntry, sessionCheckpointedEvent(nextEntry, snapshot));
    return { ok: true, nextVersion: stored.version };
  }

  async recordArtifactHandleAtomic(
    sessionId: string,
    options: SessionArtifactHandleRecordOptions,
  ): Promise<SessionArtifactHandleRecordResult> {
    const { expectedActiveJobId, expectedVersion, provider, handle, sourceJobId } = options;
    const currentEntry = this.readEntry(sessionId, { forceFresh: true });
    if (!currentEntry) return { ok: false };
    if (currentEntry.activeJobId !== expectedActiveJobId) return { ok: false };
    if (currentEntry.version !== expectedVersion) return { ok: false };

    const identity = options.identity;
    const identityKey = providerArtifactIdentityKey(provider, identity);
    if (
      currentEntry.artifactHandles.some(
        (artifact) =>
          artifact.provider === provider &&
          artifact.identityKey === identityKey &&
          artifact.sourceJobId === sourceJobId,
      )
    ) {
      return { ok: true, nextVersion: currentEntry.version };
    }

    const artifact: ProviderArtifactHandle = {
      provider,
      handle,
      identity,
      identityKey,
      ...(sourceJobId !== undefined ? { sourceJobId } : {}),
      recordedAt: nowIsoString(this.time),
    };
    const nextEntry: SessionEntry = {
      ...currentEntry,
      artifactHandles: [...currentEntry.artifactHandles, artifact],
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(currentEntry),
    };

    const stored = this.appendEntryEvent(nextEntry, sessionArtifactHandleRecordedEvent(nextEntry, artifact));
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

    const now = nowIsoString(this.time);
    const clearedLease =
      entry.continuationLease?.status === 'claimed' && entry.continuationLease.resumedJobId === expectedActiveJobId
        ? clearLease(
            entry.continuationLease,
            { sessionId, jobId: expectedActiveJobId, outcome: 'resumed_released' },
            now,
          )
        : null;
    const nextEntry: SessionEntry = {
      ...withoutActiveJobId(entry),
      ...(clearedLease === null ? {} : { continuationLease: clearedLease }),
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    const claimReleasedEvent = sessionClaimReleasedEvent(nextEntry, expectedActiveJobId);
    if (clearedLease === null) {
      this.appendEntryEvent(nextEntry, claimReleasedEvent);
    } else {
      this.commitEvents((c) => {
        c.append(claimReleasedEvent);
        c.append(sessionContinuationLeaseClearedEvent(nextEntry, clearedLease));
        return undefined;
      });
      this.populateCache(sessionId, nextEntry);
    }
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
      mutation: { kind: 'clear_non_resumable' },
    });
  }

  /**
   * Claim the session synchronously (no lock). For test and startup-only paths
   * where concurrent access is not a concern.
   */
  claimForJobSync(sessionId: string, jobId: string): boolean {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId) return false;
    const now = nowIsoString(this.time);
    const lease =
      entry.continuationLease?.status === 'pending'
        ? claimLease(
            entry.continuationLease,
            {
              sessionId,
              staleJobId: entry.continuationLease.staleJobId,
              resumedJobId: jobId,
            },
            now,
          )
        : null;
    const nextEntry: SessionEntry = {
      ...entry,
      activeJobId: jobId,
      ...(lease === null ? {} : { continuationLease: lease }),
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    const claimedEvent = sessionClaimedEvent(nextEntry, jobId);
    if (lease === null) {
      this.appendEntryEvent(nextEntry, claimedEvent);
      return true;
    }
    this.commitEvents((c) => {
      c.append(claimedEvent);
      c.append(sessionContinuationLeaseClaimedEvent(nextEntry, lease));
      return undefined;
    });
    this.populateCache(sessionId, nextEntry);
    return true;
  }

  /** Release job claim: clear activeJobId. */
  releaseJob(sessionId: string, jobId: string): void {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId !== jobId) return;
    const now = nowIsoString(this.time);
    const clearedLease =
      entry.continuationLease?.status === 'claimed' && entry.continuationLease.resumedJobId === jobId
        ? clearLease(entry.continuationLease, { sessionId, jobId, outcome: 'resumed_released' }, now)
        : null;
    const nextEntry: SessionEntry = {
      ...withoutActiveJobId(entry),
      ...(clearedLease === null ? {} : { continuationLease: clearedLease }),
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    const claimReleasedEvent = sessionClaimReleasedEvent(nextEntry, jobId);
    if (clearedLease === null) {
      this.appendEntryEvent(nextEntry, claimReleasedEvent);
    } else {
      this.commitEvents((c) => {
        c.append(claimReleasedEvent);
        c.append(sessionContinuationLeaseClearedEvent(nextEntry, clearedLease));
        return undefined;
      });
      this.populateCache(sessionId, nextEntry);
    }
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
