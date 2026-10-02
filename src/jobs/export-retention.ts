import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Runtime } from '../runtime/ports.js';
import {
  createRetentionPendingSet,
  type RetentionOutcome,
  type RetentionRunBudget,
} from '../store/retention-outcome.js';
import { errorMessage } from '../infra/error-format.js';
import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import { readJobTerminalAge } from './terminal-age.js';

export type ExportJobRetentionState =
  | Readonly<{ kind: 'terminal'; terminalAt: number }>
  | Readonly<{ kind: 'nonterminal' | 'unknown' | 'absent' | 'regression' }>;

export function readExportJobState(db: Database, readCtx: StoreReadContext, jobId: string): ExportJobRetentionState {
  try {
    const latest = db
      .prepare<
        [string],
        EventsRow
      >("SELECT * FROM events INDEXED BY events_retention_stream WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1")
      .get(jobId);
    if (latest === undefined) return { kind: 'absent' };
    if (latest.type !== 'job.terminal.recorded') return { kind: 'nonterminal' };
    decodeBody(latest, jobTerminalRecordedBodySchema, readCtx);
    const terminalAt = readJobTerminalAge(db, latest);
    return typeof terminalAt === 'number' ? { kind: 'terminal', terminalAt } : { kind: terminalAt };
  } catch {
    return { kind: 'unknown' };
  }
}

async function exportTreeExpired(runtime: Runtime, path: string, cutoff: number): Promise<boolean> {
  const cutoffNs = BigInt(Math.floor(cutoff)) * 1_000_000n;
  const directory = runtime.storage.lstatSync(path, { bigint: true });
  if (directory.mtimeNs >= cutoffNs) return false;
  for (const child of await runtime.storage.readdir(path)) {
    if (runtime.storage.lstatSync(join(path, child), { bigint: true }).mtimeNs >= cutoffNs) return false;
  }
  return runtime.storage.lstatSync(path, { bigint: true }).mtimeNs === directory.mtimeNs;
}

async function deleteExportTree(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
  topLevelCutoff?: number,
): Promise<boolean> {
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  const entry = runtime.storage.lstatSync(path);
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const children =
      topLevelCutoff === undefined
        ? runtime.storage.iterateDirectory(path)
        : (await runtime.storage.readdir(path)).sort();
    for await (const child of children) {
      const childPath = join(path, child);
      if (
        topLevelCutoff !== undefined &&
        runtime.storage.lstatSync(childPath, { bigint: true }).mtimeNs >=
          BigInt(Math.floor(topLevelCutoff)) * 1_000_000n
      )
        return false;
      await deleteExportTree(runtime, childPath, budget, mutate);
      await setImmediate();
    }
  }
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  mutate(() => {
    if (entry.isDirectory() && !entry.isSymbolicLink()) runtime.storage.rmdirSync(path);
    else runtime.storage.unlinkSync(path);
  });
  return true;
}

