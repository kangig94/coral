import { readRetentionCursor } from '../../store/retention-meta.js';
import { errorMessage } from '../../infra/error-format.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { pruneJobExports, readExportJobState } from '../../jobs/export-retention.js';
import { pruneJobProgress } from '../../jobs/progress-retention.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { JobStore } from '../../jobs/store.js';
import type { Runtime } from '../../runtime/ports.js';
import { pruneStoreEpochHolders } from '../../store/epoch/holder.js';
import type { ResolvedStoreEpoch } from '../../store/epoch/types.js';
import { joinSuccessionWriterGeneration } from '../../store/succession-writer-generation.js';
import {
  RETENTION_OUTCOME_LIMIT_PER_KIND,
  type RetentionOutcome,
  type RetentionRunBudget,
  type RetentionRunStatus,
} from '../../store/retention-outcome.js';
import { vacuumRetainedJournal } from '../../store/retention-vacuum.js';
import { trustedJobRetentionCutoff } from '../../jobs/retention-clock.js';
import { pruneCustodyLedger } from '../../store/custody-ledger.js';
import { reconcileFinishedCustody } from '../services/recovery/custody-reconciliation.js';

const DAILY_MS = 24 * 60 * 60 * 1000;
const BACKLOG_DELAY_MS = 5 * 60 * 1000;
const OWNER_BUDGET_MS = 5000;

