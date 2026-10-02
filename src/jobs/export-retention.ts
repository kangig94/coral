import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Runtime } from '../runtime/ports.js';
import type { RetentionOutcome, RetentionRunBudget } from '../store/retention-outcome.js';
import { errorMessage } from '../infra/error-format.js';
import type { Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';

export type ExportJobRetentionState =
  | Readonly<{ kind: 'terminal'; terminalAt: number }>
  | Readonly<{ kind: 'nonterminal' | 'unknown' | 'absent' }>;

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
    const terminalAt = Date.parse(latest.ts);
    return Number.isFinite(terminalAt) ? { kind: 'terminal', terminalAt } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

async function exportTreeExpired(
  runtime: Runtime,
  path: string,
  cutoff: number,
  budget: RetentionRunBudget,
): Promise<boolean> {
  if (!budget.canContinue()) return false;
  const entry = runtime.storage.lstatSync(path, { bigint: true });
  if (entry.mtimeNs >= BigInt(Math.floor(cutoff)) * 1_000_000n) return false;
  if (entry.isDirectory()) {
    for await (const child of runtime.storage.iterateDirectory(path)) {
      if (!budget.canContinue() || !(await exportTreeExpired(runtime, join(path, child), cutoff, budget))) return false;
      await setImmediate();
    }
  }
  return true;
}

async function deleteExportTree(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
): Promise<void> {
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  const entry = runtime.storage.lstatSync(path);
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    for await (const child of runtime.storage.iterateDirectory(path)) {
      await deleteExportTree(runtime, join(path, child), budget, mutate);
      await setImmediate();
    }
  }
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  mutate(() => {
    if (entry.isDirectory() && !entry.isSymbolicLink()) runtime.storage.rmdirSync(path);
    else runtime.storage.unlinkSync(path);
  });
}

/** A retained epoch's independent result proof must outlive the epoch itself. */
export async function pruneJobExports(input: {
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
  let resume = input.afterId !== '';
  const iterator = runtime.storage.iterateDirectory(root)[Symbol.asyncIterator]();
  try {
    let current = await iterator.next();
    while (!current.done) {
      const id = current.value;
      if (!budget.canContinue()) return id;
      if (resume && id !== input.afterId) {
        current = await iterator.next();
        await setImmediate();
        continue;
      }
      resume = false;
      const path = join(root, id);
      let outcome: RetentionOutcome;
      let deleting = false;
      try {
        const entry = await runtime.storage.lstat(path);
        const state = input.jobState(id);
        if (!entry.isDirectory() || entry.isSymbolicLink())
          outcome = { kind: 'kept', subject: path, reason: 'export-directory-unproven' };
        else if (state.kind === 'unknown' || state.kind === 'nonterminal')
          outcome = { kind: 'kept', subject: path, reason: state.kind };
        else if (state.kind === 'terminal' && (!Number.isFinite(state.terminalAt) || state.terminalAt >= cutoff))
          outcome = { kind: 'kept', subject: path, reason: 'terminal-not-expired-or-unknown' };
        else if (state.kind === 'absent' && !(await exportTreeExpired(runtime, path, cutoff, budget)))
          outcome = { kind: 'kept', subject: path, reason: 'residue-recent-or-unobservable' };
        else if (input.resultHold(id) !== 'released')
          outcome = { kind: 'kept', subject: path, reason: 'epoch-result-proof-required-or-unknown' };
        else if (!budget.canContinue()) return id;
        else {
          deleting = true;
          await deleteExportTree(runtime, path, budget, input.mutate);
          outcome = { kind: 'deleted', subject: path, count: 1 };
        }
      } catch (error: unknown) {
        outcome = { kind: deleting ? 'failed' : 'kept', subject: path, reason: errorMessage(error) };
      }
      budget.record(outcome);
      current = await iterator.next();
      input.checkpoint?.(current.done ? '' : current.value);
      await setImmediate();
    }
    if (resume) budget.record({ kind: 'kept', subject: root, reason: 'scan-pending' });
    input.checkpoint?.('');
    return '';
  } finally {
    await iterator.return?.();
  }
}
