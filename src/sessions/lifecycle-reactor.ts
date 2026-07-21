import { backendLog } from '../infra/backend-log.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { errorMessage } from '../infra/error-format.js';
import type { TimePort, TimerHandle } from '../infra/port-types.js';
import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderBindingCatalog } from '../providers/catalog.js';
import type { ProviderDefinition } from '../providers/registry.js';
import type { ProviderCredentialSourceRef } from '../infra/provider-credential-sources.js';
import type { AppendedEvent, CommitEventsFn, PostCommitObserver } from '../store/append.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import type { StoreReadContext } from '../store/body-codec.js';
import { collectArtifactHandles } from './artifact-discard.js';
import { sessionContinuationLeaseExpiredEvent } from './continuation-lease-events.js';
import { archiveProviderArtifactsForJob } from './provider-artifact-archive.js';
import { listProjectionSessionEntries, readProjectionSessionEntriesById } from './projections.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
  hasTerminalRetentionDiscardOutcome,
  readNextRetentionDiscardAttempt,
} from './retention-outbox.js';
import {
  hasUnterminalRetentionDiscardRequest,
  isProtectiveContinuationLease,
  type ExpiredContinuationLease,
  type PendingContinuationLease,
  type RetentionDiscardCompletedOutcome,
  type SessionEntry,
} from './entry.js';
import {
  readSessionRetentionWorkForEntries,
  readSessionRetentionWorkForPairs,
  readSessionRetentionWorkForSessionIds,
  sessionRetentionWorkKey,
  type SessionRetentionPair,
  type SessionRetentionWork,
} from './retention-work.js';

export type LifecycleReactorOptions = {
  readonly db: () => ReadonlyDatabase;
  readonly readCtx: StoreReadContext;
  readonly providers: ProviderBindingCatalog;
  readonly runtime: ArtifactCleanupRuntime;
  readonly time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  readonly commitEvents: CommitEventsFn;
  readonly log?: (message: string) => void;
};

function relevantSessionId(event: AppendedEvent): string | null {
  if (
    event.type !== 'job.terminal.recorded' &&
    event.type !== 'session.claim.released' &&
    event.type !== 'session.continuation_lease.claimed' &&
    event.type !== 'session.continuation_lease.cleared' &&
    event.type !== 'session.continuation_lease.expired' &&
    !isRetentionSkippedOrCancelled(event)
  ) {
    return null;
  }

  if (typeof event.refs?.sessionId === 'string' && event.refs.sessionId.length > 0) {
    return event.refs.sessionId;
  }

  if (event.stream.kind === 'session') {
    return event.stream.id;
  }

  return null;
}

function isContinuationLeaseEvent(event: AppendedEvent): boolean {
  return (
    event.type === 'session.continuation_lease.recorded' ||
    event.type === 'session.continuation_lease.claimed' ||
    event.type === 'session.continuation_lease.cleared' ||
    event.type === 'session.continuation_lease.expired'
  );
}

function isRetentionSkippedOrCancelled(event: AppendedEvent): boolean {
  if (event.type !== 'session.retention.discard.completed') {
    return false;
  }
  return (event.body as { outcome?: unknown }).outcome === 'skipped_protected';
}

export class LifecycleReactor {
  private readonly pendingBySession = new Map<string, Set<string>>();
  private readonly inFlightPairs = new Set<string>();
  /**
   * Failed requested/terminal appends can consume an in-memory attempt number
   * without persisting it. In the typical case this is one row per attempt and
   * bounded by per-session terminal-eligibility coalescing plus live suppression
   * once a terminal outcome exists; a pathological append flake can grow
   * linearly for the affected session during the daemon lifetime.
   */
  private readonly attemptFloorBySession = new Map<string, number>();
  private drainPromise: Promise<void> | null = null;
  private continuationLeaseTimer: TimerHandle | null = null;

  private readonly options: LifecycleReactorOptions;
  constructor(options: LifecycleReactorOptions) {
    this.options = options;
  }

