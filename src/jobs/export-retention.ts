import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

const retirementEvidenceSchema = z.object({
  cutoff: z.number().finite(),
  mtimes: z.record(z.string(), z.string().regex(/^\d+$/)),
});

async function exportTreeExpired(
  runtime: Runtime,
  path: string,
  cutoff: number,
  mtimes: Record<string, string> = {},
  directoryCutoff = cutoff,
  directories = new Map<string, bigint>(),
): Promise<boolean> {
  const cutoffNs = BigInt(Math.floor(cutoff)) * 1_000_000n;
  const directory = runtime.storage.lstatSync(path, { bigint: true });
  if (
    directory.mtimeNs >= BigInt(Math.floor(directoryCutoff)) * 1_000_000n &&
    directory.mtimeNs.toString() !== mtimes['']
  )
    return false;
  directories.set(path, directory.mtimeNs);
  for (const child of await runtime.storage.readdir(path)) {
    const childPath = join(path, child);
    const entry = runtime.storage.lstatSync(childPath, { bigint: true });
    if (entry.mtimeNs >= cutoffNs && entry.mtimeNs.toString() !== mtimes[child]) return false;
    if (entry.isDirectory()) directories.set(childPath, entry.mtimeNs);
  }
  return runtime.storage.lstatSync(path, { bigint: true }).mtimeNs === directory.mtimeNs;
}

async function deleteExportTree(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
  changed: (top: string) => void,
  directories: Map<string, bigint>,
  cutoff: number,
  top = '',
): Promise<boolean> {
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  const entry = runtime.storage.lstatSync(path);
  const mtime = runtime.storage.lstatSync(path, { bigint: true }).mtimeNs;
  if (entry.isDirectory() && !entry.isSymbolicLink()) {
    if (!directories.has(path)) directories.set(path, runtime.storage.lstatSync(path, { bigint: true }).mtimeNs);
    for await (const child of runtime.storage.iterateDirectory(path)) {
      if (
        !(await deleteExportTree(
          runtime,
          join(path, child),
          budget,
          mutate,
          changed,
          directories,
          cutoff,
          top || child,
        ))
      )
        return false;
      await setImmediate();
    }
  }
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  return mutate(() => {
    for (
      let directory = entry.isDirectory() ? path : dirname(path);
      directories.has(directory);
      directory = dirname(directory)
    ) {
      if (runtime.storage.lstatSync(directory, { bigint: true }).mtimeNs !== directories.get(directory)) return false;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) runtime.storage.rmdirSync(path);
    else {
      const current = runtime.storage.lstatSync(path, { bigint: true });
      if (current.mtimeNs >= BigInt(Math.floor(cutoff)) * 1_000_000n || current.mtimeNs > mtime) return false;
      runtime.storage.unlinkSync(path);
    }
    directories.delete(path);
    const parent = dirname(path);
    if (directories.has(parent)) directories.set(parent, runtime.storage.lstatSync(parent, { bigint: true }).mtimeNs);
    changed(top);
    return true;
  });
}

