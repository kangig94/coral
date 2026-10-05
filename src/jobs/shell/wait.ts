import { sourceReadFailureDisposition } from '../source-read.js';
import { sameEpoch } from '../../store/epoch/identity.js';
import { waitReadPosition } from '../wait/cursor.js';
import { readWaitSession } from '../wait/reader.js';
import type { WaitAdmission } from '../wait/session.js';
import { isTerminalPhase, type JobPhase } from '../phase.js';
import type { CarrierLiveness } from '../carrier-observation.js';
import {
  isWorkflowJobKind,
  type JobEvent,
  type JobStatus,
  type JobTerminal,
  type JobTerminalEvent,
} from '../records.js';
import {
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  type CarrierInterruptedWaitEvent,
  type WaitStreamEvent,
  type WaitStreamOnceResult,
  type WaitStreamRequest,
} from '../wait/contract.js';
import type { JobQueueReadPort } from '../contracts/admission.js';
import type { JobEventBus } from '../event-bus.js';
import { queuedProgressTiming } from '../progress-timing.js';
import type { TimePort } from '../../infra/port-types.js';
import type { SessionJobReadPort } from '../../sessions/contracts.js';
import type { JobProjectionDetail } from '../read-queries.js';
import { errorMessage } from '../../infra/error-format.js';
import { backendLog } from '../../infra/backend-log.js';
import type { ResultAvailability } from '../terminal/export.js';
import type { HostRef, UsageSummary } from '../../providers/contract.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import {
  exactHostRefsMatch,
  providerHostUnserviceableMessage,
  readProviderHostUnserviceableTerminalWarning,
} from '../../providers/host-admission.js';

function surfaceProviderHostRecovery(event: JobTerminalEvent, detail: JobProjectionDetail): JobTerminal {
  const outcome = event.result.outcome;
  const runtime = detail.runtime;
  const warnings = detail.exit?.diagnostics.warnings ?? [];
  if (
    outcome.kind !== 'provider_exit' ||
    runtime?.transport !== 'app-server' ||
    runtime.providerMeta.leaseState !== 'acquired'
  ) {
    return event.result;
  }

  const acquiredHostRef = runtime.providerMeta.hostRef;
  const classifiedHostRef = warnings
    .map(readProviderHostUnserviceableTerminalWarning)
    .find((hostRef): hostRef is HostRef => hostRef !== null && exactHostRefsMatch(hostRef, acquiredHostRef));
  if (classifiedHostRef === undefined) return event.result;

  const recovery = providerHostUnserviceableMessage(classifiedHostRef);
  return {
    ...event.result,
    outcome: {
      ...outcome,
      note: `${outcome.note}\n\n${recovery}`,
    },
  };
}

export interface WaitCoordinatorDeps {
  sessionManager: SessionJobReadPort;
  launchQueue: JobQueueReadPort;
  eventBus: JobEventBus;
  time: TimePort;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  readJobEvents: (jobId: string, afterSeq?: number, window?: { tail?: number; limit?: number }) => JobEvent[];
  aggregateWorkflowUsage: (workflowJobId: string) => UsageSummary | undefined;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
  currentJobEpochKey?: () => string | null;
  internalWaitAdmissions?: (jobIds: readonly string[], session: WaitStreamRequest) => WaitAdmission[];
  observeJobAbsence?: (jobId: string) => boolean;
  resultJobsRoot: string;
  observeResultAvailability: (jobId: string, session?: object) => ResultAvailability;
  hintResultRepair?: (jobId: string) => void;
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
  const unknownJobIds: string[] = [...pending].filter(
    (jobId) => !observations.some((observation) => observation.jobId === jobId),
  );
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

type WaitEventFrontier = {
  epochKey: string;
  frontier: number;
  events: JobEvent[];
  terminal?: JobTerminalEvent;
  admission?: WaitAdmission;
};

export class WaitCoordinator {
  private readonly deps: WaitCoordinatorDeps;
  constructor(deps: WaitCoordinatorDeps) {
    this.deps = deps;
  }

  private readQueryStatus(jobId: string): JobStatus | null {
    return this.deps.loadJobProjectionDetail(jobId).status;
  }

