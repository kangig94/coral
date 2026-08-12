import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { CarrierLiveness } from '../carrier-observation.js';
import {
  isWorkflowJobKind,
  type JobEvent,
  type JobProgressEvent,
  type JobStatus,
  type JobTerminal,
  type JobTerminalEvent,
} from '../records.js';
import {
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  type CarrierInterruptedWaitEvent,
  type WaitRequest,
  type WaitStreamEvent,
  type WaitStreamOnceResult,
  type WaitStreamRequest,
} from '../wait.js';
import type { JobQueueReadPort, LaunchPool } from '../contracts/admission.js';
import type { JobEventBus } from '../event-bus.js';
import { queuedProgressTiming } from '../progress-timing.js';
import type { TimePort } from '../../infra/port-types.js';
import type { SessionJobReadPort } from '../../sessions/contracts.js';
import type { JobProjectionDetail } from '../read-queries.js';
import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import { resultPathFor as defaultResultPathFor } from '../terminal/export.js';
import type { UsageSummary } from '../../providers/contract.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import {
  providerHostUnserviceableMessage,
  PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING,
} from '../../providers/host-admission.js';

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
    timing: event.timing,
  };
}

function toTerminalWaitEvent(
  event: JobTerminalEvent,
  pending: ReadonlySet<string>,
  resultPath: string,
  continuity: ContinuitySnapshot | null,
  usage: UsageSummary | undefined = event.usage,
  result: JobTerminal = event.result,
): WaitStreamEvent {
  const remainingJobIds: string[] = [];
  for (const id of pending) {
    if (id !== event.jobId) {
      remainingJobIds.push(id);
    }
  }

  return {
    type: 'terminal',
    jobId: event.jobId,
    seq: event.seq,
    remainingJobIds,
    resultPath,
    result,
    continuity,
    ...(usage === undefined ? {} : { usage }),
  };
}