export function createStorageRetentionScheduler(input: {
  runtime: Runtime;
  getProgressStore(): JobStore | null;
  openEpoch(): ResolvedStoreEpoch | null;
  activeEpochKey(): string | null;
  jobLocations: JobLocationIndex;
  log(message: string): void;
  publish(status: RetentionRunStatus): void;
  cleanupScratch(signal: AbortSignal, budget: RetentionRunBudget): void | Promise<void>;
}): Readonly<{ start(): void; stop(): Promise<void> }> {
  const { runtime } = input;
  const abort = new AbortController();
  let timer: TimerHandle | null = null;
  let running = Promise.resolve();
  const outstandingOwners = new Map<string, Promise<void>>();
  let started = false;
  const owners = new Map<string, { dailyDue: bigint; fastDue: bigint | null; outcomes: RetentionOutcome[] }>(
    [
      'exports',
      'result-repair',
      'journal-progress',
      'journal-vacuum',
      'epoch-holders',
      'scratch-jobs',
      'job-locations',
      'custody-reconciliation',
      'custody',
    ].map((owner) => [owner, { dailyDue: 0n, fastDue: null, outcomes: [] }]),
  );
  const nextDelay = (): number => {
    const now = runtime.time.monotonicNow();
    let due = now + BigInt(DAILY_MS);
    for (const owner of owners.values()) {
      const ownerDue = owner.fastDue ?? owner.dailyDue;
      if (ownerDue < due) due = ownerDue;
    }
    return Math.max(0, Number(due - now));
  };
  const statusAtStart = (): RetentionRunStatus & {
    deletedByOwner: NonNullable<RetentionRunStatus['deletedByOwner']>;
  } => ({
    startedAt: runtime.time.now(),
    finishedAt: null,
    phase: 'running',
    deleted: 0,
    kept: 0,
    failed: 0,
    outcomes: [],
    deletedByOwner: { exports: 0, progressRows: 0, holderMarkers: 0, scratch: 0, custody: 0, vacuumPages: 0 },
  });
  const ownerCounts: Record<string, keyof NonNullable<RetentionRunStatus['deletedByOwner']>> = {
    exports: 'exports',
    'journal-progress': 'progressRows',
    'epoch-holders': 'holderMarkers',
    'scratch-jobs': 'scratch',
    custody: 'custody',
    'journal-vacuum': 'vacuumPages',
  };
  const appendOutcome = (outcomes: RetentionOutcome[], outcome: RetentionOutcome): void => {
    const kindCount = outcomes.filter((entry) => entry.kind === outcome.kind).length;
    if (kindCount < RETENTION_OUTCOME_LIMIT_PER_KIND) outcomes.push(outcome);
    else if (outcome.kind === 'kept' && outcome.pending !== false) {
      let replace = outcomes.findIndex((entry) => entry.kind === 'kept' && entry.pending === false);
      if (replace < 0)
        replace = outcomes.findIndex(
          (entry, index) =>
            entry.kind === 'kept' &&
            outcomes.some(
              (other, otherIndex) => otherIndex !== index && other.kind === 'kept' && other.reason === entry.reason,
            ),
        );
      if (replace >= 0) outcomes[replace] = outcome;
    }
  };
  const run = async (): Promise<void> => {
    const status = statusAtStart();
    const startedAt = runtime.time.monotonicNow();
    const dueOwners = new Set<string>();
    for (const [subject, owner] of owners) {
      if ((owner.fastDue ?? owner.dailyDue) <= startedAt) {
        dueOwners.add(subject);
      }
    }
    let partial = false;
    const record = (outcome: RetentionOutcome, owner?: string, retained = false): void => {
      if (!retained || outcome.kind !== 'deleted')
        status[outcome.kind === 'deleted' ? 'deleted' : outcome.kind === 'kept' ? 'kept' : 'failed'] +=
          outcome.kind === 'deleted' ? outcome.count : 1;
      if (outcome.kind === 'kept' && outcome.pending !== false) partial = true;
      if (outcome.kind === 'deleted' && !retained) {
        const key = owner === undefined ? undefined : ownerCounts[owner];
        if (key !== undefined) status.deletedByOwner[key] += outcome.count;
      }
      appendOutcome(status.outcomes, outcome);
      const ownerState = owner === undefined ? undefined : owners.get(owner);
      if (ownerState !== undefined) appendOutcome(ownerState.outcomes, outcome);
    };
    for (const [subject, owner] of owners) {
      if (!dueOwners.has(subject)) for (const outcome of owner.outcomes) record(outcome, undefined, true);
    }
    input.publish(status);
    try {
      const progressStore = input.getProgressStore();
      const epoch = input.openEpoch();
      if (progressStore === null || epoch === null || epoch.path === ':memory:') {
        partial = true;
        record({ kind: 'kept', subject: 'storage-retention', reason: 'selected-store-unavailable' });
      } else {
        const cutoff = trustedJobRetentionCutoff(runtime);
        if (cutoff === null) {
          partial = true;
          record({ kind: 'kept', subject: 'storage-retention', reason: 'wall-clock-age-unknown' });
        } else {
          const db = progressStore.getDb();
          const writer = joinSuccessionWriterGeneration(runtime, {
            storeRoot: epoch.canonicalStoreRoot ?? epoch.storeRoot,
            epoch: epoch.epoch,
          });
          const step = async (
            subject: string,
            operation: (
              budget: RetentionRunBudget,
              signal: AbortSignal,
              mutate: <T>(operation: () => T) => T,
            ) => void | Promise<void>,
          ): Promise<void> => {
            const owner = owners.get(subject);
            if (owner === undefined || !dueOwners.has(subject)) return;
            owner.outcomes = [];
            if (outstandingOwners.has(subject)) {
              owner.fastDue = runtime.time.monotonicNow() + BigInt(BACKLOG_DELAY_MS);
              record({ kind: 'kept', subject, reason: 'previous-owner-still-running' }, subject);
              return;
            }
            const deadline = runtime.time.monotonicNow() + BigInt(OWNER_BUDGET_MS);
            const ownerAbort = new AbortController();
            const cancel = (): void => ownerAbort.abort();
            abort.signal.addEventListener('abort', cancel, { once: true });
            const ownerTimer = runtime.time.setTimeout(cancel, OWNER_BUDGET_MS);
            const cancelled = new Promise<void>((resolve) =>
              ownerAbort.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            let operations = 0;
            let finished = false;
            let executed = false;
            let exhausted = false;
            let scanPending = false;
            let progressed = false;
            let failed = false;
            let repairPending = false;
            const budget = {
              record: (outcome) => {
                if (!finished && !ownerAbort.signal.aborted) {
                  scanPending ||= outcome.kind === 'kept' && outcome.reason === 'scan-pending';
                  progressed ||= outcome.kind === 'deleted' && outcome.count > 0;
                  failed ||= outcome.kind === 'failed';
                  repairPending ||= outcome.kind === 'kept' && outcome.reason === 'repair-pending';
                  record(outcome, subject);
                }
              },
              canRetry: () =>
                runtime.time.monotonicNow() < deadline - BigInt(OWNER_BUDGET_MS / 2) && operations < 10_000,
              canMutate: () => {
                if (abort.signal.aborted || ownerAbort.signal.aborted || runtime.time.monotonicNow() >= deadline)
                  return false;
                try {
                  writer.assertCurrent();
                  return true;
                } catch {
                  return false;
                }
              },
              canContinue: (): boolean => {
                const allowed = budget.canMutate() && ++operations <= 20_000;
                exhausted ||= !allowed && (runtime.time.monotonicNow() >= deadline || operations > 20_000);
                partial ||= !allowed && !finished;
                return allowed;
              },
            } satisfies RetentionRunBudget;
            const mutate = <T>(operation: () => T): T => {
              if (!budget.canMutate()) {
                partial = true;
                throw new Error('retention-owner-expired');
              }
              return writer.withWriteTurn(operation);
            };
            try {
              if (budget.canContinue()) {
                const work = Promise.resolve().then(() => {
                  if (ownerAbort.signal.aborted || abort.signal.aborted || !budget.canMutate()) return;
                  executed = true;
                  owner.dailyDue = startedAt + BigInt(DAILY_MS);
                  owner.fastDue = null;
                  return operation(budget, ownerAbort.signal, mutate);
                });
                outstandingOwners.set(subject, work);
                void work.finally(() => outstandingOwners.delete(subject)).catch(() => undefined);
                await Promise.race([work, cancelled]);
              }
            } catch (error: unknown) {
              failed = true;
              if (budget.canMutate()) record({ kind: 'failed', subject, reason: errorMessage(error) }, subject);
              else record({ kind: 'kept', subject, reason: 'writer-parked; daily retry' }, subject);
            } finally {
              exhausted ||=
                runtime.time.monotonicNow() >= deadline || (ownerAbort.signal.aborted && !abort.signal.aborted);
              const fastRetry =
                (!failed || subject === 'result-repair') &&
                !abort.signal.aborted &&
                !outstandingOwners.has(subject) &&
                (exhausted || (scanPending && progressed) || repairPending || (failed && subject === 'result-repair'));
              if (!executed && !abort.signal.aborted) owner.fastDue = runtime.time.monotonicNow() + 1000n;
              else if (fastRetry) owner.fastDue = runtime.time.monotonicNow() + BigInt(BACKLOG_DELAY_MS);
              finished = true;
              if (exhausted) record({ kind: 'kept', subject, reason: 'scan-pending' }, subject);
              if (ownerAbort.signal.aborted && outstandingOwners.has(subject))
                record({ kind: 'kept', subject, reason: 'owner-still-running' }, subject);
              partial ||= ownerAbort.signal.aborted;
              ownerAbort.abort();
              runtime.time.clearTimeout(ownerTimer);
              abort.signal.removeEventListener('abort', cancel);
            }
          };
          const readCursor = (owner: string, mutate: <T>(operation: () => T) => T, subject = owner): string =>
            readRetentionCursor({
              db,
              key: `storage-retention.${owner}.v1`,
              mutate,
              record: (outcome) => record(outcome, subject),
            });
          const saveCursor = (owner: string, value: string): void => {
            db.prepare<[string, string]>('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
              `storage-retention.${owner}.v1`,
              value,
            );
          };
          await step('exports', async (budget, signal, mutate) => {
            mutate(() => db.prepare('DELETE FROM meta WHERE key = ?').run('storage-retention.legacy.v1'));
            const next = await pruneJobExports({
              db,
              runtime,
              cutoff,
              eligibility: (id) =>
                input.jobLocations.read(id) === null ? undefined : input.jobLocations.terminalEligibility(id),
              afterId: readCursor('exports', mutate),
              budget,
              jobState: (id) => readExportJobState(db, progressStore, id),
              resultHold: (id) => input.jobLocations.exportResultRetention(id, input.activeEpochKey()),
              mutate,
              checkpoint: (value) => {
                if (!signal.aborted) mutate(() => saveCursor('exports', value));
              },
            });
            if (!signal.aborted) mutate(() => saveCursor('exports', next));
            if (next !== '') budget.record({ kind: 'kept', subject: 'exports', reason: 'scan-pending' });
          });
          await step('result-repair', (budget) =>
            progressStore.getResultExportOwner().repairPass(input.jobLocations.jobIds(), budget),
          );
          await step('journal-progress', async (budget) => {
            if ((await pruneJobProgress({ db, readCtx: progressStore, cutoff, afterSeq: 0, budget })) !== 0)
              budget.record({ kind: 'kept', subject: 'journal-progress', reason: 'scan-pending' });
          });
          await step('journal-vacuum', async (budget) => {
            budget.record(await vacuumRetainedJournal(db, budget));
          });
          await step('epoch-holders', async (budget, signal, mutate) => {
            const next = await pruneStoreEpochHolders(
              runtime,
              budget,
              mutate,
              readCursor('holders', mutate, 'epoch-holders'),
              (value) => {
                if (!signal.aborted) mutate(() => saveCursor('holders', value));
              },
            );
            if (!signal.aborted) mutate(() => saveCursor('holders', next ?? ''));
            if (next) budget.record({ kind: 'kept', subject: 'epoch-holders', reason: 'scan-pending' });
          });
          await step('scratch-jobs', (budget, signal) => input.cleanupScratch(signal, budget));
          await step('job-locations', async (budget, signal, mutate) => {
            let scanned = 0;
            const next = await input.jobLocations.compactTerminalRecords(
              readCursor('locations', mutate, 'job-locations'),
              budget,
              mutate,
              (value) => {
                if (++scanned % 32 === 0 && !signal.aborted) mutate(() => saveCursor('locations', value));
              },
            );
            if (!signal.aborted) mutate(() => saveCursor('locations', next));
            if (next !== '') budget.record({ kind: 'kept', subject: 'job-locations', reason: 'scan-pending' });
          });
          await step('custody-reconciliation', async (budget, signal, mutate) => {
            const next = await reconcileFinishedCustody({
              runtime,
              runDir: runtime.paths.coral.coordinator.runDir,
              index: input.jobLocations,
              afterId: readCursor('custody-reconciliation', mutate),
              checkpoint: (value) => {
                if (!signal.aborted) mutate(() => saveCursor('custody-reconciliation', value));
              },
              budget,
              signal,
              mutate,
            });
            if (!signal.aborted) mutate(() => saveCursor('custody-reconciliation', next));
            if (next !== '') budget.record({ kind: 'kept', subject: 'custody-reconciliation', reason: 'scan-pending' });
          });
          await step('custody', async (budget, signal, mutate) => {
            const next = await pruneCustodyLedger({
              runtime,
              runDir: runtime.paths.coral.coordinator.runDir,
              cutoff,
              afterId: readCursor('custody', mutate),
              checkpoint: (value) => {
                if (!signal.aborted) mutate(() => saveCursor('custody', value));
              },
              budget,
              mutate,
            });
            if (!signal.aborted) mutate(() => saveCursor('custody', next));
            if (next !== '') budget.record({ kind: 'kept', subject: 'custody', reason: 'scan-pending' });
          });
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
      for (const subject of dueOwners) {
        const owner = owners.get(subject);
        if (owner && owner.dailyDue <= startedAt) owner.fastDue = runtime.time.monotonicNow() + 1000n;
      }
      const delay = nextDelay();
      input.log(
        `Storage retention ${status.phase}: deleted=${status.deleted}, kept=${status.kept}, failed=${status.failed}; next cycle in ${delay === DAILY_MS ? '24h' : `${Math.ceil(delay / 60_000)}m`}.\n`,
      );
    }
  };
  const schedule = (delay: number): void => {
    timer = runtime.time.setTimeout(() => {
      timer = null;
      if (abort.signal.aborted) return;
      running = run().finally(() => {
        if (!abort.signal.aborted) schedule(nextDelay());
      });
    }, delay);
    timer.unref?.();
  };
  return {
    start: () => {
      if (started || abort.signal.aborted) return;
      started = true;
      trustedJobRetentionCutoff(runtime);
      input
        .getProgressStore()
        ?.getResultExportOwner()
        .onRepairHint(() => {
          const owner = owners.get('result-repair');
          if (owner) owner.fastDue = runtime.time.monotonicNow();
          if (timer !== null) {
            runtime.time.clearTimeout(timer);
            timer = null;
            schedule(0);
          }
        });
      schedule(0);
    },
    stop: async () => {
      abort.abort();
      input.getProgressStore()?.getResultExportOwner().onRepairHint(null);
      if (timer !== null) runtime.time.clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}
