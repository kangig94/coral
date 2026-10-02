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
      >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1")
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
  const pending = [path];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!budget.canContinue()) return false;
    const entry = runtime.storage.lstatSync(current, { bigint: true });
    if (entry.mtimeNs >= BigInt(Math.floor(cutoff)) * 1_000_000n) return false;
    if (entry.isDirectory()) {
      const children = runtime.storage.readDirectoryBoundedSync(current, 20_000);
      if (children.overflow) return false;
      pending.push(...children.entries.map((child) => join(current, child)));
    }
    await setImmediate();
  }
  return true;
}

async function deleteExportTree(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
): Promise<void> {
  const pending: Array<{ path: string; visited: boolean }> = [{ path, visited: false }];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
    const entry = runtime.storage.lstatSync(current.path);
    if (entry.isDirectory() && !entry.isSymbolicLink() && !current.visited) {
      const children = runtime.storage.readDirectoryBoundedSync(current.path, 20_000);
      if (children.overflow) throw new Error('export-directory-entry-bound');
      pending.push({ ...current, visited: true });
      pending.push(...children.entries.map((child) => ({ path: join(current.path, child), visited: false })));
    } else {
      mutate(() => {
        if (entry.isDirectory() && !entry.isSymbolicLink()) runtime.storage.rmdirSync(current.path);
        else runtime.storage.unlinkSync(current.path);
      });
    }
    await setImmediate();
  }
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
}): Promise<string> {
  const { runtime, cutoff, budget } = input;
  const root = runtime.paths.coral.exports.jobsRoot;
  let entries: string[];
  try {
    const rootEntry = await runtime.storage.lstat(root);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      budget.record({ kind: 'kept', subject: root, reason: 'export-root-unproven' });
      return '';
    }
    entries = (await runtime.storage.readdir(root)).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      budget.record({ kind: 'kept', subject: root, reason: errorMessage(error) });
    return '';
  }
  let afterId = input.afterId;
  for (const id of entries) {
    if (id <= afterId) continue;
    if (!budget.canContinue()) return afterId;
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
      else if (!budget.canContinue()) return afterId;
      else {
        deleting = true;
        await deleteExportTree(runtime, path, budget, input.mutate);
        outcome = { kind: 'deleted', subject: path, count: 1 };
      }
    } catch (error: unknown) {
      outcome = { kind: deleting ? 'failed' : 'kept', subject: path, reason: errorMessage(error) };
    }
    budget.record(outcome);
    afterId = id;
    await setImmediate();
  }
  return '';
}