function surfaceProviderHostRecovery(event: JobTerminalEvent, detail: JobProjectionDetail): JobTerminal {
  const outcome = event.result.outcome;
  const runtime = detail.runtime;
  if (
    outcome.kind !== 'provider_exit' ||
    runtime?.transport !== 'app-server' ||
    runtime.providerMeta.leaseState !== 'acquired' ||
    !detail.exit?.diagnostics.warnings?.includes(PROVIDER_HOST_UNSERVICEABLE_TERMINAL_WARNING)
  ) {
    return event.result;
  }

  const recovery = providerHostUnserviceableMessage(runtime.providerMeta.hostRef);
  return {
    ...event.result,
    outcome: {
      ...outcome,
      note: `${outcome.note}\n\n${recovery}`,
    },
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
  aggregateWorkflowUsage: (workflowJobId: string) => UsageSummary | undefined;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
  resultJobsRoot: string;
  ensureResultArtifact?: (jobId: string) => string;
  /**
   * Reports what is carrying each still-pending job. Optional because a wait works without it — the journal
   * is what ends a job either way — and a build that cannot answer must keep waiting silently rather than
   * report absences it did not observe.
   */
  observeCarriers?: (jobIds: readonly string[]) => Promise<CarrierWaitObservation[]>;
}

/** One job's carrier verdict, as the wait stream needs it: which job, and what was found. */
export type CarrierWaitObservation = Readonly<{
  jobId: string;
  liveness: CarrierLiveness;
  storedPhase: JobPhase;
  observedMaxJournalSeq: number;
}>;

export type CarrierWaitPlan = Readonly<{
  interrupted: readonly CarrierInterruptedWaitEvent[];
  unknownJobIds: readonly string[];
}>;

const EMPTY_CARRIER_PLAN: CarrierWaitPlan = Object.freeze({ interrupted: [], unknownJobIds: [] });

/**
 * Turns carrier verdicts into what the wait stream should say about them.
 *
 * Pure so the rule is checkable without a journal: absence becomes one event per job per stream — it
 * reports a discovery, not a snapshot, so repeating it every poll tick would restate the same thing while
 * the job is still pending — and `unknown` is collected for the waiting snapshot instead, because a job
 * nothing could answer for is not a job that ended. Neither outcome removes anything from `pending`; only
 * the journal ends a job.
 */
export function planCarrierWaitEvents(
  observations: readonly CarrierWaitObservation[],
  pending: ReadonlySet<string>,
  alreadyReported: Set<string>,
): CarrierWaitPlan {
  const interrupted: CarrierInterruptedWaitEvent[] = [];
  const unknownJobIds: string[] = [];
  for (const observation of observations) {
    if (!pending.has(observation.jobId)) continue;
    if (observation.liveness === 'unknown') {
      unknownJobIds.push(observation.jobId);
      continue;
    }
    if (observation.liveness !== 'absent' || alreadyReported.has(observation.jobId)) continue;
    alreadyReported.add(observation.jobId);
    interrupted.push({
      type: 'interrupted',
      jobId: observation.jobId,
      storedPhase: observation.storedPhase,
      observedMaxJournalSeq: observation.observedMaxJournalSeq,
      remainingJobIds: [...pending],
      observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
      continuity: 'unavailable',
      outcome: 'unknown',
    });
  }
  return { interrupted, unknownJobIds: unknownJobIds.sort() };
}

export class WaitCoordinator {
  private readonly deps: WaitCoordinatorDeps;
  constructor(deps: WaitCoordinatorDeps) {
    this.deps = deps;
  }

  private readQueryStatus(jobId: string): JobStatus | null {
    return this.deps.loadJobProjectionDetail(jobId).status;
  }

  private readQueryContinuity(jobId: string): ContinuitySnapshot | null {
    const status = this.readQueryStatus(jobId);
    if (status?.provider === null || status?.provider === undefined || status.sessionId === null) {
      return null;
    }
    const session = this.deps.sessionManager.get(status.provider, status.sessionId);
    if (session === null) {
      return null;
    }
    if (session.state === 'pending' && session.conversationRef === undefined && session.providerContinuity === null) {
      return null;
    }
    return {
      conversationRef: session.conversationRef ?? null,
      resumable: session.state === 'ready',
      providerContinuity: session.providerContinuity,
    };
  }

  private readTerminalUsage(event: JobTerminalEvent): UsageSummary | undefined {
    const status = this.readQueryStatus(event.jobId);
    if (isWorkflowJobKind(status?.jobKind)) {
      return this.deps.aggregateWorkflowUsage(event.jobId);
    }
    return event.usage;
  }

  /**
   * Asks what is carrying the still-pending jobs, and turns the answer into stream events.
   *
   * Absence is reported once per job per stream: it is an event about a discovery, not a snapshot, so
   * repeating it every poll tick would say the same thing over and over while the job is still pending —
   * and it *stays* pending, because nothing here removes it from `pending` or ends the stream. Unknowns are
   * returned rather than emitted, since they belong on the waiting snapshot as a list of jobs nothing could
   * answer for.
   *
   * A failure to observe yields nothing at all. The wait is still correct without it — the journal is what
   * ends a job — and a build that could not ask must not report absences it never saw.
   */
  private async observePendingCarriers(
    pending: ReadonlySet<string>,
    alreadyReported: Set<string>,
  ): Promise<CarrierWaitPlan> {
    const observe = this.deps.observeCarriers;
    if (observe === undefined || pending.size === 0) return EMPTY_CARRIER_PLAN;

    try {
      return planCarrierWaitEvents(await observe([...pending]), pending, alreadyReported);
    } catch (error: unknown) {
      backendLog.warn(`wait: carrier observation failed: ${errorMessage(error)}`);
      return EMPTY_CARRIER_PLAN;
    }
  }

  /**
   * The waiting snapshot, with unconfirmed carriers named only when there are any. Omitted rather than
   * empty so a reader can tell "nothing unknown" from a build that does not report unknowns at all.
   */
  private waitingSnapshot(pending: ReadonlySet<string>, carrierUnknownJobIds: readonly string[]): WaitStreamEvent {
    return carrierUnknownJobIds.length === 0
      ? { type: 'waiting', waitingJobIds: [...pending] }
      : { type: 'waiting', waitingJobIds: [...pending], carrierUnknownJobIds: [...carrierUnknownJobIds] };
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

    const detail = this.deps.loadJobProjectionDetail(event.jobId);
    return toTerminalWaitEvent(
      event,
      pending,
      this.resultPathFor(event.jobId),
      this.readQueryContinuity(event.jobId),
      this.readTerminalUsage(event),
      surfaceProviderHostRecovery(event, detail),
    );
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
          const queued = {
            type: 'queued',
            jobId,
            queuePosition: launchQueue.queuePosition(jobId, pool) ?? 0,
            runningJobIds: launchQueue.getActiveJobIds(pool),
            timing: queuedProgressTiming(status, this.deps.time.now()),
          } as const;
          if (status.jobKind === 'provider') {
            if (status.sessionId === null) {
              throw new Error(`Queued provider job '${jobId}' has no provider session.`);
            }
            yield { ...queued, jobKind: 'provider', sessionId: status.sessionId };
          } else if (status.jobKind === 'workflow') {
            yield { ...queued, jobKind: 'workflow', workflowId: status.owner.id };
          } else {
            yield { ...queued, jobKind: 'kb', systemTaskId: status.owner.id };
          }
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

      // Once after catch-up: the journal has had its say about every pending job, so anything still
      // pending here is a job whose carrier is worth asking about.
      const carrierReported = new Set<string>();
      let carrierUnknownJobIds: readonly string[] = [];
      {
        const observed = await this.observePendingCarriers(pending, carrierReported);
        carrierUnknownJobIds = observed.unknownJobIds;
        for (const event of observed.interrupted) yield event;
      }

      timeoutWaiter = createTimeoutWaiter(this.deps.time, Math.max(0, deadlineMs - this.deps.time.now()));

      while (pending.size > 0) {
        const now = this.deps.time.now();
        if (now > deadlineMs) {
          yield this.waitingSnapshot(pending, carrierUnknownJobIds);
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
          // After the replay, never before it: a terminal that arrived in this same tick has already
          // returned above, so an observation can never contradict a journal result that exists.
          const observed = await this.observePendingCarriers(pending, carrierReported);
          carrierUnknownJobIds = observed.unknownJobIds;
          for (const event of observed.interrupted) yield event;
          continue;
        }

        if (next === TIMED_OUT) {
          yield this.waitingSnapshot(pending, carrierUnknownJobIds);
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

        yield this.toWaitEvent(event, pending);
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
          continuity: this.readQueryContinuity(jobId),
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
