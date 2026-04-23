import { isTerminalPhase } from '../phase.js';
import type { JobProgress, JobStatus } from '../records.js';
import type { WaitRequest, WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../wait.js';
import { createReplayCursor } from '../job-store.js';
import type { JobProgressStore } from '../progress-store-contract.js';
import { WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS, type LaunchCoordinator, type LaunchPool } from './contracts.js';
import type { JobEventBus } from '../event-bus.js';
import type { RuntimeTimePort } from '../../runtime/ports.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import type { JobProjectionDetail } from '../read-contracts.js';
import { resultPathFor } from './result-artifact.js';
import type { JobContinuitySnapshot } from '../continuity.js';

const ABORTED = 'wait-aborted' as const;
const JOURNAL_WAIT_POLL_MS = 100;
const POLL_JOURNAL = 'poll-journal' as const;

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
  progressStore: JobProgressStore;
  sessionManager: SessionManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: JobEventBus;
  jobPools: ReadonlyMap<string, LaunchPool>;
  time: RuntimeTimePort;
  loadJobProjectionDetail?: (jobId: string) => JobProjectionDetail;
  readJobProgress?: (jobId: string) => JobProgress[];
  subscribeJobEvents?: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobProgress>;
  getCurrentJournalSeq?: () => number;
}

export class WaitCoordinator {
  constructor(private readonly deps: WaitCoordinatorDeps) {}

  private readQueryStatus(jobId: string): JobStatus | null {
    return this.deps.loadJobProjectionDetail?.(jobId).status ?? this.deps.progressStore.readStatus(jobId);
  }

  private readQueryContinuity(jobId: string): JobContinuitySnapshot | null {
    return this.readQueryStatus(jobId)?.continuity ?? null;
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
          const owner = {
            provider: status.provider,
            sessionId: status.sessionId,
          };
          if (!this.isTerminalAndReleased(jobId, owner.provider, owner.sessionId, status)) {
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
    if (
      this.deps.loadJobProjectionDetail &&
      this.deps.readJobProgress &&
      this.deps.subscribeJobEvents &&
      this.deps.getCurrentJournalSeq
    ) {
      yield* this.waitForJobsFromJournal(req);
      return;
    }

    const { progressStore, launchCoordinator, jobPools } = this.deps;
    const { jobIds, timeoutSeconds = 600, cursor, abortSignal } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;
    const deadlineMs = startMs + timeoutMs;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((jobId) => [jobId, createReplayCursor()]));
    const emittedQueued = new Set<string>();
    const pending = new Set(jobIds);

    while (pending.size > 0) {
      if (abortSignal?.aborted) {
        return;
      }

      const seq = progressStore.getChangeSeq();

      for (const jobId of [...pending]) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- fileCursors initialized from same jobIds as pending
        const fileCursor = fileCursors.get(jobId)!;
        const fromEventId = fromEventIds[jobId] ?? 0;
        const status = progressStore.readStatus(jobId);
        if (!status) {
          continue;
        }

        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          const pool = jobPools.get(jobId) ?? 'default';
          yield {
            type: 'queued',
            jobId,
            sessionId: status.sessionId,
            queuePosition: launchCoordinator.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchCoordinator.getActiveJobIds(pool),
          };
        }

        let replaySawTerminal = false;

        const events = progressStore.replayFrom(jobId, fromEventId, fileCursor);
        for (const event of events) {
          fromEventIds[jobId] = event.eventId;

          if (event.type === 'progress') {
            yield {
              type: 'progress',
              jobId,
              eventId: event.eventId,
              message: event.message ?? '',
            };
            continue;
          }

          replaySawTerminal = true;
          const parsedTerminalMs = Date.parse(event.ts ?? '');
          const replayEligible = Number.isFinite(parsedTerminalMs)
            ? parsedTerminalMs <= deadlineMs
            : this.deps.time.now() <= deadlineMs;

          if (!replayEligible) {
            break;
          }

          const remainingJobIds = [...pending].filter((id) => id !== jobId);
          yield {
            type: 'terminal',
            jobId,
            remainingJobIds,
            resultPath: progressStore.resultPath(jobId),
            result: event.result ?? { content: '', outcome: { kind: 'completed' } },
            continuity: event.continuity ?? this.readQueryContinuity(jobId),
          };
          return;
        }

        if (replaySawTerminal) {
          continue;
        }

        // Emit a direct terminal snapshot only while this poll iteration is still inside the wait deadline.
        const currentStatus = isTerminalPhase(status.phase) ? status : progressStore.readStatus(jobId);
        if (currentStatus && isTerminalPhase(currentStatus.phase)) {
          const now = this.deps.time.now();
          if (now > deadlineMs) {
            continue;
          }
          const remainingJobIds = [...pending].filter((id) => id !== jobId);
          yield {
            type: 'terminal',
            jobId,
            remainingJobIds,
            resultPath: progressStore.resultPath(jobId),
            result: currentStatus.result ?? { content: '', outcome: { kind: 'completed' } },
            continuity: currentStatus.continuity ?? null,
          };
          return;
        }
      }

