import type { Runtime } from '../../runtime/ports.js';
import type { JobEvent, LaunchReadiness } from '../../jobs/records.js';
import { deriveLaunchReadiness } from '../../jobs/launch-readiness.js';
import type { JobProjectionDetail } from '../../jobs/read-queries.js';
import type { JobWaitPort, WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../../jobs/wait.js';

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
  constructor(private readonly deps: JobWaitServiceDeps) {}

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

        await Promise.race([iterator.next(), this.deps.runtime.time.sleep(remainingMs)]);
      }
    } finally {
      controller.abort();
      await iterator.return?.();
    }
  }

  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.deps.waitCoordinator.waitForJobs(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    return this.deps.waitCoordinator.waitStreamOnce(jobId, timeoutMs);
  }
}
