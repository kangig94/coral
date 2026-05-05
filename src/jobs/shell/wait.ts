import { isTerminalPhase } from '../phase.js';
import type { JobEvent, JobProgressEvent, JobStatus, JobTerminalEvent } from '../records.js';
import {
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  type WaitRequest,
  type WaitStreamEvent,
  type WaitStreamOnceResult,
  type WaitStreamRequest,
} from '../wait.js';
import type { JobQueueReadPort, LaunchPool } from '../contracts/admission.js';
import type { JobEventBus } from '../event-bus.js';
import type { TimePort } from '../../infra/port-types.js';
import type { SessionJobReadPort } from '../../sessions/contracts.js';
import type { JobProjectionDetail } from '../read-queries.js';
import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import { resultPathFor as defaultResultPathFor } from '../terminal/export.js';
import type { JobContinuitySnapshot } from '../continuity.js';

const ABORTED = 'wait-aborted' as const;
const TIMED_OUT = 'wait-timed-out' as const;
const JOURNAL_POLL = 'wait-journal-poll' as const;
const JOURNAL_POLL_INTERVAL_MS = 250;

function compareProgressSeq(left: JobEvent, right: JobEvent): number {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return left.jobId.localeCompare(right.jobId);
}

function toProgressWaitEvent(event: JobProgressEvent): WaitStreamEvent {
  return {
    type: 'progress',
    jobId: event.jobId,
    seq: event.seq,
    message: event.message,
  };
}

function toTerminalWaitEvent(
  event: JobTerminalEvent,
  pending: ReadonlySet<string>,
  resultPath: string,
  continuity: JobContinuitySnapshot | null,
): WaitStreamEvent {
  return {
    type: 'terminal',
    jobId: event.jobId,
    seq: event.seq,
    remainingJobIds: [...pending].filter((id) => id !== event.jobId),
    resultPath,
    result: event.result,
    continuity: event.continuity ?? continuity,
  };
}

function createAbortWaiter(
  signal: AbortSignal | undefined,
): { promise: Promise<typeof ABORTED>; dispose(): void } | null {
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

function createTimeoutWaiter(
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
  timeoutMs: number,
): { promise: Promise<typeof TIMED_OUT>; dispose(): void } {
  let settled = false;
  let timeoutHandle: ReturnType<TimePort['setTimeout']> | null = null;
  const promise = new Promise<typeof TIMED_OUT>((resolve) => {
    timeoutHandle = time.setTimeout(
      () => {
        settled = true;
        timeoutHandle = null;
        resolve(TIMED_OUT);
      },
      Math.max(0, timeoutMs),
    );
  });

  return {
    promise,
    dispose() {
      if (settled || timeoutHandle === null) {
        return;
      }
      time.clearTimeout(timeoutHandle);
      timeoutHandle = null;
      settled = true;
    },
  };
}

function createJournalPollWaiter(
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
  timeoutMs: number,
): { promise: Promise<typeof JOURNAL_POLL>; dispose(): void } {
  let settled = false;
  let timeoutHandle: ReturnType<TimePort['setTimeout']> | null = null;
  const promise = new Promise<typeof JOURNAL_POLL>((resolve) => {
    timeoutHandle = time.setTimeout(
      () => {
        settled = true;
        timeoutHandle = null;
        resolve(JOURNAL_POLL);
      },
      Math.max(0, timeoutMs),
    );
  });

  return {
    promise,
    dispose() {
      if (settled || timeoutHandle === null) {
        return;
      }
      time.clearTimeout(timeoutHandle);
      timeoutHandle = null;
      settled = true;
    },
  };
}

export interface WaitCoordinatorDeps {
  sessionManager: SessionJobReadPort;
  launchQueue: JobQueueReadPort;
  eventBus: JobEventBus;
  jobPools: ReadonlyMap<string, LaunchPool>;
  time: TimePort;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobEvents: (jobId: string) => JobEvent[];
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
  resultJobsRoot: string;
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
      return defaultResultPathFor(this.deps.resultJobsRoot, jobId);
    }

    try {
      return this.deps.ensureResultArtifact(jobId);
    } catch (error: unknown) {
      backendLog.warn(`Rebuilding result artifact failed for ${jobId}: ${errorMessage(error)}`);
      return defaultResultPathFor(this.deps.resultJobsRoot, jobId);
    }
  }

  private readPendingHistory(pending: ReadonlySet<string>, observedSeq: number, maxSeq: number): JobEvent[] {
    const { readJobEvents } = this.deps;
    const events: JobEvent[] = [];

    for (const jobId of pending) {
      for (const event of readJobEvents(jobId)) {
        if (event.seq > observedSeq && event.seq <= maxSeq) {
          events.push(event);
        }
      }
    }

    return events.sort(compareProgressSeq);
  }

  private toWaitEvent(event: JobEvent, pending: ReadonlySet<string>): WaitStreamEvent {
    if (event.type === 'progress') {
      return toProgressWaitEvent(event);
    }

    return toTerminalWaitEvent(event, pending, this.resultPathFor(event.jobId), this.readQueryContinuity(event.jobId));
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
    const { launchQueue, jobPools, subscribeJobEvents, getCurrentJournalSeq } = this.deps;
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
    let pendingNext: Promise<IteratorResult<JobEvent>> | null = iterator.next();
    let timeoutWaiter: ReturnType<typeof createTimeoutWaiter> | null = null;

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
            queuePosition: launchQueue.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchQueue.getActiveJobIds(pool),
          };
        }
      }

      const initialHistory = this.readPendingHistory(pending, observedSeq, catchUpMaxSeq);
      for (const event of initialHistory) {
        observedSeq = Math.max(observedSeq, event.seq);
        const waitEvent = this.toWaitEvent(event, pending);
        yield waitEvent;
        if (waitEvent.type === 'progress') {
          continue;
        }
        return;
      }
      observedSeq = Math.max(observedSeq, catchUpMaxSeq);

      timeoutWaiter = createTimeoutWaiter(this.deps.time, Math.max(0, deadlineMs - this.deps.time.now()));

      while (pending.size > 0) {
        const now = this.deps.time.now();
        if (now > deadlineMs) {
          yield { type: 'waiting', waitingJobIds: [...pending] };
          return;
        }

        const abortWaiter = createAbortWaiter(abortSignal);
        const pollWaiter = createJournalPollWaiter(
          this.deps.time,
          Math.min(JOURNAL_POLL_INTERVAL_MS, Math.max(0, deadlineMs - now)),
        );
        const next = await Promise.race([
          pendingNext,
          timeoutWaiter.promise,
          pollWaiter.promise,
          ...(abortWaiter ? [abortWaiter.promise] : []),
        ]);
        abortWaiter?.dispose();
        pollWaiter.dispose();

        if (next === ABORTED) {
          return;
        }

        if (next === JOURNAL_POLL) {
          const maxSeq = getCurrentJournalSeq();
          const replayed = this.readPendingHistory(pending, observedSeq, maxSeq);
          for (const event of replayed) {
            observedSeq = Math.max(observedSeq, event.seq);
            const waitEvent = this.toWaitEvent(event, pending);
            yield waitEvent;
            if (waitEvent.type === 'terminal') {
              return;
            }
          }
          observedSeq = Math.max(observedSeq, maxSeq);
          continue;
        }

        if (next === TIMED_OUT) {
          yield { type: 'waiting', waitingJobIds: [...pending] };
          return;
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

        yield toTerminalWaitEvent(
          event,
          pending,
          this.resultPathFor(event.jobId),
          this.readQueryContinuity(event.jobId),
        );
        return;
      }
    } finally {
      timeoutWaiter?.dispose();
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
