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
import type { RetentionOutcome, RetentionRunBudget, RetentionRunStatus } from '../../store/retention-outcome.js';
import { vacuumRetainedJournal } from '../../store/retention-vacuum.js';
import { resolveJobRetentionMs } from '../lifecycle.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
const OWNER_BUDGET_MS = 5000;
const CLOCK_JUMP_TOLERANCE_MS = 1000;

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
  let previous: { wall: number; monotonic: bigint } | null = null;
  const retentionMs = resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS'));
  const statusAtStart = (): RetentionRunStatus => ({
    startedAt: runtime.time.now(),
    finishedAt: null,
    phase: 'running',
    deleted: 0,
    kept: 0,
    failed: 0,
    outcomes: [],
  });
  const run = async (): Promise<void> => {
    const status = statusAtStart();
    let partial = false;
    const record = (outcome: RetentionOutcome): void => {
      status[outcome.kind === 'deleted' ? 'deleted' : outcome.kind === 'kept' ? 'kept' : 'failed'] +=
        outcome.kind === 'deleted' ? outcome.count : 1;
      if (outcome.kind === 'kept' && outcome.pending !== false) partial = true;
      if (status.outcomes.length < 100) status.outcomes.push(outcome);
      else if (outcome.kind === 'failed' || (outcome.kind === 'kept' && outcome.pending !== false)) {
        let replace = status.outcomes.findIndex(
          (entry) => entry.kind === 'deleted' || (entry.kind === 'kept' && entry.pending === false),
        );
        if (replace < 0)
          replace = status.outcomes.findIndex(
            (entry, index) =>
              entry.kind === 'kept' &&
              status.outcomes.some(
                (other, otherIndex) => otherIndex !== index && other.kind === 'kept' && other.reason === entry.reason,
              ),
          );
        if (replace >= 0) status.outcomes[replace] = outcome;
      }
    };
    input.publish(status);
    try {
      const progressStore = input.getProgressStore();
      const epoch = input.openEpoch();
      if (progressStore === null || epoch === null || epoch.path === ':memory:') {
        partial = true;
        record({ kind: 'kept', subject: 'storage-retention', reason: 'selected-store-unavailable' });
      } else {
        const now = { wall: status.startedAt, monotonic: runtime.time.monotonicNow() };
        const jump = previous === null ? 0 : now.wall - previous.wall - Number(now.monotonic - previous.monotonic);
        previous = now;
        if (jump > CLOCK_JUMP_TOLERANCE_MS) {
          partial = true;
          record({ kind: 'kept', subject: 'storage-retention', reason: 'wall-clock-age-unknown' });
        } else {
          const db = progressStore.getDb();
          const writer = joinSuccessionWriterGeneration(runtime, {
            storeRoot: epoch.canonicalStoreRoot ?? epoch.storeRoot,
            epoch: epoch.epoch,
          });
          const cutoff = now.wall - retentionMs;
          const step = async (
            subject: string,
            operation: (budget: RetentionRunBudget, signal: AbortSignal) => void | Promise<void>,
          ): Promise<void> => {
            const deadline = runtime.time.monotonicNow() + BigInt(OWNER_BUDGET_MS);
            const ownerAbort = new AbortController();
            const cancel = (): void => ownerAbort.abort();
            abort.signal.addEventListener('abort', cancel, { once: true });
            const ownerTimer = runtime.time.setTimeout(cancel, OWNER_BUDGET_MS);
            const cancelled = new Promise<void>((resolve) =>
              ownerAbort.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            let operations = 0;
            const budget: RetentionRunBudget = {
              record,
              canContinue: () => {
                let allowed =
                  !abort.signal.aborted &&
                  !ownerAbort.signal.aborted &&
                  runtime.time.monotonicNow() < deadline &&
                  ++operations <= 20_000;
                if (allowed) {
                  try {
                    writer.assertCurrent();
                  } catch {
                    allowed = false;
                  }
                }
                partial ||= !allowed;
                return allowed;
              },
            };
            try {
              if (budget.canContinue())
                await Promise.race([Promise.resolve().then(() => operation(budget, ownerAbort.signal)), cancelled]);
            } catch (error: unknown) {
              record({ kind: 'failed', subject, reason: errorMessage(error) });
            } finally {
              partial ||= ownerAbort.signal.aborted;
              ownerAbort.abort();
              runtime.time.clearTimeout(ownerTimer);
              abort.signal.removeEventListener('abort', cancel);
            }
          };
          const mutate = <T>(operation: () => T): T => writer.withWriteTurn(operation);
          const readCursor = (owner: string): string =>
            db
              .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
              .get(`storage-retention.${owner}.v1`)?.value ?? '';
          const saveCursor = (owner: string, value: string): void => {
            db.prepare<[string, string]>('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
              `storage-retention.${owner}.v1`,
              value,
            );
          };
          await step('exports', async (budget, signal) => {
            const next = await pruneJobExports({
              runtime,
              cutoff,
              afterId: readCursor('exports'),
              budget,
              jobState: (id) => readExportJobState(db, progressStore, id),
              resultHold: (id) => input.jobLocations.exportResultRetention(id, input.activeEpochKey()),
              mutate,
              checkpoint: (value) => {
                if (!signal.aborted) saveCursor('exports', value);
              },
            });
            if (!signal.aborted) saveCursor('exports', next);
            if (next !== '') record({ kind: 'kept', subject: 'exports', reason: 'scan-pending' });
          });
          await step('journal-progress', async (budget) => {
            if ((await pruneJobProgress({ db, readCtx: progressStore, cutoff, afterSeq: 0, budget })) !== 0)
              record({ kind: 'kept', subject: 'journal-progress', reason: 'scan-pending' });
          });
          await step('journal-vacuum', async (budget) => {
            record(await vacuumRetainedJournal(db, budget));
          });
          await step('legacy-store', async (budget, signal) => {
            record(
              await removeLegacyStore(runtime, budget.canContinue, cutoff, mutate, readCursor('legacy'), (value) => {
                if (!signal.aborted) saveCursor('legacy', value);
              }),
            );
          });
          await step('epoch-holders', async (budget, signal) => {
            const next = await pruneStoreEpochHolders(runtime, budget, mutate, readCursor('holders'), (value) => {
              if (!signal.aborted) saveCursor('holders', value);
            });
            if (!signal.aborted) saveCursor('holders', next ?? '');
            if (next) record({ kind: 'kept', subject: 'epoch-holders', reason: 'scan-pending' });
          });
          await step('scratch-jobs', (_budget, signal) => input.cleanupScratch(signal));
        }
      }
    } catch (error: unknown) {
      record({ kind: 'failed', subject: 'storage-retention', reason: errorMessage(error) });
    } finally {
      if (partial)
        record({
          kind: 'kept',
          subject: 'storage-retention',
          reason: abort.signal.aborted ? 'shutdown' : 'pending-work-or-writer-park',
        });
      status.finishedAt = runtime.time.now();
      status.phase =
        partial || (status.failed > 0 && status.deleted > 0) ? 'partial' : status.failed > 0 ? 'failed' : 'completed';
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
      previous = { wall: runtime.time.now(), monotonic: runtime.time.monotonicNow() };
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
