import type { JobStore } from '#src/jobs/store.js';
import type { JobEvent } from '#src/jobs/records.js';
import type { Runtime } from '#src/runtime/ports.js';
import { commit } from '#src/store/append.js';
import { composeReducers } from '#src/store/reducers.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { publishJobEvents } from '#src/jobs/shell/event-subscription.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

export function createTestJobJournalDeps(progressStore: JobStore, runtime: Pick<Runtime, 'time'>) {
  const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
  const getCurrentJournalSeq = () =>
    (progressStore.getDb().prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const coordinatorCommit = (cb: Parameters<typeof commit>[1]) => {
    const appended = commit(progressStore.getDb(), cb, {
      now: () => new Date(runtime.time.now()),
      reducers,
      upcasters: progressStore.upcasters,
      providers: permissiveProviderLookupPort,
    });
    if (appended.length > 0) {
      publishJobEvents(appended);
    }
    return appended;
  };

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
    loadJobProjectionDetail: (jobId: string) => progressStore.loadJobProjectionDetail(jobId),
    readJobEvents: (jobId: string) => progressStore.readJobEvents(jobId),
    subscribeJobEvents,
    getCurrentJournalSeq,
    coordinatorCommit,
  };
}
