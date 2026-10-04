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

  async waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void> {
    return this.deps.waitCoordinator.waitForJobTerminal(jobId, timeoutMs);
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

  readWaitAdmissions(jobIds: readonly string[], epochKey: string) {
    return this.deps.waitCoordinator.readWaitAdmissions?.(jobIds, epochKey) ?? [];
  }

  observeWaitCarriers(jobIds: readonly string[], signal: AbortSignal) {
    return (
      this.deps.waitCoordinator.observeWaitCarriers?.(jobIds, signal) ??
      Promise.resolve({ unknownJobIds: [...jobIds], interrupted: [], frontier: 0 })
    );
  }

  readWaitAdmission(jobId: string, epochKey: string) {
    return this.deps.waitCoordinator.readWaitAdmission?.(jobId, epochKey) ?? null;
  }

  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    const wait = this.deps.waitCoordinator;
    yield* wait.waitForOutcomes?.(req) ?? wait.waitForJobs(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    return this.deps.waitCoordinator.waitStreamOnce(jobId, timeoutMs);
  }
}