  private async readyArtifactSource(
    entry: SessionEntry,
    operation: string,
  ): Promise<{ provider: ProviderDefinition; source: ProviderCredentialSourceRef } | null> {
    if (entry.sessionAuthority.kind !== 'provider') return null;
    const provider = this.options.providers.get(entry.provider);
    if (provider === undefined) {
      this.log(`${operation} skipped for session ${entry.sessionId}: unknown provider '${entry.provider}'.`);
      return null;
    }
    const binding = this.options.providers.rehydrateBinding(entry.sessionAuthority.binding);
    if (!binding.ok || binding.value.provider !== entry.provider) {
      this.log(`${operation} skipped for session ${entry.sessionId}: invalid provider binding.`);
      return null;
    }
    const readiness = await binding.value.readiness('recovery', this.options.runtime.storage);
    if (!readiness.ok) {
      this.log(
        `${operation} skipped for session ${entry.sessionId}: ${this.options.providers.renderBindingFailure(readiness.failure)}`,
      );
      return null;
    }
    return { provider, source: binding.value.credentialSource() };
  }

  readonly observe: PostCommitObserver = (appended) => {
    const sessionIds = new Set<string>();
    let sawContinuationLeaseEvent = false;
    for (const event of appended) {
      if (isContinuationLeaseEvent(event)) {
        sawContinuationLeaseEvent = true;
      }
      const sessionId = relevantSessionId(event);
      if (sessionId !== null) {
        sessionIds.add(sessionId);
      }
    }

    if (sawContinuationLeaseEvent) {
      this.rescheduleContinuationLeaseTimer();
    }
    this.enqueueWork(
      readSessionRetentionWorkForSessionIds(this.options.db(), this.options.readCtx, [...sessionIds], {
        nowMs: this.options.time.now(),
      }),
    );
    this.scheduleDrain();
  };

  async scanStartup(): Promise<void> {
    const db = this.options.db();
    const expiredSessionIds = this.expireOverdueContinuationLeases();
    this.rescheduleContinuationLeaseTimer();
    this.enqueueWork(
      readSessionRetentionWorkForSessionIds(db, this.options.readCtx, expiredSessionIds, {
        nowMs: this.options.time.now(),
      }),
    );
    this.enqueueWork(
      readSessionRetentionWorkForEntries(db, this.options.readCtx, listProjectionSessionEntries(db), {
        nowMs: this.options.time.now(),
      }),
    );
    this.scheduleDrain();
    await this.waitForIdle();
  }