  private readQueryContinuity(jobId: string, status = this.readQueryStatus(jobId)): ContinuitySnapshot | null {
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

  private readTerminalUsage(
    event: JobTerminalEvent,
    status = this.readQueryStatus(event.jobId),
  ): UsageSummary | undefined {
    if (isWorkflowJobKind(status?.jobKind)) {
      return this.deps.aggregateWorkflowUsage(event.jobId);
    }
    return event.usage;
  }

  private async observePendingCarriers(
    pending: ReadonlySet<string>,
    alreadyReported: Set<string>,
  ): Promise<CarrierWaitPlan> {
    const observe = this.deps.observeCarriers;
    if (pending.size === 0) return EMPTY_CARRIER_PLAN;
    if (observe === undefined) return { interrupted: [], unknownJobIds: [...pending].sort() };

    try {
      return planCarrierWaitEvents(await observe([...pending]), pending, alreadyReported);
    } catch (error: unknown) {
      backendLog.warn(`wait: carrier observation failed: ${errorMessage(error)}`);
      return { interrupted: [], unknownJobIds: [...pending].sort() };
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

  private queuedWaitEvent(status: JobStatus): Extract<WaitStreamEvent, { type: 'queued' }> {
    const jobId = status.jobId;
    const reservation = this.deps.launchQueue.reservationFor(jobId);
    const queued = {
      type: 'queued' as const,
      jobId,
      queuePosition: reservation?.kind === 'queued' ? reservation.position : 0,
      runningJobIds: reservation === null ? [] : this.deps.launchQueue.getActiveJobIds(reservation.pool),
      timing: queuedProgressTiming(status, this.deps.time.now()),
    };
    if (status.jobKind === 'provider') {
      if (status.sessionId === null) throw new Error(`Queued provider job '${jobId}' has no provider session.`);
      return { ...queued, jobKind: 'provider', sessionId: status.sessionId };
    }
    if (status.jobKind === 'workflow') return { ...queued, jobKind: 'workflow', workflowId: status.owner.id };
    return { ...queued, jobKind: 'kb', systemTaskId: status.owner.id };
  }

  readWaitAdmissions(jobIds: readonly string[], epochKey: string, session?: object): WaitAdmission[] {
    const frontier = this.deps.getCurrentJournalSeq();
    return jobIds.map((jobId) => {
      try {
        return this.readWaitAdmission(jobId, epochKey, session, frontier);
      } catch (error) {
        const sourceRead = sourceReadFailureDisposition(error);
        return {
          jobId,
          sourceRead,
          disposition: sourceRead === 'settled-unreadable' ? 'discovery-unreadable' : 'discovery-unknown',
          message: 'Job location cannot be observed; location recovery re-reads it at the next coordinator start',
        };
      }
    });
  }

  async observeWaitCarriers(jobIds: readonly string[], signal: AbortSignal) {
    const observed = await this.observePendingCarriers(new Set(jobIds), new Set());
    return { ...observed, frontier: signal.aborted ? 0 : this.deps.getCurrentJournalSeq() };
  }

  private readonly eventFrontiers = new WeakMap<object, Map<string, WaitEventFrontier>>();

  readWaitAdmission(
    jobId: string,
    epochKey: string,
    session?: object,
    frontier = this.deps.getCurrentJournalSeq(),
  ): WaitAdmission {
    const frontiers = (session ? this.eventFrontiers.get(session) : undefined) ?? new Map<string, WaitEventFrontier>();
    if (session) this.eventFrontiers.set(session, frontiers);
    let cached = frontiers.get(jobId);
    if (cached && sameEpoch(cached.epochKey, epochKey) && cached.frontier === frontier && cached.admission) {
      const admission = cached.admission;
      if (!admission.detail?.exit) return admission;
      const availability = this.deps.observeResultAvailability(jobId, session);
      if (availability.kind === 'repair-pending') this.deps.hintResultRepair?.(jobId);
      return { ...admission, availability };
    }
    const projected = this.deps.loadJobProjectionDetail(jobId);
    if (!projected.status) {
      const observed = this.deps.readJobEvents(jobId);
      return observed.length === 0 && cached === undefined && this.deps.observeJobAbsence?.(jobId) === true
        ? { jobId, disposition: 'missing', sourceRead: 'readable' }
        : { jobId, disposition: 'admitted', epochKey, sourceRead: 'transient-unknown' };
    }
    if (!cached || !sameEpoch(cached.epochKey, epochKey) || cached.frontier > frontier) {
      cached = { epochKey, frontier: -1, events: [] };
    }
    if (cached.frontier !== frontier) {
      const request = session && 'jobIds' in session ? (session as WaitStreamRequest) : undefined;
      const position = request ? waitReadPosition(request, jobId, epochKey) : { afterSeq: 0 };
      const afterSeq = Math.max(position.afterSeq, cached.frontier, 0);
      const observed =
        position.tail !== undefined || position.limit !== undefined
          ? this.deps.readJobEvents(jobId, afterSeq, position)
          : this.deps.readJobEvents(jobId, afterSeq);
      const appended = observed.filter(
        (event) => (event.seq > afterSeq || (event.type === 'terminal' && !cached.terminal)) && event.seq <= frontier,
      );
      cached.events = [...cached.events, ...appended];
      cached.terminal ??= appended.find((event): event is JobTerminalEvent => event.type === 'terminal');
      cached.frontier =
        position.limit !== undefined && appended.filter((event) => event.type === 'progress').length >= position.limit
          ? Math.max(afterSeq, ...appended.filter((event) => event.type === 'progress').map((event) => event.seq))
          : frontier;
      frontiers.set(jobId, cached);
    }
    const events = cached.events;
    const terminal = cached.terminal;
    const exit =
      projected.exit && terminal
        ? {
            ...projected.exit,
            ...surfaceProviderHostRecovery(terminal, projected),
            diagnostics: { ...projected.exit.diagnostics, usage: this.readTerminalUsage(terminal, projected.status) },
          }
        : null;
    const availability = exit ? this.deps.observeResultAvailability(jobId, session) : undefined;
    if (availability?.kind === 'repair-pending') this.deps.hintResultRepair?.(jobId);
    const admission: WaitAdmission = {
      jobId,
      disposition: 'admitted',
      sourceRead: 'readable',
      epochKey,
      detail: { status: projected.status, events, readiness: 'ready', exit },
      availability,
      continuity: this.readQueryContinuity(jobId, projected.status),
      ...(projected.status.phase === 'queued' && !exit ? { queued: this.queuedWaitEvent(projected.status) } : {}),
    };
    cached.admission = admission;
    return admission;
  }

  async *waitForJobs(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    if (req.supportsWaitV3 !== true && req.supportsWaitV2 !== true) yield* this.waitForOutcomes(req);
    else yield* this.readWait(req, false);
  }

  async *waitForOutcomes(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.readWait({ ...req, supportsWaitV3: true }, true);
  }

  private async *readWait(req: WaitStreamRequest, internal: boolean): AsyncGenerator<WaitStreamEvent> {
    const epochKey = this.deps.currentJobEpochKey?.() ?? ':memory:';
    yield* readWaitSession({
      request: req,
      internal,
      time: this.deps.time,
      activeEpochKey: epochKey,
      read: () =>
        internal && this.deps.internalWaitAdmissions
          ? this.deps.internalWaitAdmissions(req.jobIds, req)
          : this.readWaitAdmissions(req.jobIds, epochKey, req),
      observe: async (session, signal) => {
        const pending = session.admissions
          .filter((job) => job.disposition === 'admitted' && !job.detail?.exit)
          .map((job) => job.jobId);
        const observed = await this.observeWaitCarriers(pending, signal);
        if (signal.aborted) return;
        session.observeCoverage(pending, observed.unknownJobIds, observed.frontier);
        req.onCoverage?.(pending, observed.unknownJobIds, observed.frontier);
        for (const event of observed.interrupted) session.observeAbsent(event.jobId, event.observedMaxJournalSeq);
      },
    });
  }

  async waitStreamOnce(jobId: string, timeoutMs = 600_000): Promise<WaitStreamOnceResult> {
    for await (const event of this.waitForOutcomes({ jobIds: [jobId], timeoutSeconds: timeoutMs / 1000 })) {
      if (event.type === 'terminal')
        return { content: event.result.content, continuity: this.readQueryContinuity(jobId) };
      if (event.type === 'disposition' && event.disposition !== 'discovery-unknown')
        throw new Error(`Job ${jobId}: ${event.disposition}`);
    }
    throw new Error('Wait expired while job still running');
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
