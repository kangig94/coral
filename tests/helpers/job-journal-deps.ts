import type { ProgressStore } from '#src/jobs/job-store.js';
import type { JobProgress } from '#src/jobs/records.js';
import type { Runtime } from '#src/runtime/ports.js';

export function createTestJobJournalDeps(progressStore: ProgressStore, runtime: Pick<Runtime, 'time'>) {
  const getCurrentJournalSeq = () =>
    (progressStore.getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;

  const subscribeJobEvents = async function* ({
    afterSeq,
    jobIds,
    abortSignal,
  }: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }): AsyncIterable<JobProgress> {
    let observedSeq = afterSeq;
    const ids = new Set(jobIds);
    const waitForAbort = () =>
      abortSignal
        ? new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          })
        : new Promise<void>(() => {});

    while (!abortSignal?.aborted) {
      const events = [...ids]
        .flatMap((jobId) => progressStore.readJobProgress(jobId).filter((event) => event.seq > observedSeq))
        .sort((left, right) => left.seq - right.seq);
      if (events.length > 0) {
        for (const event of events) {
          observedSeq = Math.max(observedSeq, event.seq);
          yield event;
        }
        continue;
      }

      const seq = progressStore.getChangeSeq();
      await Promise.race([progressStore.waitForChange(seq), runtime.time.sleep(100, { signal: abortSignal }), waitForAbort()]);
    }
  };

  return {
    loadJobProjectionDetail: (jobId: string) => progressStore.loadJobProjectionDetail(jobId),
    readJobProgress: (jobId: string) => progressStore.readJobProgress(jobId),
    subscribeJobEvents,
    getCurrentJournalSeq,
  };
}
