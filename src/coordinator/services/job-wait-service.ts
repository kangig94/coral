import type { WaitCoordinator } from '../../jobs/shell/wait.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobProgress, LaunchState } from '../../jobs/records.js';
import type { JobProjectionDetail } from '../../jobs/read-contracts.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../../jobs/wait.js';

export interface JobWaitServiceDeps {
  runtime: Pick<Runtime, 'time'>;
  waitCoordinator: WaitCoordinator;
  loadJobProjectionDetail: (jobId: string) => JobProjectionDetail;
  subscribeJobEvents: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobProgress>;
  getCurrentJournalSeq: () => number;
}

export class JobWaitService {
  constructor(private readonly deps: JobWaitServiceDeps) {}

  async waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void> {
    return this.deps.waitCoordinator.waitForJobTerminal(jobId, timeoutMs);
  }

  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState> {
    const current = this.deps.loadJobProjectionDetail(jobId).status;
    if (current && current.launch.state !== 'pending') {
      return current.launch.state;
    }

    const controller = new AbortController();
    const iterator = this.deps.subscribeJobEvents({
      afterSeq: this.deps.getCurrentJournalSeq(),
      jobIds: [jobId],
      abortSignal: controller.signal,
    })[Symbol.asyncIterator]();

    try {
      const start = this.deps.runtime.time.now();
      while (true) {
        const status = this.deps.loadJobProjectionDetail(jobId).status;
        if (status && status.launch.state !== 'pending') {
          return status.launch.state;
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