      const now = this.deps.time.now();
      if (now > deadlineMs) {
        yield { type: 'waiting', waitingJobIds: [...pending] };
        return;
      }

      const remainingMs = deadlineMs - now;
      const abortWaiter = createAbortWaiter(abortSignal);
      const next = await Promise.race([
        progressStore.waitForChange(seq),
        this.deps.time.sleep(remainingMs),
        ...(abortWaiter ? [abortWaiter.promise] : []),
      ]);
      abortWaiter?.dispose();
      if (next === ABORTED) {
        return;
      }
    }
  }

  private async *waitForJobsFromJournal(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const { launchCoordinator, jobPools, readJobProgress, subscribeJobEvents, getCurrentJournalSeq } = this.deps;
    if (!this.deps.loadJobProjectionDetail || !readJobProgress || !subscribeJobEvents || !getCurrentJournalSeq) {
      return;
    }

    const { jobIds, timeoutSeconds = 600, cursor, abortSignal } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;
    const deadlineMs = startMs + timeoutMs;
    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
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
      let observedSeq = catchUpMaxSeq;
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
            sessionId: status.sessionId,
            queuePosition: launchCoordinator.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchCoordinator.getActiveJobIds(pool),
          };
        }

        const history = readJobProgress(jobId).filter(
          (event) => event.seq <= catchUpMaxSeq && event.eventId > (fromEventIds[jobId] ?? 0),
        );
        for (const event of history) {
          fromEventIds[jobId] = event.eventId;
          if (event.type === 'progress') {
            yield {
              type: 'progress',
              jobId,
              eventId: event.eventId,
              message: event.message ?? '',
            };
            continue;
          }

          yield {
            type: 'terminal',
            jobId,
            remainingJobIds: [...pending].filter((id) => id !== jobId),
            resultPath: resultPathFor(jobId),
            result: event.result ?? { content: '', outcome: { kind: 'completed' } },
            continuity: event.continuity ?? this.readQueryContinuity(jobId),
          };
          return;
        }

        if (status && isTerminalPhase(status.phase)) {
          yield {
            type: 'terminal',
            jobId,
            remainingJobIds: [...pending].filter((id) => id !== jobId),
            resultPath: resultPathFor(jobId),
            result: status.result ?? { content: '', outcome: { kind: 'completed' } },
            continuity: status.continuity ?? null,
          };
          return;
        }
      }

      const readContinuity = (jobId: string) => this.readQueryContinuity(jobId);
      const catchUpFromJournal = function* (
        maxSeq: number,
      ): Generator<WaitStreamEvent, 'terminal' | 'progress' | 'empty'> {
        let emitted = false;
        for (const jobId of [...pending]) {
          const history = readJobProgress(jobId).filter(
            (event) =>
              event.seq > observedSeq &&
              event.seq <= maxSeq &&
              event.eventId > (fromEventIds[jobId] ?? 0),
          );

          for (const event of history) {
            emitted = true;
            fromEventIds[jobId] = event.eventId;
            if (event.type === 'progress') {
              yield {
                type: 'progress',
                jobId,
                eventId: event.eventId,
                message: event.message ?? '',
              };
              continue;
            }

            yield {
              type: 'terminal',
              jobId,
              remainingJobIds: [...pending].filter((id) => id !== jobId),
              resultPath: resultPathFor(jobId),
              result: event.result ?? { content: '', outcome: { kind: 'completed' } },
              continuity: event.continuity ?? readContinuity(jobId),
            };
            return 'terminal';
          }
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
            observedSeq = maxSeq;
          }
          continue;
        }

        if (next.done || !next.value) {
          continue;
        }

        const event = next.value;
        pendingNext = iterator.next();
        if (event.eventId <= (fromEventIds[event.jobId] ?? 0)) {
          continue;
        }
        fromEventIds[event.jobId] = event.eventId;

        if (event.type === 'progress') {
          yield {
            type: 'progress',
            jobId: event.jobId,
            eventId: event.eventId,
            message: event.message ?? '',
          };
          continue;
        }

        yield {
          type: 'terminal',
          jobId: event.jobId,
          remainingJobIds: [...pending].filter((id) => id !== event.jobId),
          resultPath: resultPathFor(event.jobId),
          result: event.result ?? { content: '', outcome: { kind: 'completed' } },
          continuity: event.continuity ?? this.readQueryContinuity(event.jobId),
        };
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
    const status = this.readQueryStatus(jobId) ?? this.deps.progressStore.readStatus(jobId);
    if (!status) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return status;
  }

  private isTerminalAndReleased(
    jobId: string,
    providerName: string,
    sessionId: string,
    status: JobStatus,
  ): boolean {
    if (!isTerminalPhase(status.phase)) {
      return false;
    }

    const session = this.deps.sessionManager.get(providerName, sessionId);
    return session?.activeJobId !== jobId;
  }
}
