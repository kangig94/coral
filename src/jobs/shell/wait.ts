import { isTerminalPhase } from '../phase.js';
import type { JobStatusRecord } from '../records.js';
import type { WaitRequest, WaitStreamEvent, WaitStreamRequest } from '../wait.js';
import type { TypedEventBus } from '../../coordinator/control.js';
import type { LaunchCoordinator, LaunchPool } from '../../coordinator/live/admission.js';
import { createReplayCursor, type ProgressStore } from '../../execution/progress-store.js';
import {
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
} from '../../execution/job-lifecycle-contracts.js';
import type { RuntimeTimePort } from '../../runtime/ports.js';
import type { SessionManager } from '../../execution/session-manager.js';
import type { JobProjectionDetail, JobProgressRow } from '../../store/queries/jobs.js';
import type { JobEvent } from './event-subscription.js';
import { resultPathFor } from './result-artifact.js';

const JOB_TERMINAL_RELEASE_POLL_MS = 10;

export interface WaitCoordinatorDeps {
  progressStore: ProgressStore;
  sessionManager: SessionManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: TypedEventBus;
  jobPools: ReadonlyMap<string, LaunchPool>;
  time: RuntimeTimePort;
  loadJobProjectionDetail?: (jobId: string) => JobProjectionDetail;
  readJobProgress?: (jobId: string) => JobProgressRow[];
  subscribeJobEvents?: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq?: () => number;
}

export class WaitCoordinator {
  constructor(private readonly deps: WaitCoordinatorDeps) {}

  async waitForJobTerminal(jobId: string, timeoutMs = WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS): Promise<void> {
    const initialStatus = this.readStatusOrThrow(jobId);
    const owner = {
      provider: initialStatus.provider,
      sessionId: initialStatus.sessionId,
    };
    const timeoutError = new Error(
      `Timed out waiting for job ${jobId} to reach a terminal state and release its session`,
    );

    if (this.isTerminalAndReleased(jobId, owner.provider, owner.sessionId, initialStatus)) {
      return;
    }

    const startedAt = this.deps.time.now();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let releasePollTimer: ReturnType<RuntimeTimePort['setTimeout']> | undefined;

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
        this.deps.time.clearTimeout(releasePollTimer ?? null);
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
          if (!isTerminalPhase(status.phase)) {
            return;
          }
          if (!this.isTerminalAndReleased(jobId, owner.provider, owner.sessionId, status)) {
            scheduleReleasePoll();
            return;
          }
          finish(resolve);
        } catch (error: unknown) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };

      const scheduleReleasePoll = (): void => {
        if (settled || releasePollTimer) {
          return;
        }
        releasePollTimer = this.deps.time.setTimeout(() => {
          releasePollTimer = undefined;
          recheck();
        }, JOB_TERMINAL_RELEASE_POLL_MS);
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

      this.deps.eventBus.on('job:completed', onJobCompleted);
      this.deps.eventBus.on('job:phase_changed', onJobPhaseChanged);
      this.deps.eventBus.on('job:progress', onJobProgress);

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
    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;
    const deadlineMs = startMs + timeoutMs;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((jobId) => [jobId, createReplayCursor()]));
    const emittedQueued = new Set<string>();
    const pending = new Set(jobIds);

    while (pending.size > 0) {
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
      await Promise.race([
        progressStore.waitForChange(seq),
        this.deps.time.sleep(remainingMs),
      ]);
    }
  }

  private async *waitForJobsFromJournal(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const { launchCoordinator, jobPools, loadJobProjectionDetail, readJobProgress, subscribeJobEvents, getCurrentJournalSeq } = this.deps;
    if (!loadJobProjectionDetail || !readJobProgress || !subscribeJobEvents || !getCurrentJournalSeq) {
      return;
    }

    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = this.deps.time.now();
    const timeoutMs = timeoutSeconds * 1000;
    const deadlineMs = startMs + timeoutMs;
    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const pending = new Set(jobIds);
    const emittedQueued = new Set<string>();
    const currentMaxSeq = getCurrentJournalSeq();

    for (const jobId of [...pending]) {
      const detail = loadJobProjectionDetail(jobId);
      const status = detail.status;
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
        (event) => event.seq <= currentMaxSeq && event.eventId > (fromEventIds[jobId] ?? 0),
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
        };
        return;
      }
    }

    const controller = new AbortController();
    const iterator = subscribeJobEvents({
      afterSeq: currentMaxSeq,
      jobIds,
      abortSignal: controller.signal,
    })[Symbol.asyncIterator]();

    try {
      while (pending.size > 0) {
        const now = this.deps.time.now();
        if (now > deadlineMs) {
          yield { type: 'waiting', waitingJobIds: [...pending] };
          return;
        }

        const remainingMs = deadlineMs - now;
        const next = await Promise.race([
          iterator.next(),
          this.deps.time.sleep(remainingMs).then(() => ({ done: true, value: null as JobEvent | null })),
        ]);

        if (next.done || !next.value) {
          yield { type: 'waiting', waitingJobIds: [...pending] };
          return;
        }

        const event = next.value;
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
        };
        return;
      }
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    const request: WaitRequest = { jobIds: [jobId] };
    if (timeoutMs !== undefined) {
      request.timeoutSeconds = timeoutMs / 1000;
    }

    for await (const event of this.waitForJobs(request)) {
      if (event.type === 'terminal' && event.jobId === jobId) {
        return {
          content: event.result.content,
          nonResumable: event.result.nonResumable ?? false,
        };
      }
      if (event.type === 'waiting') {
        throw new Error('Wait expired while job still running');
      }
    }

    throw new Error(`Job ${jobId} ended without a terminal result`);
  }

  private readStatusOrThrow(jobId: string): JobStatusRecord {
    const status = this.deps.progressStore.readStatus(jobId);
    if (!status) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return status;
  }

  private isTerminalAndReleased(
    jobId: string,
    providerName: string,
    sessionId: string,
    status: JobStatusRecord,
  ): boolean {
    if (!isTerminalPhase(status.phase)) {
      return false;
    }

    const session = this.deps.sessionManager.get(providerName, sessionId);
    return session?.activeJobId !== jobId;
  }
}
