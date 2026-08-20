import { resolve } from 'node:path';
import type { Database } from '../store/db.js';

import { commit as commitJournalEvents, type CommitContext, type CommitEventsFn } from '../store/append.js';
import type { ProviderLookupPort } from '../providers/catalog.js';
import type { CoralEventInput } from '../store/envelope.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { nowDate, nowIsoString } from '../infra/time.js';
import { providerIdentPattern } from '../infra/identifiers.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import type { TimePort } from '../infra/port-types.js';
import type { Runtime, IdPort } from '../runtime/ports.js';
import { composeReducers } from '../store/reducers.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { providerArtifactIdentityKey } from '../providers/artifact-identity.js';
import {
  clearContinuationLeaseInputSchema,
  type ClaimedContinuationLease,
  type ClearedContinuationLease,
  type ClearContinuationLeaseInput,
  hasUnterminalRetentionDiscardRequest,
  isProtectiveContinuationLease,
  type PendingContinuationLease,
  type ProviderArtifactHandle,
  recordContinuationLeaseInputSchema,
  type RecordContinuationLeaseInput,
  sessionControllerFromProfile,
  type SessionContinuationLease,
  providerSessionSchema,
  providerSessionProvider,
  type ProviderSession,
} from './entry.js';
import type {
  SessionAllocateOptions,
  SessionArtifactHandleRecordOptions,
  SessionArtifactHandleRecordResult,
  SessionJobClaimReleaseResult,
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
import type { ProviderValidatedSessionContinuityMutation } from './continuity-mutation.js';
import type { ContinuitySnapshot, ProviderValidatedContinuitySnapshot } from './continuity.js';
import { normalizeProviderSession as normalizeEntry } from './entry-normalization.js';
import { listProjectionSessionEntries, readProjectionSession } from './projections.js';
import { SessionClaimError } from './claim-error.js';

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

function isValidEntry(value: unknown): value is ProviderSession {
  const parsed = providerSessionSchema.safeParse(value);
  if (!parsed.success) return false;
  if (!providerIdentPattern.test(providerSessionProvider(parsed.data))) return false;
  return true;
}

function withoutConversationRef(entry: ProviderSession): ProviderSession {
  const { conversationRef: _conversationRef, ...rest } = entry;
  return rest;
}

function withoutActiveJobId(entry: ProviderSession): ProviderSession {
  const { activeJobId: _activeJobId, ...rest } = entry;
  return rest;
}

function snapshotFromEntry(
  entry: Pick<ProviderSession, 'conversationRef' | 'providerContinuity' | 'state'>,
): ContinuitySnapshot {
  return {
    conversationRef: entry.conversationRef ?? null,
    resumable: entry.state === 'ready',
    providerContinuity: entry.providerContinuity ?? null,
  };
}

function sessionOpenedEvent(entry: ProviderSession, scopeKey: string): CoralEventInput<SessionOpenedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.opened',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId },
    body: {
      entry: normalizedEntry,
      controller: sessionControllerFromProfile(normalizedEntry.controllerProfile),
      scope_key: scopeKey,
    },
  };
}

function sessionCheckpointedEvent(
  entry: ProviderSession,
  snapshot: ContinuitySnapshot,
): CoralEventInput<SessionContinuityCheckpointedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.continuity.checkpointed',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId },
    body: {
      entry: normalizedEntry,
      snapshot,
    },
  };
}

function sessionArtifactHandleRecordedEvent(
  entry: ProviderSession,
  artifact: ProviderArtifactHandle,
): CoralEventInput<SessionArtifactHandleRecordedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.artifact.handle.recorded',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: {
      sessionId: normalizedEntry.sessionId,
      jobId: artifact.sourceJobId,
    },
    body: {
      entry: normalizedEntry,
      handle: artifact.handle,
      identity: artifact.identity,
      identityKey: artifact.identityKey,
      sourceJobId: artifact.sourceJobId,
    },
  };
}