/** A retained epoch's independent result proof must outlive the epoch itself. */
export async function pruneJobExports(input: {
  db: Database;
  runtime: Runtime;
  cutoff: number;
  afterId: string;
  budget: RetentionRunBudget;
  jobState(jobId: string): ExportJobRetentionState;
  resultHold(jobId: string): 'released' | 'required' | 'unknown';
  mutate<T>(operation: () => T): T;
  checkpoint?(nextId: string): void;
}): Promise<string> {
  const { runtime, cutoff, budget } = input;
  const root = runtime.paths.coral.exports.jobsRoot;
  if (!budget.canContinue()) return input.afterId;
  try {
    const rootEntry = await runtime.storage.lstat(root);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      budget.record({ kind: 'kept', subject: root, reason: 'export-root-unproven' });
      return '';
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      budget.record({ kind: 'kept', subject: root, reason: errorMessage(error) });
    return '';
  }
  const ids = (await runtime.storage.readdir(root)).sort();
  input.mutate(() =>
    input.db.prepare('DELETE FROM meta WHERE key = ?').run('storage-retention.exports.eligibility.v1'),
  );
  const pending = createRetentionPendingSet(input.db, 'storage-retention.exports.pending.v1', input.mutate);
  const attempted = new Set<string>();
  const process = async (id: string, deletionBudget: RetentionRunBudget): Promise<boolean> => {
    attempted.add(id);
    const path = join(root, id);
    let outcome: RetentionOutcome;
    let deleting = false;
    const admissionKey = `storage-retention.exports.admission.v1.${id}`;
    const saved = input.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(admissionKey);
    const admission = saved === undefined ? null : Number(saved.value);
    const admittedCutoff = admission !== null && Number.isFinite(admission) && admission <= cutoff ? admission : null;
    try {
      const entry = await runtime.storage.lstat(path);
      const state = input.jobState(id);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        outcome = { kind: 'kept', subject: path, reason: 'export-directory-unproven' };
      else if (state.kind === 'regression')
        outcome = { kind: 'kept', subject: path, reason: 'terminal-clock-regression' };
      else if (state.kind === 'unknown' || state.kind === 'nonterminal')
        outcome = { kind: 'kept', subject: path, reason: state.kind, pending: state.kind === 'unknown' };
      else if (state.kind === 'terminal' && (!Number.isFinite(state.terminalAt) || state.terminalAt >= cutoff))
        outcome = { kind: 'kept', subject: path, reason: 'terminal-not-expired-or-unknown' };
      else {
        const expired =
          state.kind !== 'absent' || admittedCutoff !== null || (await exportTreeExpired(runtime, path, cutoff));
        if (!expired) {
          input.mutate(() => input.db.prepare('DELETE FROM meta WHERE key = ?').run(admissionKey));
          outcome = { kind: 'kept', subject: path, reason: 'residue-recent-or-unobservable' };
        } else if (input.resultHold(id) !== 'released')
          outcome = { kind: 'kept', subject: path, reason: 'epoch-result-proof-required-or-unknown' };
        else {
          if (state.kind === 'absent' && admittedCutoff === null)
            input.mutate(() =>
              input.db
                .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                .run(admissionKey, String(cutoff)),
            );
          if (!deletionBudget.canContinue()) return false;
          deleting = true;
          const deleted = await deleteExportTree(runtime, path, deletionBudget, input.mutate, admittedCutoff ?? cutoff);
          input.mutate(() => input.db.prepare('DELETE FROM meta WHERE key = ?').run(admissionKey));
          outcome = deleted
            ? { kind: 'deleted', subject: path, count: 1 }
            : { kind: 'kept', subject: path, reason: 'residue-recent-or-unobservable' };
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !deleting) {
        pending.remove(id);
        input.mutate(() => input.db.prepare('DELETE FROM meta WHERE key = ?').run(admissionKey));
        return true;
      }
      outcome = { kind: deleting ? 'failed' : 'kept', subject: path, reason: errorMessage(error) };
    }
    if (outcome.kind === 'failed') {
      if (!pending.add(id)) {
        budget.record(outcome);
        return false;
      }
    } else if (outcome.kind === 'deleted' || outcome.pending === false) pending.remove(id);
    budget.record(outcome);
    return true;
  };
  let cursor = input.afterId;
  try {
    const retryBudget: RetentionRunBudget = {
      ...budget,
      canContinue: () => (budget.canRetry?.() ?? true) && budget.canContinue(),
    };
    for (const id of pending.retryOrder()) {
      if (!retryBudget.canContinue()) break;
      pending.advance(id);
      await process(id, retryBudget);
      await setImmediate();
    }
    for (const id of ids) {
      if (id <= input.afterId) continue;
      if (!budget.canContinue()) return cursor;
      if (!attempted.has(id) && !pending.subjects.has(id) && !(await process(id, budget))) return cursor;
      cursor = id;
      input.checkpoint?.(cursor);
      await setImmediate();
    }
    pending.clearOverflow();
    input.checkpoint?.('');
    return '';
  } finally {
    for (const id of pending.subjects) budget.record({ kind: 'kept', subject: id, reason: 'export-cleanup-pending' });
    if (pending.overflow()) budget.record({ kind: 'kept', subject: 'exports', reason: 'export-pending-overflow' });
  }
}
