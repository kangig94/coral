import type { AttentionExecution, JobAttention } from './job-attention.js';
import type { ProgressVisit } from '../../jobs/wait/contract.js';
import { raceObserved } from '../../infra/promise-signal.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobEvent, LaunchReadiness } from '../../jobs/records.js';
import { deriveLaunchReadiness } from '../../jobs/launch-readiness.js';
import type { JobProjectionDetail } from '../../jobs/read-queries.js';
import type {
  JobWaitPort,
  WaitStreamEvent,
  WaitStreamOnceResult,
  WaitStreamRequest,
} from '../../jobs/wait/contract.js';

export interface JobWaitServiceDeps {
  jobAttention?: JobAttention;
  runtime: Pick<Runtime, 'time'>;
  waitCoordinator: JobWaitPort;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq: () => number;
}

export class JobWaitService {
  private readonly deps: JobWaitServiceDeps;
  constructor(deps: JobWaitServiceDeps) {
    this.deps = deps;
  }

  private attentionExecutions(jobIds: readonly string[], req?: WaitStreamRequest): AttentionExecution[] {
    return jobIds.flatMap((jobId) => {
      const selected = req?.executionSelections?.find((entry) => entry.jobId === jobId);
      const admission =
        req?.admissions?.find((entry) => entry.jobId === jobId) ??
        (selected === undefined
          ? undefined
          : this.deps.waitCoordinator.readWaitAdmission?.(jobId, selected.epochKey, req));
      const execution =
        admission === undefined && selected === undefined
          ? this.deps.loadJobProjectionDetail(jobId).status?.execution
          : admission?.detail?.status.execution;
      return execution === null || execution === undefined ? [] : [{ jobId, execution }];
    });
  }

  async waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void> {
    const endWait = this.deps.jobAttention?.beginWait(this.attentionExecutions([jobId]));
    try {
      return await this.deps.waitCoordinator.waitForJobTerminal(jobId, timeoutMs);
    } finally {
      endWait?.();
    }
  }

  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchReadiness> {
    const current = deriveLaunchReadiness(this.deps.loadJobProjectionDetail(jobId));
    if (current !== 'pending') {
      return current;
    }

    const controller = new AbortController();
    const iterator = this.deps
      .subscribeJobEvents({
        afterSeq: this.deps.getCurrentJournalSeq(),
        jobIds: [jobId],
        abortSignal: controller.signal,
      })
      [Symbol.asyncIterator]();

    try {
      const start = this.deps.runtime.time.now();
      while (true) {
        const readiness = deriveLaunchReadiness(this.deps.loadJobProjectionDetail(jobId));
        if (readiness !== 'pending') {
          return readiness;
        }

        const remainingMs = timeoutMs - (this.deps.runtime.time.now() - start);
        if (remainingMs <= 0) {
          return 'pending';
        }

        await raceObserved([iterator.next(), this.deps.runtime.time.sleep(remainingMs)]);
      }
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  }

  visitProgress: ProgressVisit = (epoch, read) =>
    this.deps.waitCoordinator.visitProgress?.(epoch, read) ?? { kind: 'unreadable', disposition: 'transient-unknown' };

  readWaitAdmissions(jobIds: readonly string[], epochKey: string, session?: object) {
    return this.deps.waitCoordinator.readWaitAdmissions?.(jobIds, epochKey, session) ?? [];
  }

  observeWaitCarriers(jobIds: readonly string[], signal: AbortSignal) {
    return (
      this.deps.waitCoordinator.observeWaitCarriers?.(jobIds, signal) ??
      Promise.resolve({ unknownJobIds: [...jobIds], interrupted: [], frontier: 0 })
    );
  }

  readWaitAdmission(jobId: string, epochKey: string, session?: object) {
    return this.deps.waitCoordinator.readWaitAdmission?.(jobId, epochKey, session) ?? null;
  }

  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    if (this.deps.jobAttention === undefined) {
      yield* this.deps.waitCoordinator.waitForOutcomes(req);
      return;
    }
    yield* this.deps.jobAttention.waitStream(
      req,
      (scoped) => this.deps.waitCoordinator.admitWait(scoped),
      (scoped) => this.deps.waitCoordinator.waitForOutcomes(scoped),
    );
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    const endWait = this.deps.jobAttention?.beginWait(this.attentionExecutions([jobId]));
    try {
      return await this.deps.waitCoordinator.waitStreamOnce(jobId, timeoutMs);
    } finally {
      endWait?.();
    }
  }
}