function retiringJobId(name: string): string | null {
  const match = /^\.retiring-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return id !== '.' && id !== '..' && !id.includes('/') && !id.includes('\\') ? id : null;
  } catch {
    return null;
  }
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
    let workId = id;
    let path = join(root, workId);
    const recovering = id.startsWith('.retiring-');
    const jobId = recovering ? retiringJobId(id) : id;
    if (jobId === null || id.startsWith('kept-retiring-')) {
      budget.record({ kind: 'kept', subject: path, reason: 'export-retirement-kept' });
      return true;
    }
    let outcome: RetentionOutcome;
    let deleting = false;
    const admissionKey = `storage-retention.exports.admission.v1.${id}`;
    const saved = input.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(admissionKey);
    const admission = saved === undefined ? null : Number(saved.value);
    let admittedCutoff = admission !== null && Number.isFinite(admission) && admission <= cutoff ? admission : null;
    const evidenceKey = (name: string) => `storage-retention.exports.retirement.v1.${name}`;
    const clearAdmission = () =>
      input.mutate(() => {
        input.db
          .prepare('DELETE FROM meta WHERE key IN (?, ?, ?)')
          .run(admissionKey, `storage-retention.exports.admission.v1.${workId}`, evidenceKey(workId));
      });
    const keepRetirement = (): string =>
      input.mutate(() => {
        const original = join(root, jobId);
        let occupied = true;
        try {
          runtime.storage.lstatSync(original);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          occupied = false;
        }
        const keptId = occupied ? workId.replace('.retiring-', 'kept-retiring-') : jobId;
        const kept = join(root, keptId);
        runtime.storage.renameSync(path, kept);
        clearAdmission();
        pending.remove(id);
        pending.remove(workId);
        return kept;
      });
    try {
      const entry = await runtime.storage.lstat(path);
      const state = input.jobState(jobId);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        outcome = { kind: 'kept', subject: path, reason: 'export-directory-unproven' };
      else if (state.kind === 'regression')
        outcome = { kind: 'kept', subject: recovering ? keepRetirement() : path, reason: 'terminal-clock-regression' };
      else if (state.kind === 'unknown' || state.kind === 'nonterminal')
        outcome = {
          kind: 'kept',
          subject: recovering ? keepRetirement() : path,
          reason: state.kind,
          pending: state.kind === 'unknown',
        };
      else if (state.kind === 'terminal' && (!Number.isFinite(state.terminalAt) || state.terminalAt >= cutoff))
        outcome = {
          kind: 'kept',
          subject: recovering ? keepRetirement() : path,
          reason: 'terminal-not-expired-or-unknown',
        };
      else {
        const evidenceRow = input.db
          .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
          .get(evidenceKey(id));
        const evidence =
          evidenceRow === undefined ? null : retirementEvidenceSchema.parse(JSON.parse(evidenceRow.value));
        if (recovering && evidence !== null && evidence.cutoff <= cutoff) admittedCutoff = evidence.cutoff;
        const ageCutoff = admittedCutoff ?? cutoff;
        const mtimes = evidence !== null && evidence.cutoff === ageCutoff ? evidence.mtimes : {};
        const directories = new Map<string, bigint>();
        const expired = recovering
          ? await exportTreeExpired(runtime, path, ageCutoff, mtimes, ageCutoff, directories)
          : state.kind !== 'absent' || admittedCutoff !== null || (await exportTreeExpired(runtime, path, cutoff));
        if (!expired) {
          const kept = recovering ? keepRetirement() : path;
          clearAdmission();
          outcome = { kind: 'kept', subject: kept, reason: 'residue-recent-or-unobservable' };
        } else if (input.resultHold(jobId) !== 'released')
          outcome = {
            kind: 'kept',
            subject: recovering ? keepRetirement() : path,
            reason: 'epoch-result-proof-required-or-unknown',
          };
        else {
          if (state.kind === 'absent' && admittedCutoff === null && !recovering)
            input.mutate(() =>
              input.db
                .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                .run(admissionKey, String(cutoff)),
            );
          if (!deletionBudget.canContinue()) return false;
          deleting = true;
          if (!recovering) {
            const renameTime = runtime.time.now();
            const directoryMtime = runtime.storage.lstatSync(path, { bigint: true }).mtimeNs;
            const retiredId = `.retiring-${encodeURIComponent(jobId)}-${randomUUID()}`;
            const retired = join(root, retiredId);
            input.mutate(() => runtime.storage.renameSync(path, retired));
            workId = retiredId;
            path = retired;
            pending.remove(id);
            const unchanged = runtime.storage.lstatSync(path, { bigint: true }).mtimeNs === directoryMtime;
            const expiredAfterRename = await exportTreeExpired(
              runtime,
              path,
              ageCutoff,
              mtimes,
              renameTime,
              directories,
            );
            if (!unchanged || !expiredAfterRename) {
              outcome = { kind: 'kept', subject: keepRetirement(), reason: 'residue-recent-or-unobservable' };
              budget.record(outcome);
              return true;
            }
            mtimes[''] = directoryMtime.toString();
          }
          const saveEvidence = () =>
            input.db
              .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
              .run(evidenceKey(workId), JSON.stringify({ cutoff: ageCutoff, mtimes }));
          input.mutate(() => {
            saveEvidence();
            input.db.prepare('DELETE FROM meta WHERE key = ?').run(admissionKey);
            input.db
              .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
              .run(`storage-retention.exports.admission.v1.${workId}`, String(ageCutoff));
          });
          const deleted = await deleteExportTree(
            runtime,
            path,
            deletionBudget,
            input.mutate,
            (top) => {
              const rootMtime = directories.get(path);
              if (rootMtime !== undefined) {
                mtimes[''] = rootMtime.toString();
                const childMtime = directories.get(join(path, top));
                if (top && childMtime !== undefined) mtimes[top] = childMtime.toString();
                else delete mtimes[top];
                saveEvidence();
              }
            },
            directories,
            ageCutoff,
          );
          if (!deleted) {
            outcome = { kind: 'kept', subject: keepRetirement(), reason: 'residue-recent-or-unobservable' };
            budget.record(outcome);
            return true;
          }
          clearAdmission();
          outcome = { kind: 'deleted', subject: path, count: 1 };
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !deleting) {
        pending.remove(id);
        clearAdmission();
        return true;
      }
      outcome = { kind: deleting ? 'failed' : 'kept', subject: path, reason: errorMessage(error) };
    }
    if (outcome.kind === 'failed') {
      if (!pending.add(workId)) {
        budget.record(outcome);
        return false;
      }
    } else if (outcome.kind === 'deleted' || outcome.pending === false) pending.remove(workId);
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
      if (id <= input.afterId && !id.startsWith('.retiring-')) continue;
      if (!budget.canContinue()) return cursor;
      if (!attempted.has(id) && !pending.subjects.has(id) && !(await process(id, budget))) return cursor;
      if (id > cursor) cursor = id;
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
