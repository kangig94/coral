import { backendLog } from '../infra/backend-log.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { errorMessage } from '../infra/error-format.js';
import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderDefinition } from '../providers/define.js';
import type { AppendedEvent, CommitEventsFn, PostCommitObserver } from '../store/append.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { collectArtifactHandles } from './artifact-discard.js';
import { listProjectionSessionEntries, readProjectionSessionEntriesById } from './projections.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
  hasTerminalRetentionDiscardOutcome,
  readNextRetentionDiscardAttempt,
} from './retention-outbox.js';
import type { RetentionDiscardCompletedOutcome } from './entry.js';
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
  readonly providers: {
    get(name: string): ProviderDefinition | undefined;
  };
  readonly runtime: ArtifactCleanupRuntime;
  readonly commitEvents: CommitEventsFn;
  readonly log?: (message: string) => void;
};

function relevantSessionId(event: AppendedEvent): string | null {
  if (event.type !== 'job.terminal.recorded' && event.type !== 'session.claim.released') {
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

  constructor(private readonly options: LifecycleReactorOptions) {}

  readonly observe: PostCommitObserver = (appended) => {
    const sessionIds = new Set<string>();
    for (const event of appended) {
      const sessionId = relevantSessionId(event);
      if (sessionId !== null) {
        sessionIds.add(sessionId);
      }
    }

    this.enqueueWork(readSessionRetentionWorkForSessionIds(this.options.db(), [...sessionIds]));
    this.scheduleDrain();
  };

  async scanStartup(): Promise<void> {
    const db = this.options.db();
    this.enqueueWork(readSessionRetentionWorkForEntries(db, listProjectionSessionEntries(db)));
    this.scheduleDrain();
    await this.waitForIdle();
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
    const provider = this.options.providers.get(entry.provider);
    if (!provider) return;
    if (provider.artifacts.kind !== 'managed') {
      this.log(
        `On-demand artifact discard skipped for session ${sessionId}: provider '${entry.provider}' declares no artifacts.`,
      );
      return;
    }
    const handles = collectArtifactHandles(entry, provider, this.options.runtime);
    if (handles.length === 0) return;
    try {
      await provider.artifacts.discardArtifacts(handles, this.options.runtime);
    } catch (error: unknown) {
      this.log(`On-demand artifact discard failed for session ${sessionId}: ${errorMessage(error)}`);
    }
  }

  async enforceRetention(work: SessionRetentionWork): Promise<void> {
    const { entry, jobId, sessionId } = work;
    if (hasTerminalRetentionDiscardOutcome(this.options.db(), sessionId)) {
      return;
    }

    if (entry.retention !== 'discard_provider_artifacts_on_terminal') {
      return;
    }

    const provider = this.options.providers.get(entry.provider);
    if (provider === undefined) {
      this.log(`Retention discard skipped for session ${sessionId}: unknown provider '${entry.provider}'.`);
      return;
    }

    const recordedHandles = collectArtifactHandles(entry, provider, this.options.runtime, { jobId });
    const attemptFloor = this.attemptFloorBySession.get(sessionId) ?? 0;
    const attempt = readNextRetentionDiscardAttempt(this.options.db(), sessionId, attemptFloor);

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

    if (hasTerminalRetentionDiscardOutcome(this.options.db(), sessionId)) {
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
      const outcome = await provider.artifacts.discardArtifacts(recordedHandles, this.options.runtime);
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
      const workByPair = readSessionRetentionWorkForPairs(this.options.db(), pairs);

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
