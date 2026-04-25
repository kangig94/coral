import { isTerminalPhase } from '../phase.js';
import type { JobProgress, JobStatus } from '../records.js';
import type { WaitRequest, WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../wait.js';
import { WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS, type LaunchCoordinator, type LaunchPool } from './contracts.js';
import type { JobEventBus } from '../event-bus.js';
import type { RuntimeTimePort } from '../../runtime/ports.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import type { JobProjectionDetail } from '../read-contracts.js';
import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import { resultPathFor as defaultResultPathFor } from '../exports/result-artifact.js';
import type { JobContinuitySnapshot } from '../continuity.js';

const ABORTED = 'wait-aborted' as const;
const JOURNAL_WAIT_POLL_MS = 100;
const POLL_JOURNAL = 'poll-journal' as const;

function compareProgressSeq(left: JobProgress, right: JobProgress): number {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return left.jobId.localeCompare(right.jobId);
}

function toProgressWaitEvent(event: JobProgress): WaitStreamEvent {
  if (event.type !== 'progress') {
    throw new Error('Expected progress event.');
  }
  return {
    type: 'progress',
    jobId: event.jobId,
    seq: event.seq,
    message: event.message ?? '',
  };
}

function toTerminalWaitEvent(
  event: JobProgress,
  pending: ReadonlySet<string>,
  resultPath: string,
  continuity: JobContinuitySnapshot | null,
): WaitStreamEvent {
  if (event.type !== 'terminal') {
    throw new Error('Expected terminal event.');
  }
  return {
    type: 'terminal',
    jobId: event.jobId,
    seq: event.seq,
    remainingJobIds: [...pending].filter((id) => id !== event.jobId),
    resultPath,
    result: event.result ?? { content: '', outcome: { kind: 'completed' }, durationMs: 0 },
    continuity: event.continuity ?? continuity,
  };
}

function createAbortWaiter(signal: AbortSignal | undefined): { promise: Promise<typeof ABORTED>; dispose(): void } | null {
  if (!signal) {
    return null;
  }

  if (signal.aborted) {
    return {
      promise: Promise.resolve(ABORTED),
      dispose: () => {},
    };
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    signal.removeEventListener('abort', onAbort);
  };
  const onAbort = () => {
    dispose();
    resolveAbort(ABORTED);
  };
  let resolveAbort: (value: typeof ABORTED) => void = () => {};

  return {
    promise: new Promise<typeof ABORTED>((resolve) => {
      resolveAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    }),
    dispose,
  };
}

export interface WaitCoordinatorDeps {
  sessionManager: SessionManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: JobEventBus;
  jobPools: ReadonlyMap<string, LaunchPool>;
  time: RuntimeTimePort;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobProgress: (jobId: string) => JobProgress[];
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobProgress>;
  getCurrentJournalSeq: () => number;
  ensureResultArtifact?: (jobId: string) => string;
}

export class WaitCoordinator {
  constructor(private readonly deps: WaitCoordinatorDeps) {}

  private readQueryStatus(jobId: string): JobStatus | null {
    return this.deps.loadJobProjectionDetail(jobId).status;
  }

  private readQueryContinuity(jobId: string): JobContinuitySnapshot | null {
    return this.readQueryStatus(jobId)?.continuity ?? null;
  }

  private resultPathFor(jobId: string): string {
    if (!this.deps.ensureResultArtifact) {
      return defaultResultPathFor(jobId);
    }

    try {
      return this.deps.ensureResultArtifact(jobId);
    } catch (error: unknown) {
      backendLog.warn(`Rebuilding result artifact failed for ${jobId}: ${errorMessage(error)}`);
      return defaultResultPathFor(jobId);
    }
  }

  async waitForJobTerminal(jobId: string, timeoutMs = WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS): Promise<void> {
    const timeoutError = new Error(
      `Timed out waiting for job ${jobId} to reach a terminal state and release its session`,
    );

    const startedAt = this.deps.time.now();
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const remainingMs = timeoutMs - (this.deps.time.now() - startedAt);
      if (remainingMs <= 0) {
        reject(timeoutError);
        return;
      }

      const timer = this.deps.time.setTimeout(() => {
        finish(() => reject(timeoutError));
      }, remainingMs);

      const cleanup = (): void => {
        this.deps.eventBus.off('job:completed', onJobCompleted);
        this.deps.eventBus.off('job:phase_changed', onJobPhaseChanged);
        this.deps.eventBus.off('job:progress', onJobProgress);
        this.deps.eventBus.off('session:released', onSessionReleased);
        this.deps.time.clearTimeout(timer);
      };

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const recheck = (): void => {
        try {
          const status = this.readStatusOrThrow(jobId);
          if (!this.isTerminalAndReleased(jobId, status.provider, status.sessionId, status)) {
            if (!isTerminalPhase(status.phase)) {
              return;
            }
            return;
          }
          finish(resolve);
        } catch (error: unknown) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };

      const onJobCompleted = ({ jobId: completedId }: { jobId: string }): void => {
        if (completedId === jobId) {
          recheck();
        }
      };

      const onJobPhaseChanged = ({ jobId: changedJobId }: { jobId: string }): void => {
        if (changedJobId === jobId) {
          recheck();
        }
      };

      const onJobProgress = ({ jobId: progressedJobId }: { jobId: string }): void => {
        if (progressedJobId === jobId) {
          recheck();
        }
      };

      const onSessionReleased = ({ jobId: releasedJobId }: { jobId: string }): void => {
        if (releasedJobId === jobId) {
          recheck();
        }
      };

      this.deps.eventBus.on('job:completed', onJobCompleted);
      this.deps.eventBus.on('job:phase_changed', onJobPhaseChanged);
      this.deps.eventBus.on('job:progress', onJobProgress);
      this.deps.eventBus.on('session:released', onSessionReleased);

      recheck();
      if (settled) {
        return;
      }
    });
  }

  async *waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.waitForJobsFromJournal(req);
  }

  private async *waitForJobsFromJournal(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const { launchCoordinator, jobPools, readJobProgress, subscribeJobEvents, getCurrentJournalSeq } = this.deps;
    const { jobIds, timeoutSeconds = 600, cursor, abortSignal } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;
    const deadlineMs = startMs + timeoutMs;
    const afterSeq = cursor?.afterSeq ?? 0;
    const pending = new Set(jobIds);
    const emittedQueued = new Set<string>();
    const currentMaxSeq = getCurrentJournalSeq();

    const controller = new AbortController();
    const onExternalAbort = () => {
      controller.abort();
    };
    if (abortSignal?.aborted) {
      controller.abort();
    } else {
      abortSignal?.addEventListener('abort', onExternalAbort, { once: true });
    }
    const iterator = subscribeJobEvents({
      afterSeq: currentMaxSeq,
      jobIds,
      abortSignal: controller.signal,
    })[Symbol.asyncIterator]();
    // Prime the live tail before reading the catch-up snapshot so terminal events
    // cannot land in the gap between the snapshot and subscriber registration.
    let pendingNext: Promise<IteratorResult<JobProgress>> | null = iterator.next();

    try {
      const catchUpMaxSeq = getCurrentJournalSeq();
      let observedSeq = afterSeq;
      for (const jobId of [...pending]) {
        const status = this.readQueryStatus(jobId);
        if (!status) {
          continue;
        }

        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          const pool = jobPools.get(jobId) ?? 'default';
          yield {
            type: 'queued',
            jobId,
            sessionId: status.sessionId ?? '',
            queuePosition: launchCoordinator.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchCoordinator.getActiveJobIds(pool),
          };
        }
      }

      const initialHistory = [...pending]
        .flatMap((jobId) =>
          readJobProgress(jobId).filter((event) => event.seq > observedSeq && event.seq <= catchUpMaxSeq),
        )
        .sort(compareProgressSeq);
      for (const event of initialHistory) {
        observedSeq = Math.max(observedSeq, event.seq);
        if (event.type === 'progress') {
          yield toProgressWaitEvent(event);
          continue;
        }

        yield toTerminalWaitEvent(event, pending, this.resultPathFor(event.jobId), this.readQueryContinuity(event.jobId));
        return;
      }
      observedSeq = Math.max(observedSeq, catchUpMaxSeq);

      const readContinuity = (jobId: string) => this.readQueryContinuity(jobId);
      const resultPathForJob = (jobId: string) => this.resultPathFor(jobId);
      const catchUpFromJournal = function* (
        maxSeq: number,
      ): Generator<WaitStreamEvent, 'terminal' | 'progress' | 'empty'> {
        let emitted = false;
        const history = [...pending]
          .flatMap((jobId) => readJobProgress(jobId).filter((event) => event.seq > observedSeq && event.seq <= maxSeq))
          .sort(compareProgressSeq);

        for (const event of history) {
          emitted = true;
          observedSeq = Math.max(observedSeq, event.seq);
          if (event.type === 'progress') {
            yield toProgressWaitEvent(event);
            continue;
          }

          yield toTerminalWaitEvent(event, pending, resultPathForJob(event.jobId), readContinuity(event.jobId));
          return 'terminal';
        }
        return emitted ? 'progress' : 'empty';
      };

      while (pending.size > 0) {
        const now = this.deps.time.now();
        if (now > deadlineMs) {
          yield { type: 'waiting', waitingJobIds: [...pending] };
          return;
        }

        const remainingMs = deadlineMs - now;
        const abortWaiter = createAbortWaiter(abortSignal);
        const pollMs = Math.min(remainingMs, JOURNAL_WAIT_POLL_MS);
        const next = await Promise.race([
          pendingNext,
          this.deps.time.sleep(pollMs).then(() => POLL_JOURNAL),
          ...(abortWaiter ? [abortWaiter.promise] : []),
        ]);
        abortWaiter?.dispose();

        if (next === ABORTED) {
          return;
        }

        if (next === POLL_JOURNAL) {
          const maxSeq = getCurrentJournalSeq();
          if (maxSeq > observedSeq) {
            const replay = catchUpFromJournal(maxSeq);
            for (const event of replay) {
              yield event;
              if (event.type === 'terminal') {
                return;
              }
            }
            observedSeq = Math.max(observedSeq, maxSeq);
          }
          continue;
        }

        if (next.done || !next.value) {
          continue;
        }

        const event = next.value;
        pendingNext = iterator.next();
        if (event.seq <= observedSeq) {
          continue;
        }
        observedSeq = event.seq;

        if (event.type === 'progress') {
          yield toProgressWaitEvent(event);
          continue;
        }

        yield toTerminalWaitEvent(event, pending, this.resultPathFor(event.jobId), this.readQueryContinuity(event.jobId));
        return;
      }
    } finally {
      abortSignal?.removeEventListener('abort', onExternalAbort);
      controller.abort();
      await pendingNext?.catch(() => undefined);
      await iterator.return?.();
    }
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    const request: WaitRequest = { jobIds: [jobId] };
    if (timeoutMs !== undefined) {
      request.timeoutSeconds = timeoutMs / 1000;
    }

    for await (const event of this.waitForJobs(request)) {
      if (event.type === 'terminal' && event.jobId === jobId) {
        return {
          content: event.result.content,
          continuity: this.readQueryContinuity(jobId) ?? event.continuity ?? null,
        };
      }
      if (event.type === 'waiting') {
        throw new Error('Wait expired while job still running');
      }
    }

    throw new Error(`Job ${jobId} ended without a terminal result`);
  }

  private readStatusOrThrow(jobId: string): JobStatus {
    const status = this.readQueryStatus(jobId);
    if (!status) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return status;
  }

  private isTerminalAndReleased(
    jobId: string,
    providerName: string | null,
    sessionId: string | null,
    status: JobStatus,
  ): boolean {
    if (!isTerminalPhase(status.phase)) {
      return false;
    }
    if (providerName === null || sessionId === null) {
      return true;
    }

    const session = this.deps.sessionManager.get(providerName, sessionId);
    return session?.activeJobId !== jobId;
  }
}
