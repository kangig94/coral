import { backendLog } from '../infra/backend-log.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { errorMessage } from '../infra/error-format.js';
import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderDefinition } from '../providers/define.js';
import type { AppendedEvent, CommitEventsFn, PostCommitObserver } from '../store/append.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { listProjectionSessionEntries, readProjectionSessionEntry } from './projections.js';
import {
  appendRetentionDiscardCompleted,
  appendRetentionDiscardFailed,
  appendRetentionDiscardRequested,
  hasTerminalRetentionDiscardOutcome,
  readNextRetentionDiscardAttempt,
} from './retention-outbox.js';
import type { RetentionDiscardCompletedOutcome } from './entry.js';

export type LifecycleReactorOptions = {
  readonly db: () => ReadonlyDatabase;
  readonly providers: {
    get(name: string): ProviderDefinition | undefined;
  };
  readonly runtime: ArtifactCleanupRuntime;
  readonly commitEvents: CommitEventsFn;
  readonly log?: (message: string) => void;
};

function pairKey(sessionId: string, jobId: string): string {
  // '\0' cannot appear in UUIDs, safe composite-key separator
  return `${sessionId}\u0000${jobId}`;
}

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

    for (const sessionId of sessionIds) {
      this.evaluateSession(sessionId);
    }
    this.scheduleDrain();
  };

  async scanStartup(): Promise<void> {
    for (const entry of listProjectionSessionEntries(this.options.db())) {
      if (entry.retention !== 'discard_provider_artifacts_on_terminal') {
        continue;
      }
      this.evaluateSession(entry.sessionId);
    }
    this.scheduleDrain();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.drainPromise !== null) {
      await this.drainPromise;
    }
  }

  async enforceRetention(sessionId: string, jobId: string): Promise<void> {
    if (hasTerminalRetentionDiscardOutcome(this.options.db(), sessionId)) {
      return;
    }

    const entry = readProjectionSessionEntry(this.options.db(), sessionId);
    if (entry === null || entry.retention !== 'discard_provider_artifacts_on_terminal') {
      return;
    }

    const provider = this.options.providers.get(entry.provider);
    if (provider === undefined) {
      this.log(`Retention discard skipped for session ${sessionId}: unknown provider '${entry.provider}'.`);
      return;
    }

    const recordedHandles: string[] = [];
    for (const artifact of entry.artifactHandles) {
      if (artifact.sourceJobId === undefined || artifact.sourceJobId === jobId) {
        recordedHandles.push(artifact.handle);
      }
    }
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

  private evaluateSession(sessionId: string): void {
    const entry = readProjectionSessionEntry(this.options.db(), sessionId);
    if (entry === null || entry.retention !== 'discard_provider_artifacts_on_terminal') {
      return;
    }

    if (hasTerminalRetentionDiscardOutcome(this.options.db(), sessionId)) {
      return;
    }

    for (const jobId of this.readTerminalReleasePairs(sessionId)) {
      this.enqueue(sessionId, jobId);
    }
  }

  private readTerminalReleasePairs(sessionId: string): string[] {
    const rows = this.options
      .db()
      .prepare<[string, string], { job_id: string }>(
        `SELECT DISTINCT t.stream_id AS job_id
           FROM events AS t
           JOIN events AS r
             ON r.type = 'session.claim.released'
            AND r.stream_kind = 'session'
            AND COALESCE(json_extract(r.refs, '$.sessionId'), r.stream_id) = ?
            AND COALESCE(json_extract(r.refs, '$.jobId'), json_extract(CAST(r.body AS TEXT), '$.jobId')) = t.stream_id
          WHERE t.type = 'job.terminal.recorded'
            AND t.stream_kind = 'job'
            AND json_extract(t.refs, '$.sessionId') = ?
          ORDER BY t.stream_id ASC`,
      )
      .all(sessionId, sessionId);

    return rows.map((row) => row.job_id);
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
    const key = pairKey(sessionId, jobId);
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

  private takePendingPair(): { sessionId: string; jobId: string } | null {
    for (const [sessionId, jobIds] of this.pendingBySession) {
      const next = jobIds.values().next();
      if (next.done === true) {
        this.pendingBySession.delete(sessionId);
        continue;
      }
      const jobId = next.value;
      jobIds.delete(jobId);
      if (jobIds.size === 0) {
        this.pendingBySession.delete(sessionId);
      }
      return { sessionId, jobId };
    }
    return null;
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const pair = this.takePendingPair();
      if (pair === null) {
        return;
      }

      const key = pairKey(pair.sessionId, pair.jobId);
      if (this.inFlightPairs.has(key)) {
        continue;
      }

      this.inFlightPairs.add(key);
      try {
        await this.enforceRetention(pair.sessionId, pair.jobId);
      } catch (error: unknown) {
        this.log(
          `Retention discard enforcement failed for session ${pair.sessionId} job ${pair.jobId}: ${errorMessage(error)}`,
        );
      } finally {
        this.inFlightPairs.delete(key);
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