  dispose(): void {
    this.clearContinuationLeaseTimer();
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise !== null) {
      await this.drainPromise;
    }
  }

  /**
   * Discard a completed session's provider native artifacts on demand, bypassing
   * the retention policy gate — used when an owning lifecycle concludes (e.g. a
   * discussion is fully synthesized) for sessions that were retained across turns.
   * Best-effort and event-free; the reactor remains the single site permitted to
   * invoke `discardArtifacts` (see `tests/invariants/cleanup-discipline.test.ts`).
   */
  async discardSessionArtifacts(sessionId: string): Promise<void> {
    const entry = readProjectionSessionEntriesById(this.options.db(), [sessionId]).get(sessionId);
    if (!entry) return;
    const ready = await this.readyArtifactSource(entry, 'On-demand artifact discard');
    if (ready === null) return;
    const { provider, source } = ready;
    if (provider.artifacts.kind !== 'managed') {
      this.log(
        `On-demand artifact discard skipped for session ${sessionId}: provider '${entry.provider}' declares no artifacts.`,
      );
      return;
    }
    const handles = collectArtifactHandles(entry, provider, source, this.options.runtime);
    if (handles.length === 0) return;
    await this.archiveArtifactsBeforeDiscard(entry, handles);
    try {
      await provider.artifacts.discardArtifacts({
        handles,
        source,
        runtime: this.options.runtime,
      });
    } catch (error: unknown) {
      this.log(`On-demand artifact discard failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }

  async enforceRetention(work: SessionRetentionWork): Promise<void> {
    const { jobId, sessionId } = work;
    if (hasTerminalRetentionDiscardOutcome(this.options.db(), this.options.readCtx, sessionId)) {
      return;
    }

    const entry = this.readRetentionEntryForRequest(sessionId);
    if (entry === null) {
      return;
    }

    if (entry.retention !== 'discard_provider_artifacts_on_terminal') {
      return;
    }
    // Orchestration sessions own no provider-native artifact. Their child
    // provider sessions enforce their own retention independently.
    if (entry.sessionAuthority.kind !== 'provider') {
      return;
    }

    const ready = await this.readyArtifactSource(entry, 'Retention discard');
    if (ready === null) return;
    const { provider, source } = ready;
    const recordedHandles = collectArtifactHandles(entry, provider, source, this.options.runtime, { jobId });
    const attemptFloor = this.attemptFloorBySession.get(sessionId) ?? 0;
    const attempt = readNextRetentionDiscardAttempt(this.options.db(), this.options.readCtx, sessionId, attemptFloor);

    try {
      const requested = appendRetentionDiscardRequested(this.options.commitEvents, {
        sessionId,
        attempt,
        handles: recordedHandles,
      });
      if (requested.kind === 'duplicate') {
        this.raiseAttemptFloor(sessionId, attempt, attemptFloor);
        return;
      }
    } catch (error: unknown) {
      this.raiseAttemptFloor(sessionId, attempt, attemptFloor);
      this.log(
        `Retention discard request append failed for session ${sessionId} attempt ${attempt}: ${errorMessage(error)}`,
      );
      return;
    }

    if (hasTerminalRetentionDiscardOutcome(this.options.db(), this.options.readCtx, sessionId)) {
      return;
    }

    const preDeleteEntry = this.readFreshSessionEntry(sessionId);
    if (
      preDeleteEntry === null ||
      preDeleteEntry.sessionAuthority.kind !== 'provider' ||
      this.hasRetentionProtection(preDeleteEntry)
    ) {
      this.appendCompleted(sessionId, attempt, recordedHandles, 'skipped_protected');
      return;
    }

    if (provider.artifacts.kind === 'none') {
      this.appendCompleted(sessionId, attempt, recordedHandles, 'provider_declares_none');
      return;
    }

    if (recordedHandles.length === 0) {
      this.appendCompleted(sessionId, attempt, recordedHandles, 'skipped_no_handles');
      return;
    }

    try {
      await this.archiveArtifactsBeforeDiscard(preDeleteEntry, recordedHandles, jobId);
      const outcome = await provider.artifacts.discardArtifacts({
        handles: recordedHandles,
        source,
        runtime: this.options.runtime,
      });
      this.appendCompleted(sessionId, attempt, recordedHandles, outcome.kind);
    } catch (error: unknown) {
      this.appendFailed(
        sessionId,
        attempt,
        recordedHandles,
        errorMessage(error),
        this.readTerminalCauseRef(sessionId, jobId),
      );
    }
  }

  private async archiveArtifactsBeforeDiscard(
    entry: SessionEntry,
    handles: readonly string[],
    jobId?: string,
  ): Promise<void> {
    const byJobId = new Map<string, string[]>();
    if (jobId !== undefined) {
      byJobId.set(jobId, [...handles]);
    } else {
      const artifactByHandle = new Map(entry.artifactHandles.map((artifact) => [artifact.handle, artifact]));
      for (const handle of handles) {
        const sourceJobId = artifactByHandle.get(handle)?.sourceJobId;
        if (sourceJobId === undefined) {
          continue;
        }
        const group = byJobId.get(sourceJobId) ?? [];
        group.push(handle);
        byJobId.set(sourceJobId, group);
      }
    }

    for (const [artifactJobId, artifactHandles] of byJobId) {
      try {
        await archiveProviderArtifactsForJob({
          runtime: this.options.runtime,
          entry,
          provider: entry.provider,
          jobId: artifactJobId,
          handles: artifactHandles,
          archivedAt: new Date(this.options.time.now()).toISOString(),
        });
      } catch (error: unknown) {
        this.log(
          `Provider artifact archive failed for session ${entry.sessionId} job ${artifactJobId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private readFreshSessionEntry(sessionId: string): SessionEntry | null {
    return readProjectionSessionEntriesById(this.options.db(), [sessionId]).get(sessionId) ?? null;
  }

  private readRetentionEntryForRequest(sessionId: string): SessionEntry | null {
    const entry = this.readFreshSessionEntry(sessionId);
    if (entry === null) {
      return null;
    }
    if (
      entry.activeJobId !== undefined ||
      isProtectiveContinuationLease(entry.continuationLease, this.options.time.now()) ||
      hasUnterminalRetentionDiscardRequest(entry)
    ) {
      return null;
    }
    return entry;
  }

  private hasRetentionProtection(entry: SessionEntry): boolean {
    return (
      entry.activeJobId !== undefined || isProtectiveContinuationLease(entry.continuationLease, this.options.time.now())
    );
  }

  private readTerminalCauseRef(sessionId: string, jobId: string): CauseRef | undefined {
    const row = this.options
      .db()
      .prepare<[string, string], { seq: number }>(
        `SELECT seq
           FROM events
          WHERE type = 'job.terminal.recorded'
            AND stream_kind = 'job'
            AND stream_id = ?
            AND json_extract(refs, '$.sessionId') = ?
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get(jobId, sessionId);
    if (row === undefined) {
      return undefined;
    }
    return {
      stream: { kind: 'job', id: jobId },
      seq: row.seq,
    };
  }

  private enqueue(sessionId: string, jobId: string): void {
    const key = sessionRetentionWorkKey(sessionId, jobId);
    if (this.inFlightPairs.has(key)) {
      return;
    }

    const pending = this.pendingBySession.get(sessionId) ?? new Set<string>();
    pending.add(jobId);
    this.pendingBySession.set(sessionId, pending);
  }

  private scheduleDrain(): void {
    if (this.drainPromise !== null || !this.hasPendingWork()) {
      return;
    }

    const promise = this.drainQueue()
      .catch((error: unknown) => {
        this.log(`Retention lifecycle reactor failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (this.drainPromise === promise) {
          this.drainPromise = null;
        }
        if (this.hasPendingWork()) {
          this.scheduleDrain();
        }
      });
    this.drainPromise = promise;
  }

  private hasPendingWork(): boolean {
    for (const jobIds of this.pendingBySession.values()) {
      if (jobIds.size > 0) {
        return true;
      }
    }
    return false;
  }

  private enqueueWork(work: readonly SessionRetentionWork[]): void {
    for (const item of work) {
      this.enqueue(item.sessionId, item.jobId);
    }
  }

  private takePendingPairs(): SessionRetentionPair[] {
    const pairs: SessionRetentionPair[] = [];
    for (const [sessionId, jobIds] of this.pendingBySession) {
      if (jobIds.size === 0) {
        this.pendingBySession.delete(sessionId);
        continue;
      }
      for (const jobId of jobIds) {
        pairs.push({ sessionId, jobId });
      }
      this.pendingBySession.delete(sessionId);
    }
    return pairs;
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const pairs = this.takePendingPairs();
      if (pairs.length === 0) {
        return;
      }
      const workByPair = readSessionRetentionWorkForPairs(this.options.db(), this.options.readCtx, pairs, {
        nowMs: this.options.time.now(),
      });

      for (const pair of pairs) {
        const key = sessionRetentionWorkKey(pair.sessionId, pair.jobId);
        if (this.inFlightPairs.has(key)) {
          continue;
        }

        const work = workByPair.get(key);
        if (work === undefined) {
          continue;
        }

        this.inFlightPairs.add(key);
        try {
          await this.enforceRetention(work);
        } catch (error: unknown) {
          this.log(
            `Retention discard enforcement failed for session ${pair.sessionId} job ${pair.jobId}: ${errorMessage(error)}`,
          );
        } finally {
          this.inFlightPairs.delete(key);
        }
      }
    }
  }

  private pendingContinuationLeaseEntries(): Array<SessionEntry & { continuationLease: PendingContinuationLease }> {
    return listProjectionSessionEntries(this.options.db()).filter(
      (entry): entry is SessionEntry & { continuationLease: PendingContinuationLease } =>
        entry.continuationLease?.status === 'pending',
    );
  }

  private expireOverdueContinuationLeases(): string[] {
    const nowMs = this.options.time.now();
    const expiredSessionIds: string[] = [];
    for (const entry of this.pendingContinuationLeaseEntries()) {
      if (Date.parse(entry.continuationLease.expiresAt) > nowMs) {
        continue;
      }
      if (this.appendContinuationLeaseExpired(entry, nowMs)) {
        expiredSessionIds.push(entry.sessionId);
      }
    }
    return expiredSessionIds;
  }

  private appendContinuationLeaseExpired(
    entry: SessionEntry & { continuationLease: PendingContinuationLease },
    nowMs: number,
  ): boolean {
    const expiredAt = new Date(nowMs).toISOString();
    const lease: ExpiredContinuationLease = {
      staleJobId: entry.continuationLease.staleJobId,
      reason: entry.continuationLease.reason,
      expiresAt: entry.continuationLease.expiresAt,
      recordedAt: entry.continuationLease.recordedAt,
      status: 'expired',
      expiredAt,
    };
    const nextEntry: SessionEntry = {
      ...entry,
      continuationLease: lease,
      lastUsedAt: expiredAt,
      version: entry.version + 1,
    };

    try {
      this.options.commitEvents((c) => {
        c.append(sessionContinuationLeaseExpiredEvent(nextEntry, lease));
        return undefined;
      });
      return true;
    } catch (error: unknown) {
      this.log(`Continuation lease expiry append failed for session ${entry.sessionId}: ${errorMessage(error)}`);
      return false;
    }
  }

  private clearContinuationLeaseTimer(): void {
    if (this.continuationLeaseTimer === null) {
      return;
    }
    this.options.time.clearTimeout(this.continuationLeaseTimer);
    this.continuationLeaseTimer = null;
  }

  private rescheduleContinuationLeaseTimer(): void {
    this.clearContinuationLeaseTimer();

    const nowMs = this.options.time.now();
    let earliestExpiresAt: number | null = null;
    for (const entry of this.pendingContinuationLeaseEntries()) {
      const expiresAt = Date.parse(entry.continuationLease.expiresAt);
      if (expiresAt <= nowMs) {
        earliestExpiresAt = nowMs;
        break;
      }
      if (earliestExpiresAt === null || expiresAt < earliestExpiresAt) {
        earliestExpiresAt = expiresAt;
      }
    }

    if (earliestExpiresAt === null) {
      return;
    }

    this.continuationLeaseTimer = this.options.time.setTimeout(
      () => {
        this.continuationLeaseTimer = null;
        const expiredSessionIds = this.expireOverdueContinuationLeases();
        this.rescheduleContinuationLeaseTimer();
        if (expiredSessionIds.length > 0) {
          this.enqueueWork(
            readSessionRetentionWorkForSessionIds(this.options.db(), this.options.readCtx, expiredSessionIds, {
              nowMs: this.options.time.now(),
            }),
          );
          this.scheduleDrain();
        }
      },
      Math.max(0, earliestExpiresAt - nowMs),
    );
    this.continuationLeaseTimer.unref?.();
  }

  private appendCompleted(
    sessionId: string,
    attempt: number,
    handles: readonly string[],
    outcome: RetentionDiscardCompletedOutcome,
  ): void {
    try {
      appendRetentionDiscardCompleted(this.options.commitEvents, {
        sessionId,
        attempt,
        handles,
        outcome,
      });
    } catch (error: unknown) {
      this.raiseAttemptFloor(sessionId, attempt);
      this.log(
        `Retention discard completion append failed for session ${sessionId} attempt ${attempt}: ${errorMessage(error)}`,
      );
    }
  }

  private appendFailed(
    sessionId: string,
    attempt: number,
    handles: readonly string[],
    reason: string,
    causeRef: CauseRef | undefined,
  ): void {
    try {
      appendRetentionDiscardFailed(this.options.commitEvents, {
        sessionId,
        attempt,
        handles,
        reason,
        ...(causeRef === undefined ? {} : { causeRef }),
      });
    } catch (error: unknown) {
      this.raiseAttemptFloor(sessionId, attempt);
      this.log(
        `Retention discard failure append failed for session ${sessionId} attempt ${attempt}: ${errorMessage(error)}`,
      );
    }
  }

  private raiseAttemptFloor(
    sessionId: string,
    attempt: number,
    floor = this.attemptFloorBySession.get(sessionId) ?? 0,
  ): void {
    this.attemptFloorBySession.set(sessionId, Math.max(floor, attempt));
  }

  private log(message: string): void {
    if (this.options.log) {
      this.options.log(message);
      return;
    }
    backendLog.warn(message);
  }
}

export function createLifecycleReactor(options: LifecycleReactorOptions): LifecycleReactor {
  return new LifecycleReactor(options);
}
