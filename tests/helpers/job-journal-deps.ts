import type { ProgressSource } from '#src/jobs/wait/contract.js';
import type { JobStore } from '#src/jobs/store.js';
import type { JobEvent } from '#src/jobs/records.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { CommitEventsFn, PostCommitObserver } from '#src/store/append.js';
import { publishJobEvents } from '#src/jobs/shell/event-subscription.js';
import { observeTerminalResultExports } from '#src/jobs/terminal/export.js';
import { aggregateWorkflowUsage } from '#src/jobs/workflow-usage.js';

/** A test store that exports results must do so from its observer, before its announcement. */
export function observeTestTerminalExports(getStore: () => JobStore): PostCommitObserver {
  return observeTerminalResultExports((jobId) => getStore().ensureResultArtifact(jobId));
}

export function createTestJobJournalDeps(progressStore: JobStore, runtime: Pick<Runtime, 'time'>) {
  const getCurrentJournalSeq = () =>
    (progressStore.getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  // see coordinatorCommit in src/coordinator/index.ts
  const coordinatorCommit = (cb: Parameters<CommitEventsFn>[0]) =>
    progressStore.commit(cb, undefined, [
      (appended) => publishJobEvents(appended, progressStore.getDb(), progressStore),
    ]);

  const subscribeJobEvents = async function* ({
    afterSeq,
    jobIds,
    abortSignal,
  }: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }): AsyncIterable<JobEvent> {
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
        .flatMap((jobId) => progressStore.readJobEvents(jobId).filter((event) => event.seq > observedSeq))
        .sort((left, right) => left.seq - right.seq);
      if (events.length > 0) {
        for (const event of events) {
          observedSeq = Math.max(observedSeq, event.seq);
          yield event;
        }
        continue;
      }

      const seq = progressStore.getChangeSeq();
      await Promise.race([
        progressStore.waitForChange(seq),
        runtime.time.sleep(100, { signal: abortSignal }),
        waitForAbort(),
      ]);
    }
  };

  return {
    jobLocations: { read: () => null },
    jobSendAttempts: new Map<string, Promise<void>>(),
    loadJobProjectionDetail: (jobId: string) => progressStore.loadJobProjectionDetail(jobId),
    loadJobWaitDetail: (jobId: string, requestedSeq?: number) => progressStore.loadJobWaitDetail(jobId, requestedSeq),
    readJobLastSeq: (jobId: string) => progressStore.readJobLastSeq(jobId),

    visitProgress: <T>(_epoch: string, read: (source: ProgressSource) => T) => progressStore.visitProgress(read),
    observeResultAvailability: (jobId: string, execution?: number) =>
      progressStore.getResultExportOwner().observeResultAvailability(jobId, undefined, execution),
    aggregateWorkflowUsage: (workflowJobId: string) => aggregateWorkflowUsage(progressStore.getDb(), workflowJobId),
    subscribeJobEvents,
    getCurrentJournalSeq,
    coordinatorCommit,
  };
}
