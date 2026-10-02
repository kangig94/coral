import { errorMessage } from '../../infra/error-format.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { pruneJobExports, readExportJobState } from '../../jobs/export-retention.js';
import { pruneJobProgress } from '../../jobs/progress-retention.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import { pruneStoreEpochHolders } from '../../store/epoch/holder.js';
import { removeLegacyStore } from '../../store/epoch/legacy-retention.js';
import type { ResolvedStoreEpoch } from '../../store/epoch/types.js';
import { joinSuccessionWriterGeneration } from '../../store/succession-writer-generation.js';
import type { RetentionRunBudget, RetentionRunStatus } from '../../store/retention-outcome.js';
import { vacuumRetainedJournal } from '../../store/retention-vacuum.js';
import { resolveJobRetentionMs } from '../lifecycle.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
const RUN_BUDGET_MS = 30_000;

export function createStorageRetentionScheduler(input: {
  runtime: Runtime;
  getProgressStore(): JobStore | null;
  openEpoch(): ResolvedStoreEpoch | null;
  activeEpochKey(): string | null;
  jobLocations: JobLocationIndex;
  log(message: string): void;
  publish(status: RetentionRunStatus): void;
  cleanupScratch(signal: AbortSignal): void | Promise<void>;
}): Readonly<{ start(): void; stop(): Promise<void> }> {
  const { runtime } = input;
  const abort = new AbortController();
  let timer: TimerHandle | null = null;
  let running = Promise.resolve();
  let started = false;
  let afterId = '';
  let afterSeq = 0;
  const retentionMs = resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS'));

  const run = async (): Promise<void> => {
    const status: RetentionRunStatus = {
      startedAt: runtime.time.now(),
      finishedAt: null,
      phase: 'running',
      deleted: 0,
      kept: 0,
      failed: 0,
      outcomes: [],
    };
    const deadline = runtime.time.monotonicNow() + BigInt(RUN_BUDGET_MS);
    const runAbort = new AbortController();
    const cancel = (): void => runAbort.abort();
    abort.signal.addEventListener('abort', cancel, { once: true });
    const deadlineTimer = runtime.time.setTimeout(cancel, RUN_BUDGET_MS);
    deadlineTimer.unref?.();
    const cancelled = new Promise<void>((resolve) =>
      runAbort.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    let operations = 0;
    let interrupted = false;
    input.publish(status);
    const budget: RetentionRunBudget = {
      canContinue: () => {
        const allowed =
          !abort.signal.aborted &&
          !runAbort.signal.aborted &&
          runtime.time.monotonicNow() < deadline &&
          ++operations <= 100_000;
        interrupted ||= !allowed;
        return allowed;
      },
      record: (outcome) => {
        status[outcome.kind === 'deleted' ? 'deleted' : outcome.kind === 'kept' ? 'kept' : 'failed'] +=
          outcome.kind === 'deleted' ? outcome.count : 1;
        if (status.outcomes.length < 100) status.outcomes.push(outcome);
        else if (
          outcome.kind === 'failed' ||
          (outcome.kind === 'kept' &&
            !['nonterminal', 'terminal-not-expired-or-unknown', 'no-free-pages', 'legacy-absent'].includes(
              outcome.reason,
            ))
        ) {
          const replace = status.outcomes.findIndex((entry) => entry.kind !== 'failed');
          if (replace >= 0) status.outcomes[replace] = outcome;
        }
      },
    };
    const step = async (subject: string, operation: () => void | Promise<void>): Promise<void> => {
      if (!budget.canContinue()) return;
      try {
        await Promise.race([Promise.resolve().then(operation), cancelled]);
      } catch (error: unknown) {
        budget.record({ kind: 'failed', subject, reason: errorMessage(error) });
      }
    };
    try {
      const progressStore = input.getProgressStore();
      const epoch = input.openEpoch();
      if (progressStore === null || epoch === null || epoch.path === ':memory:') {
        budget.record({ kind: 'kept', subject: 'storage-retention', reason: 'selected-store-unavailable' });
      } else {
        const db = progressStore.getDb();
        const writer = joinSuccessionWriterGeneration(runtime, {
          storeRoot: epoch.canonicalStoreRoot ?? epoch.storeRoot,
          epoch: epoch.epoch,
        });
        const canContinue = budget.canContinue;
        budget.canContinue = () => {
          if (!canContinue()) return false;
          try {
            writer.assertCurrent();
            return true;
          } catch {
            interrupted = true;
            return false;
          }
        };
        const mutate = <T>(operation: () => T): T => writer.withWriteTurn(operation);
        const cutoff = status.startedAt - retentionMs;
        await step('exports', async () => {
          afterId = await pruneJobExports({
            runtime,
            cutoff,
            afterId,
            budget,
            jobState: (id) => readExportJobState(db, progressStore, id),
            resultHold: (id) => input.jobLocations.exportResultRetention(id, input.activeEpochKey()),
            mutate,
          });
        });
        await step('journal-progress', async () => {
          afterSeq = await pruneJobProgress({ db, readCtx: progressStore, cutoff, afterSeq, budget });
        });
        await step('journal-vacuum', async () => {
          budget.record(await vacuumRetainedJournal(db, budget));
        });
        await step('legacy-store', () => {
          writer.withWriteTurn(() => budget.record(removeLegacyStore(runtime, budget.canContinue)));
        });
        await step('epoch-holders', () => pruneStoreEpochHolders(runtime, budget, mutate));
        await step('scratch-jobs', () => input.cleanupScratch(runAbort.signal));
      }
    } catch (error: unknown) {
      budget.record({ kind: 'failed', subject: 'storage-retention', reason: errorMessage(error) });
    } finally {
      interrupted ||= runAbort.signal.aborted;
      runtime.time.clearTimeout(deadlineTimer);
      abort.signal.removeEventListener('abort', cancel);
      if (interrupted)
        budget.record({
          kind: 'kept',
          subject: 'storage-retention',
          reason: abort.signal.aborted ? 'shutdown' : 'budget-or-writer-park',
        });
      status.finishedAt = runtime.time.now();
      status.phase =
        interrupted || (status.failed > 0 && status.deleted > 0)
          ? 'partial'
          : status.failed > 0
            ? 'failed'
            : 'completed';
      input.publish(status);
      input.log(
        `Storage retention ${status.phase}: deleted=${status.deleted}, kept=${status.kept}, failed=${status.failed}; next cycle in 24h.\n`,
      );
    }
  };
  const schedule = (delay: number): void => {
    timer = runtime.time.setTimeout(() => {
      timer = null;
      const nextRun = runtime.time.monotonicNow() + BigInt(DAILY_MS);
      running = run().finally(() => {
        if (!abort.signal.aborted) schedule(Math.max(0, Number(nextRun - runtime.time.monotonicNow())));
      });
    }, delay);
    timer.unref?.();
  };
  return {
    start: () => {
      if (started || abort.signal.aborted) return;
      started = true;
      schedule(0);
    },
    stop: async () => {
      abort.abort();
      if (timer !== null) runtime.time.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