function sessionClaimedEvent(entry: ProviderSession, jobId: string): CoralEventInput<SessionClaimedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.claimed',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId },
    body: {
      entry: normalizedEntry,
      jobId,
    },
  };
}

function sessionClaimReleasedEvent(entry: ProviderSession, jobId: string): CoralEventInput<SessionClaimReleasedBody> {
  const normalizedEntry = normalizeEntry(entry);
  return {
    type: 'session.claim.released',
    stream: { kind: 'session', id: normalizedEntry.sessionId },
    refs: { sessionId: normalizedEntry.sessionId, jobId },
    body: {
      entry: normalizedEntry,
      jobId,
    },
  };
}

function claimLease(
  lease: SessionContinuationLease | undefined,
  input: { staleJobId: string; resumedJobId: string },
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
    workflowId: lease.workflowId,
    workflowSlotId: lease.workflowSlotId,
    replacementGeneration: lease.replacementGeneration,
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
function createLocalSessionCommit(db: Database, time: TimePort, providers: ProviderLookupPort): CommitEventsFn {
  const reducers = composeReducers(sessionsRegistry);
  const bodyCodec = createEventBodyCodec();

  return (cb) =>
    commitJournalEvents(db, cb, {
      now: () => nowDate(time),
      reducers,
      bodyCodec,
      providers,
    });
}

export class SessionManager {
  private readonly time: TimePort;
  private readonly ids: IdPort;
  private readonly commitEvents: CommitEventsFn;
  private readonly releaseEmitter: SessionReleasedEmitter;
  private readonly scopeKey: string;
  private readonly db: Database;
  private readonly cache = new Map<string, ProviderSession>();
  private readonly knownSessionIds = new Set<string>();

  constructor(
    workingDirectory: string,
    runtime: SessionRuntime,
    commitEvents: undefined,
    releaseEmitter: SessionReleasedEmitter | undefined,
    db: Database,
    providers: ProviderLookupPort,
  );
  constructor(
    workingDirectory: string,
    runtime: SessionRuntime,
    commitEvents: CommitEventsFn,
    releaseEmitter: SessionReleasedEmitter | undefined,
    db: Database,
  );
  constructor(
    workingDirectory: string,
    runtime: SessionRuntime,
    commitEvents: CommitEventsFn | undefined,
    releaseEmitter: SessionReleasedEmitter | undefined,
    db: Database,
    providers?: ProviderLookupPort,
  ) {
    this.time = runtime.time;
    this.ids = runtime.ids;
    this.db = db;
    if (commitEvents === undefined) {
      if (providers === undefined) {
        throw new Error('Standalone SessionManager requires an explicit provider lookup port.');
      }
      this.commitEvents = createLocalSessionCommit(this.db, this.time, providers);
    } else {
      this.commitEvents = commitEvents;
    }
    this.releaseEmitter = releaseEmitter ?? (() => {});
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

  private populateCache(sessionId: string, entry: ProviderSession): void {
    this.cache.set(sessionId, normalizeEntry(entry));
    this.knownSessionIds.add(sessionId);
  }

  private readEntry(sessionId: string, options?: { forceFresh?: boolean }): ProviderSession | null {
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

  readById(sessionId: string, options?: { forceFresh?: boolean }): ProviderSession | null {
    return this.readEntry(sessionId, options);
  }

  private appendSessionEvent(input: CoralEventInput<SessionStoreEventBody>): void {
    this.commitEvents((c) => {
      c.append(input);
      return undefined;
    });
  }

  private appendEntryEvent(
    nextEntry: ProviderSession,
    eventInput: CoralEventInput<SessionStoreEventBody>,
  ): ProviderSession {
    this.appendSessionEvent(eventInput);
    this.populateCache(nextEntry.sessionId, nextEntry);
    return normalizeEntry(nextEntry);
  }

  private bumpVersion(entry: ProviderSession): number {
    return (entry.version ?? 0) + 1;
  }

  recordContinuationLease(input: RecordContinuationLeaseInput): void {
    const parsed = recordContinuationLeaseInputSchema.parse(input);
    let nextEntry: ProviderSession | undefined;
    this.commitEvents((commit) => {
      const entry = this.readEntry(parsed.sessionId, { forceFresh: true });
      if (!entry) throw new Error(`Cannot record continuation lease for unknown session ${parsed.sessionId}.`);
      const now = nowIsoString(this.time);
      const lease: PendingContinuationLease = {
        status: 'pending',
        staleJobId: parsed.jobId,
        workflowId: parsed.workflowId,
        workflowSlotId: parsed.workflowSlotId,
        replacementGeneration: parsed.replacementGeneration,
        reason: parsed.reason,
        expiresAt: parsed.expiresAt,
        recordedAt: now,
      };
      nextEntry = {
        ...entry,
        continuationLease: lease,
        lastUsedAt: now,
        version: this.bumpVersion(entry),
      };
      commit.append(sessionContinuationLeaseRecordedEvent(nextEntry, lease));
      return undefined;
    });
    if (nextEntry !== undefined) this.populateCache(parsed.sessionId, nextEntry);
  }

  async clearContinuationLease(input: ClearContinuationLeaseInput): Promise<boolean> {
    const parsed = clearContinuationLeaseInputSchema.parse(input);
    let nextEntry: ProviderSession | undefined;
    this.commitEvents((commit) => {
      const entry = this.readEntry(parsed.sessionId, { forceFresh: true });
      if (!entry) return undefined;
      const now = nowIsoString(this.time);
      const lease = clearLease(entry.continuationLease, parsed, now);
      if (lease === null) return undefined;
      nextEntry = {
        ...entry,
        continuationLease: lease,
        lastUsedAt: now,
        version: this.bumpVersion(entry),
      };
      commit.append(sessionContinuationLeaseClearedEvent(nextEntry, lease));
      return undefined;
    });
    if (nextEntry === undefined) return false;
    this.populateCache(parsed.sessionId, nextEntry);
    return true;
  }

  open(options: SessionAllocateOptions): ProviderSession {
    const entry = this.prepare(options);
    return this.appendEntryEvent(entry, sessionOpenedEvent(entry, this.scopeKey));
  }

  /** Build a first-turn session without making it visible before admission succeeds. */
  prepare(options: SessionAllocateOptions): ProviderSession {
    const now = nowIsoString(this.time);
    return {
      sessionId: this.ids.uuid(),
      binding: options.binding,
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
  }

  /** Append the open and first claim to the caller's coordinator transaction. */
  appendPreparedClaim<Scope>(commit: CommitContext<Scope>, prepared: ProviderSession, jobId: string): ProviderSession {
    if (prepared.activeJobId !== undefined || prepared.version !== 1) {
      throw new Error(`Initial claim requires a fresh prepared session: ${prepared.sessionId}`);
    }
    const claimed: ProviderSession = {
      ...prepared,
      activeJobId: jobId,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(prepared),
    };
    commit.append(sessionOpenedEvent(prepared, this.scopeKey));
    commit.append(sessionClaimedEvent(claimed, jobId));
    return claimed;
  }

  /** Append a resumable-session claim to the caller's launch transaction. */
  appendJobClaim<Scope>(
    commit: CommitContext<Scope>,
    input: { sessionId: string; jobId: string; expectedVersion: number },
  ): ProviderSession {
    const entry = this.readEntry(input.sessionId, { forceFresh: true });
    if (
      !entry ||
      entry.activeJobId !== undefined ||
      entry.continuationLease?.status === 'pending' ||
      hasUnterminalRetentionDiscardRequest(entry) ||
      entry.version !== input.expectedVersion
    ) {
      throw new SessionClaimError();
    }
    const nextEntry: ProviderSession = {
      ...entry,
      activeJobId: input.jobId,
      lastUsedAt: nowIsoString(this.time),
      version: this.bumpVersion(entry),
    };
    commit.append(sessionClaimedEvent(nextEntry, input.jobId));
    return nextEntry;
  }

  /** Append a stale-workflow replacement claim to the caller's launch transaction. */
  appendContinuationReplacementClaim<Scope>(
    commit: CommitContext<Scope>,
    input: {
      sessionId: string;
      staleJobId: string;
      resumedJobId: string;
      workflowId: string;
      workflowSlotId: string;
      replacementGeneration: number;
      expectedVersion: number;
    },
  ): ProviderSession {
    const entry = this.readEntry(input.sessionId, { forceFresh: true });
    const pending = entry?.continuationLease;
    if (
      !entry ||
      entry.activeJobId !== undefined ||
      entry.version !== input.expectedVersion ||
      pending?.status !== 'pending' ||
      pending.staleJobId !== input.staleJobId ||
      pending.workflowId !== input.workflowId ||
      pending.workflowSlotId !== input.workflowSlotId ||
      pending.replacementGeneration !== input.replacementGeneration ||
      !isProtectiveContinuationLease(pending, this.time.now())
    ) {
      throw new Error(`Continuation replacement claim is not available for session ${input.sessionId}.`);
    }
    const now = nowIsoString(this.time);
    const lease = claimLease(pending, { staleJobId: input.staleJobId, resumedJobId: input.resumedJobId }, now);
    if (lease === null) {
      throw new Error(`Continuation replacement lease could not be claimed for session ${input.sessionId}.`);
    }
    const nextEntry: ProviderSession = {
      ...entry,
      activeJobId: input.resumedJobId,
      continuationLease: lease,
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    commit.append(sessionContinuationLeaseClaimedEvent(nextEntry, lease));
    return nextEntry;
  }

  observeCommittedEntry(entry: ProviderSession): void {
    this.populateCache(entry.sessionId, entry);
  }

  /** Allocate a new sessionId and persist as 'pending'. Returns the new entry. */
  allocate(options: SessionAllocateOptions): ProviderSession;
  allocate(options: SessionAllocateOptions): ProviderSession {
    return this.open(options);
  }

  async claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number): Promise<boolean> {
    try {
      let claimed: ProviderSession | undefined;
      this.commitEvents((commit) => {
        const entry = this.readEntry(sessionId, { forceFresh: true });
        if (
          !entry ||
          entry.activeJobId !== undefined ||
          entry.continuationLease?.status === 'pending' ||
          hasUnterminalRetentionDiscardRequest(entry) ||
          (expectedVersion !== undefined && entry.version !== expectedVersion)
        ) {
          return undefined;
        }
        claimed = this.appendJobClaim(commit, {
          sessionId,
          jobId,
          expectedVersion: expectedVersion ?? entry.version,
        });
        return undefined;
      });
      if (claimed === undefined) return false;
      this.observeCommittedEntry(claimed);
      return true;
    } catch (error: unknown) {
      if (error instanceof SessionClaimError) return false;
      throw error;
    }
  }

  async finalizeJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      mutation: ProviderValidatedSessionContinuityMutation;
      appendBeforeRelease?: <Scope>(commit: CommitContext<Scope>) => void;
    },
  ): Promise<boolean> {
    const { expectedActiveJobId, expectedVersion, mutation, appendBeforeRelease } = options;
    let releaseEntry: ProviderSession | undefined;
    this.commitEvents((c) => {
      const currentEntry = this.readEntry(sessionId, { forceFresh: true });
      if (
        currentEntry === null ||
        currentEntry.activeJobId !== expectedActiveJobId ||
        currentEntry.version !== expectedVersion
      ) {
        return undefined;
      }
      const checkpointBaseEntry: ProviderSession = {
        ...currentEntry,
        lastUsedAt: nowIsoString(this.time),
        version: this.bumpVersion(currentEntry),
        ...(mutation.providerContinuity ? { providerContinuity: mutation.providerContinuity } : {}),
      };
      const checkpointEntry: ProviderSession = (() => {
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
      releaseEntry = {
        ...withoutActiveJobId(checkpointEntry),
        ...(clearedLease === null ? {} : { continuationLease: clearedLease }),
        version: this.bumpVersion(checkpointEntry),
      };
      appendBeforeRelease?.(c);
      c.append(sessionCheckpointedEvent(checkpointEntry, snapshotFromEntry(checkpointEntry)));
      c.append(sessionClaimReleasedEvent(releaseEntry, expectedActiveJobId));
      if (clearedLease !== null) {
        c.append(sessionContinuationLeaseClearedEvent(releaseEntry, clearedLease));
      }
      return undefined;
    });
    if (releaseEntry === undefined) return false;
    this.populateCache(sessionId, releaseEntry);
    this.releaseEmitter({ sessionId, jobId: expectedActiveJobId });
    return true;
  }

  async checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ProviderValidatedContinuitySnapshot;
    },
  ): Promise<{ ok: true; nextVersion: number } | { ok: false }> {
    const { expectedActiveJobId, expectedVersion, snapshot } = options;
    let nextEntry: ProviderSession | undefined;
    this.commitEvents((commit) => {
      const currentEntry = this.readEntry(sessionId, { forceFresh: true });
      if (
        currentEntry === null ||
        currentEntry.activeJobId !== expectedActiveJobId ||
        currentEntry.version !== expectedVersion
      ) {
        return undefined;
      }
      nextEntry = {
        ...withoutConversationRef(currentEntry),
        ...(snapshot.conversationRef === null ? {} : { conversationRef: snapshot.conversationRef }),
        providerContinuity: snapshot.providerContinuity,
        state: snapshot.resumable ? 'ready' : 'non_resumable',
        lastUsedAt: nowIsoString(this.time),
        version: this.bumpVersion(currentEntry),
      };
      commit.append(sessionCheckpointedEvent(nextEntry, snapshot));
      return undefined;
    });
    if (nextEntry === undefined) return { ok: false };
    this.populateCache(sessionId, nextEntry);
    return { ok: true, nextVersion: nextEntry.version };
  }

  async recordArtifactHandleAtomic(
    sessionId: string,
    options: SessionArtifactHandleRecordOptions,
  ): Promise<SessionArtifactHandleRecordResult> {
    const { expectedActiveJobId, expectedVersion, handle, sourceJobId } = options;
    let result: SessionArtifactHandleRecordResult = { ok: false };
    let nextEntry: ProviderSession | undefined;
    this.commitEvents((commit) => {
      const currentEntry = this.readEntry(sessionId, { forceFresh: true });
      if (
        currentEntry === null ||
        currentEntry.activeJobId !== expectedActiveJobId ||
        currentEntry.version !== expectedVersion
      ) {
        return undefined;
      }
      const provider = providerSessionProvider(currentEntry);
      const identity = options.identity;
      const identityKey = providerArtifactIdentityKey(provider, identity);
      if (
        currentEntry.artifactHandles.some(
          (artifact) => artifact.identityKey === identityKey && artifact.sourceJobId === sourceJobId,
        )
      ) {
        result = { ok: true, nextVersion: currentEntry.version };
        return undefined;
      }
      const artifact: ProviderArtifactHandle = {
        handle,
        identity,
        identityKey,
        sourceJobId,
        recordedAt: nowIsoString(this.time),
      };
      nextEntry = {
        ...currentEntry,
        artifactHandles: [...currentEntry.artifactHandles, artifact],
        lastUsedAt: nowIsoString(this.time),
        version: this.bumpVersion(currentEntry),
      };
      commit.append(sessionArtifactHandleRecordedEvent(nextEntry, artifact));
      result = { ok: true, nextVersion: nextEntry.version };
      return undefined;
    });
    if (nextEntry !== undefined) this.populateCache(sessionId, nextEntry);
    return result;
  }

  async releaseJobClaimAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
    },
  ): Promise<boolean> {
    const { expectedActiveJobId, expectedVersion } = options;
    let nextEntry: ProviderSession | undefined;
    this.commitEvents((c) => {
      const entry = this.readEntry(sessionId, { forceFresh: true });
      if (entry === null || entry.activeJobId !== expectedActiveJobId || entry.version !== expectedVersion) {
        return undefined;
      }
      const now = nowIsoString(this.time);
      const clearedLease =
        entry.continuationLease?.status === 'claimed' && entry.continuationLease.resumedJobId === expectedActiveJobId
          ? clearLease(
              entry.continuationLease,
              { sessionId, jobId: expectedActiveJobId, outcome: 'resumed_released' },
              now,
            )
          : null;
      nextEntry = {
        ...withoutActiveJobId(entry),
        ...(clearedLease === null ? {} : { continuationLease: clearedLease }),
        lastUsedAt: now,
        version: this.bumpVersion(entry),
      };
      c.append(sessionClaimReleasedEvent(nextEntry, expectedActiveJobId));
      if (clearedLease !== null) {
        c.append(sessionContinuationLeaseClearedEvent(nextEntry, clearedLease));
      }
      return undefined;
    });
    if (nextEntry === undefined) return false;
    this.populateCache(sessionId, nextEntry);
    this.releaseEmitter({ sessionId, jobId: expectedActiveJobId });
    return true;
  }

  /**
   * Claim the session synchronously (no lock). For test and startup-only paths
   * where concurrent access is not a concern.
   */
  claimForJobSync(sessionId: string, jobId: string): boolean {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId) return false;
    if (entry.continuationLease?.status === 'pending') return false;
    const now = nowIsoString(this.time);
    const nextEntry: ProviderSession = {
      ...entry,
      activeJobId: jobId,
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    this.appendEntryEvent(nextEntry, sessionClaimedEvent(nextEntry, jobId));
    return true;
  }

  releaseJob(sessionId: string, jobId: string): SessionJobClaimReleaseResult {
    const entry = this.readEntry(sessionId);
    if (!entry || entry.activeJobId === undefined) return 'already_absent';
    if (entry.activeJobId !== jobId) return 'owned_by_another_job';
    const now = nowIsoString(this.time);
    const clearedLease =
      entry.continuationLease?.status === 'claimed' && entry.continuationLease.resumedJobId === jobId
        ? clearLease(entry.continuationLease, { sessionId, jobId, outcome: 'resumed_released' }, now)
        : null;
    const releasedEntry: ProviderSession = {
      ...withoutActiveJobId(entry),
      lastUsedAt: now,
      version: this.bumpVersion(entry),
    };
    if (clearedLease === null) {
      this.appendEntryEvent(releasedEntry, sessionClaimReleasedEvent(releasedEntry, jobId));
    } else {
      const clearedEntry: ProviderSession = {
        ...releasedEntry,
        continuationLease: clearedLease,
        version: this.bumpVersion(releasedEntry),
      };
      this.commitEvents((c) => {
        c.append(sessionClaimReleasedEvent(releasedEntry, jobId));
        c.append(sessionContinuationLeaseClearedEvent(clearedEntry, clearedLease));
        return undefined;
      });
      this.populateCache(sessionId, clearedEntry);
    }
    this.releaseEmitter({ sessionId, jobId });
    return 'released';
  }

  /** Provider-scoped lookup. Returns null if sessionId not found or provider mismatch. */
  get(provider: string, sessionId: string): ProviderSession | null {
    const entry = this.readEntry(sessionId, { forceFresh: true });
    if (!entry || providerSessionProvider(entry) !== provider) return null;
    return entry;
  }

  list(provider: string): ProviderSession[] {
    const entries = listProjectionSessionEntries(this.db, provider, this.scopeKey);
    this.knownSessionIds.clear();
    for (const entry of entries) {
      this.populateCache(entry.sessionId, entry);
    }
    return entries.map(normalizeEntry);
  }
}
