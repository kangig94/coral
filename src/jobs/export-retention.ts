import type { StorageBigIntStat } from '../infra/port-types.js';
import { isRetentionChildName, readRetentionMeta } from '../store/retention-meta.js';
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
import { withImmediate, type Database } from '../store/db.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import { jobTerminalRecordedBodySchema } from './terminal/result.js';
import { readJobTerminalAge } from './terminal-age.js';

import type { JobLocation } from './location-index.js';
import { validatedTerminal, sameTerminal } from './terminal/identity.js';
import { readAcceptedTerminal } from './terminal/source.js';
import { readIntactJobTerminalAge } from './terminal-age.js';
import { trustedJobRetentionCutoff } from './retention-clock.js';

const terminalAgeSchema = z.object({
  epochKey: z.string(),
  terminalSeq: z.number().int().safe().nonnegative(),
  terminalTimestamp: z.string(),
  kind: z.enum(['known', 'unknown', 'regression']),
  terminalAt: z.number().finite().optional(),
});
export type TerminalEligibility = Readonly<{
  kind: 'expired' | 'inside' | 'unknown' | 'regression';
  age: number | 'unknown' | 'regression';
  sourceReadable: boolean;
  sourceReadFailed?: boolean;
  sourceContradictory?: boolean;
  ageUnproven?: boolean;
  publicationAuthorized: boolean;
  cutoffTrusted: boolean;
}>;

/** A timestamp alone never authorizes expiry or reconstruction of a recorded job. */
export function terminalEligibility(
  runtime: Pick<Runtime, 'time' | 'env'>,
  location: JobLocation | null,
  withSource: <T>(read: (db: Database) => T) => T | null,
  observeSource = true,
): TerminalEligibility {
  const cutoff = trustedJobRetentionCutoff(runtime);
  const denied = {
    kind: 'unknown',
    age: 'unknown',
    sourceReadable: false,
    publicationAuthorized: false,
    cutoffTrusted: cutoff !== null,
  } as const;
  if (
    !location ||
    location.disposition !== 'terminal' ||
    location.detail.kind !== 'recorded' ||
    location.terminalSeq === undefined
  )
    return denied;
  const terminal = validatedTerminal(location.detail.value, location.jobId, location.epochKey, location.terminalSeq);
  if (!terminal) return denied;
  const saved = terminalAgeSchema.safeParse(location.terminalAge);
  const matches =
    saved.success &&
    saved.data.epochKey === location.epochKey &&
    saved.data.terminalSeq === terminal.seq &&
    saved.data.terminalTimestamp === terminal.ts;
  let age: number | 'unknown' | 'regression' =
    matches && saved.data.kind === 'known' && saved.data.terminalAt === Date.parse(terminal.ts)
      ? saved.data.terminalAt
      : matches && saved.data.kind === 'regression'
        ? 'regression'
        : 'unknown';
  let sourceReadable = false;
  let sourceReadFailed = false;
  let sourceContradictory = false;
  if (observeSource && !(cutoff !== null && typeof age === 'number' && age < cutoff)) {
    try {
      withSource((db) => {
        const accepted = readAcceptedTerminal(db, location.jobId);
        if (!accepted || accepted.seq !== terminal.seq || accepted.ts !== terminal.ts) {
          sourceContradictory = true;
          return;
        }
        const body = jobTerminalRecordedBodySchema.parse(JSON.parse(Buffer.from(accepted.body).toString('utf8')));
        if (!sameTerminal(terminal.result, body.terminal)) {
          sourceContradictory = true;
          return;
        }
        sourceReadable = true;
        if (location.terminalAge === undefined) age = readIntactJobTerminalAge(db, accepted, cutoff);
      });
    } catch {
      sourceReadFailed = true;
    }
  }
  const kind = cutoff === null ? 'unknown' : typeof age === 'number' ? (age < cutoff ? 'expired' : 'inside') : age;
  const regressionAuthorized = age === 'regression' && matches && saved.data.kind === 'regression' && sourceReadable;
  return {
    kind,
    age,
    sourceReadable,
    sourceReadFailed,
    sourceContradictory,
    ageUnproven: location.terminalAge === undefined || (matches && saved.data.kind === 'unknown'),
    cutoffTrusted: cutoff !== null,
    publicationAuthorized: cutoff !== null && sourceReadable && (kind === 'inside' || regressionAuthorized),
  };
}

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
  directories = new Map<string, StorageBigIntStat>(),
): Promise<boolean> {
  const cutoffNs = BigInt(Math.floor(cutoff)) * 1_000_000n;
  const directory = runtime.storage.lstatSync(path, { bigint: true });
  if (!directory.isDirectory()) return false;
  if (
    directory.mtimeNs >= BigInt(Math.floor(directoryCutoff)) * 1_000_000n &&
    directory.mtimeNs.toString() !== mtimes['']
  )
    return false;
  directories.set(path, directory);
  for (const child of await runtime.storage.readdir(path)) {
    const childPath = join(path, child);
    const entry = runtime.storage.lstatSync(childPath, { bigint: true });
    if (entry.mtimeNs >= cutoffNs && entry.mtimeNs.toString() !== mtimes[child]) return false;
    if (entry.isDirectory()) directories.set(childPath, entry);
  }
  return sameExportEntry(directory, runtime.storage.lstatSync(path, { bigint: true }));
}

function sameExportEntry(expected: StorageBigIntStat, current: StorageBigIntStat): boolean {
  return (
    expected.dev === current.dev &&
    expected.ino === current.ino &&
    expected.mode === current.mode &&
    expected.mtimeNs === current.mtimeNs
  );
}

function exportDirectoriesUnchanged(
  runtime: Runtime,
  path: string,
  directories: Map<string, StorageBigIntStat>,
): boolean {
  const ancestors: Array<[string, StorageBigIntStat]> = [];
  let directory = path;
  let expected = directories.get(directory);
  while (expected !== undefined) {
    ancestors.push([directory, expected]);
    directory = dirname(directory);
    expected = directories.get(directory);
  }
  for (const [directory, expected] of ancestors.reverse()) {
    const current = runtime.storage.lstatSync(directory, { bigint: true });
    if (!current.isDirectory() || !sameExportEntry(expected, current)) return false;
  }
  return true;
}

async function deleteExportTree(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
  changed: (top: string) => void,
  directories: Map<string, StorageBigIntStat>,
  cutoff: number,
  top = '',
): Promise<boolean> {
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  if (!exportDirectoriesUnchanged(runtime, dirname(path), directories)) return false;
  const entry = runtime.storage.lstatSync(path, { bigint: true });
  const expected = directories.get(path);
  if (expected !== undefined && !sameExportEntry(expected, entry)) return false;
  if (entry.isDirectory()) {
    if (!directories.has(path)) directories.set(path, entry);
    let deletedLeaf = false;
    let leaves: Array<{ name: string; entry: StorageBigIntStat }> = [];
    const flush = (): boolean => {
      if (leaves.length === 0) return true;
      const batch = leaves;
      leaves = [];
      const result = mutate(() => {
        try {
          for (const child of batch) {
            if (
              !deleteExportEntry(
                runtime,
                join(path, child.name),
                budget,
                (operation) => operation(),
                changed,
                directories,
                cutoff,
                top || child.name,
                child.entry,
              )
            )
              return { deleted: false };
          }
          return { deleted: true };
        } catch (error: unknown) {
          return { deleted: false, error };
        }
      });
      if ('error' in result) throw result.error;
      return result.deleted;
    };
    for await (const child of runtime.storage.iterateDirectory(path)) {
      if (!exportDirectoriesUnchanged(runtime, path, directories)) return false;
      const childPath = join(path, child);
      const childEntry = runtime.storage.lstatSync(childPath, { bigint: true });
      if (childEntry.isDirectory()) {
        if (!flush()) return false;
        if (!(await deleteExportTree(runtime, childPath, budget, mutate, changed, directories, cutoff, top || child)))
          return false;
      } else if (!deletedLeaf) {
        if (
          !deleteExportEntry(runtime, childPath, budget, mutate, changed, directories, cutoff, top || child, childEntry)
        )
          return false;
        deletedLeaf = true;
      } else leaves.push({ name: child, entry: childEntry });
      if (leaves.length === 8 && !flush()) return false;
      await setImmediate();
    }
    if (leaves.length > 0 && !flush()) return false;
  }
  return deleteExportEntry(runtime, path, budget, mutate, changed, directories, cutoff, top);
}

async function startExportDeletionBatch(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  directories: Map<string, StorageBigIntStat>,
  mutate: <T>(operation: () => T) => T,
  changed: (top: string) => void,
  cutoff: number,
): Promise<
  | { kind: 'ready'; entries: Array<{ path: string; entry: StorageBigIntStat; top: string }> }
  | { kind: 'large' }
  | { kind: 'changed' }
> {
  const entries: Array<{ path: string; entry: StorageBigIntStat; top: string }> = [];
  let observed = 0;
  let deletedLeaf = false;
  let tooLarge = false;
  const visit = async (path: string, top: string): Promise<boolean> => {
    if (++observed > 8) {
      tooLarge = true;
      return false;
    }
    if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
    if (!exportDirectoriesUnchanged(runtime, dirname(path), directories)) return false;
    const entry = runtime.storage.lstatSync(path, { bigint: true });
    const expected = directories.get(path);
    if (expected !== undefined && !sameExportEntry(expected, entry)) return false;
    if (entry.isDirectory()) {
      directories.set(path, entry);
      if ((await runtime.storage.readdir(path)).length > 8) {
        tooLarge = true;
        return false;
      }
      for await (const child of runtime.storage.iterateDirectory(path)) {
        if (!exportDirectoriesUnchanged(runtime, path, directories)) return false;
        if (!(await visit(join(path, child), top || child))) return false;
        await setImmediate();
      }
    } else if (!deletedLeaf) {
      if (!deleteExportEntry(runtime, path, budget, mutate, changed, directories, cutoff, top, entry)) return false;
      deletedLeaf = true;
      return true;
    }
    entries.push({ path, entry, top });
    return true;
  };
  if (await visit(path, '')) return { kind: 'ready', entries };
  return { kind: tooLarge ? 'large' : 'changed' };
}

function deleteExportEntry(
  runtime: Runtime,
  path: string,
  budget: RetentionRunBudget,
  mutate: <T>(operation: () => T) => T,
  changed: (top: string) => void,
  directories: Map<string, StorageBigIntStat>,
  cutoff: number,
  top: string,
  observed?: StorageBigIntStat,
): boolean {
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  if (!exportDirectoriesUnchanged(runtime, dirname(path), directories)) return false;
  const entry = observed ?? runtime.storage.lstatSync(path, { bigint: true });
  const expected = directories.get(path);
  if (expected !== undefined && !sameExportEntry(expected, entry)) return false;
  const mtime = entry.mtimeNs;
  if (!budget.canContinue()) throw new Error('export-deletion-interrupted; remaining files retry next cycle');
  return mutate(() => {
    if (!exportDirectoriesUnchanged(runtime, entry.isDirectory() ? path : dirname(path), directories)) return false;
    const current = runtime.storage.lstatSync(path, { bigint: true });
    if (entry.dev !== current.dev || entry.ino !== current.ino || entry.mode !== current.mode) return false;
    if (!entry.isDirectory() && !sameExportEntry(entry, current)) return false;
    if (entry.isDirectory()) runtime.storage.rmdirSync(path);
    else {
      if (current.mtimeNs >= BigInt(Math.floor(cutoff)) * 1_000_000n || current.mtimeNs > mtime) return false;
      runtime.storage.unlinkSync(path);
    }
    directories.delete(path);
    const parent = dirname(path);
    if (directories.has(parent)) directories.set(parent, runtime.storage.lstatSync(parent, { bigint: true }));
    changed(top);
    return true;
  });
}

function retiringJobId(name: string): string | null {
  const match =
    /^(?:\.retiring-|kept-retiring-)(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(name);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return isRetentionChildName(id) ? id : null;
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
  eligibility?(jobId: string): TerminalEligibility | undefined;
}): Promise<string> {
  const { runtime, cutoff, budget } = input;
  let mutating = false;
  const mutate = <T>(operation: () => T): T => {
    if (budget.canMutate?.() === false) throw new Error('export-retention-owner-expired');
    if (mutating) return operation();
    return input.mutate(() => {
      mutating = true;
      try {
        return withImmediate(input.db, operation);
      } finally {
        mutating = false;
      }
    });
  };
  const root = runtime.paths.coral.exports.jobsRoot;
  if (!budget.canContinue()) return input.afterId;
  let rootIdentity: StorageBigIntStat;
  try {
    const rootEntry = await runtime.storage.lstat(root);
    rootIdentity = runtime.storage.lstatSync(root, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      budget.record({ kind: 'kept', subject: root, reason: 'export-root-unproven' });
      return '';
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      budget.record({ kind: 'kept', subject: root, reason: errorMessage(error) });
    return '';
  }
  if (budget.canMutate?.() === false) return input.afterId;
  const ids = (await runtime.storage.readdir(root)).sort();
  if (budget.canMutate?.() === false) return input.afterId;
  mutate(() => input.db.prepare('DELETE FROM meta WHERE key = ?').run('storage-retention.exports.eligibility.v1'));
  const pending = createRetentionPendingSet(input.db, 'storage-retention.exports.pending.v1', mutate, budget.record);
  const attempted = new Set<string>();
  const process = async (id: string, deletionBudget: RetentionRunBudget): Promise<boolean> => {
    attempted.add(id);
    if (!isRetentionChildName(id)) {
      pending.remove(id);
      budget.record({ kind: 'kept', subject: id, reason: 'retention-subject-invalid', pending: false });
      return true;
    }
    const currentRoot = runtime.storage.lstatSync(root, { bigint: true });
    if (!currentRoot.isDirectory() || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) {
      budget.record({ kind: 'kept', subject: root, reason: 'export-root-identity-changed' });
      return false;
    }
    let workId = id;
    let path = join(root, workId);
    const recovering = id.startsWith('.retiring-');
    const keptRetirement = id.startsWith('kept-retiring-');
    const jobId = recovering || keptRetirement ? retiringJobId(id) : id;
    if (jobId === null) {
      budget.record({ kind: 'kept', subject: path, reason: 'export-retirement-kept' });
      return true;
    }
    let outcome: RetentionOutcome;
    let deleting = false;
    const admissionKey = `storage-retention.exports.admission.v1.${id}`;
    const { value: admission, reset: admissionReset } = readRetentionMeta<number | null>({
      db: input.db,
      key: admissionKey,
      mutate,
      record: budget.record,
      decode: (value) => z.number().finite().parse(JSON.parse(value)),
      fresh: () => null,
    });
    let admittedCutoff = admission !== null && Number.isFinite(admission) && admission <= cutoff ? admission : null;
    const evidenceKey = (name: string) => `storage-retention.exports.retirement.v1.${name}`;
    const clearAdmission = () =>
      mutate(() => {
        input.db
          .prepare('DELETE FROM meta WHERE key IN (?, ?, ?)')
          .run(admissionKey, `storage-retention.exports.admission.v1.${workId}`, evidenceKey(workId));
      });
    const keepRetirement = (): string =>
      mutate(() => {
        const rootEntry = runtime.storage.lstatSync(root, { bigint: true });
        if (!rootEntry.isDirectory() || rootEntry.dev !== rootIdentity.dev || rootEntry.ino !== rootIdentity.ino)
          throw new Error('export-root-identity-changed');
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
      const entry = runtime.storage.lstatSync(path, { bigint: true });
      if (budget.canMutate?.() === false) return false;
      const authority = input.eligibility?.(jobId);
      const state: ExportJobRetentionState =
        authority === undefined
          ? input.jobState(jobId)
          : authority.kind === 'expired' || authority.kind === 'inside'
            ? { kind: 'terminal', terminalAt: authority.age as number }
            : { kind: authority.kind };

      if (!entry.isDirectory()) outcome = { kind: 'kept', subject: path, reason: 'export-directory-unproven' };
      else if (state.kind === 'regression')
        outcome = { kind: 'kept', subject: recovering ? keepRetirement() : path, reason: 'terminal-clock-regression' };
      else if (state.kind === 'unknown' || state.kind === 'nonterminal')
        outcome = {
          kind: 'kept',
          subject: recovering ? keepRetirement() : path,
          reason: state.kind,
          pending: state.kind === 'unknown',
        };
      else if (
        state.kind === 'terminal' &&
        (authority !== undefined
          ? authority.kind !== 'expired'
          : !Number.isFinite(state.terminalAt) || state.terminalAt >= cutoff)
      )
        outcome = {
          kind: 'kept',
          subject: recovering ? keepRetirement() : path,
          reason: 'terminal-not-expired-or-unknown',
        };
      else {
        const { value: evidence, reset: evidenceReset } = readRetentionMeta<z.infer<
          typeof retirementEvidenceSchema
        > | null>({
          db: input.db,
          key: evidenceKey(id),
          mutate,
          record: budget.record,
          decode: (value) => retirementEvidenceSchema.parse(JSON.parse(value)),
          fresh: () => null,
        });
        if (admissionReset || evidenceReset) {
          budget.record({
            kind: 'kept',
            subject: recovering ? keepRetirement() : path,
            reason: 'retirement-evidence-reset',
            pending: true,
          });
          return true;
        }
        if (recovering && evidence !== null && evidence.cutoff <= cutoff) admittedCutoff = evidence.cutoff;
        const ageCutoff = keptRetirement ? cutoff : (admittedCutoff ?? cutoff);
        const treeCutoff = authority === undefined ? ageCutoff : runtime.time.now();
        const mtimes = !keptRetirement && evidence !== null && evidence.cutoff === ageCutoff ? evidence.mtimes : {};
        const directories = new Map<string, StorageBigIntStat>();
        const expired =
          recovering || keptRetirement
            ? await exportTreeExpired(runtime, path, treeCutoff, mtimes, treeCutoff, directories)
            : state.kind !== 'absent' || admittedCutoff !== null || (await exportTreeExpired(runtime, path, cutoff));
        if (budget.canMutate?.() === false) return false;
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
          if (!deletionBudget.canContinue()) {
            if (state.kind === 'absent' && admittedCutoff === null && !recovering)
              mutate(() =>
                input.db
                  .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                  .run(admissionKey, String(cutoff)),
              );
            return false;
          }
          const saveEvidence = () =>
            input.db
              .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
              .run(evidenceKey(workId), JSON.stringify({ cutoff: ageCutoff, mtimes }));
          deleting = true;
          if (!recovering) {
            const renameTime = runtime.time.now();
            const directoryEntry = runtime.storage.lstatSync(path, { bigint: true });
            const directoryMtime = directoryEntry.mtimeNs;
            const retiredId = `.retiring-${encodeURIComponent(jobId)}-${randomUUID()}`;
            const retired = join(root, retiredId);
            mutate(() => {
              const rootEntry = runtime.storage.lstatSync(root, { bigint: true });
              if (!rootEntry.isDirectory() || rootEntry.dev !== rootIdentity.dev || rootEntry.ino !== rootIdentity.ino)
                throw new Error('export-root-identity-changed');
              const current = runtime.storage.lstatSync(path, { bigint: true });
              if (!current.isDirectory() || current.dev !== entry.dev || current.ino !== entry.ino)
                throw new Error('export-directory-identity-changed');
              if (authority !== undefined && input.eligibility?.(jobId)?.kind !== 'expired')
                throw new Error('terminal-eligibility-changed');
              if (input.resultHold(jobId) !== 'released') throw new Error('result-hold-changed');
              runtime.storage.renameSync(path, retired);
              workId = retiredId;
              path = retired;
              mtimes[''] = directoryMtime.toString();
              saveEvidence();
              input.db.prepare('DELETE FROM meta WHERE key = ?').run(admissionKey);
              input.db
                .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                .run(`storage-retention.exports.admission.v1.${workId}`, String(ageCutoff));
              pending.remove(id);
            });
            const unchanged = sameExportEntry(directoryEntry, runtime.storage.lstatSync(path, { bigint: true }));
            const expiredAfterRename = await exportTreeExpired(
              runtime,
              path,
              treeCutoff,
              mtimes,
              renameTime,
              directories,
            );
            if (budget.canMutate?.() === false) return false;
            if (!unchanged || !expiredAfterRename) {
              outcome = { kind: 'kept', subject: keepRetirement(), reason: 'residue-recent-or-unobservable' };
              budget.record(outcome);
              return true;
            }
            mtimes[''] = directoryMtime.toString();
          }
          if (recovering)
            mutate(() => {
              saveEvidence();
              input.db
                .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
                .run(`storage-retention.exports.admission.v1.${workId}`, String(ageCutoff));
            });
          const deletionRoot = runtime.storage.lstatSync(root, { bigint: true });
          if (
            !deletionRoot.isDirectory() ||
            deletionRoot.dev !== currentRoot.dev ||
            deletionRoot.ino !== currentRoot.ino
          )
            throw new Error('export-root-identity-changed');
          directories.set(root, deletionRoot);
          const changed = (top: string): void => {
            const rootMtime = directories.get(path)?.mtimeNs;
            if (rootMtime === undefined) {
              clearAdmission();
              pending.remove(workId);
              return;
            }
            mtimes[''] = rootMtime.toString();
            const childMtime = directories.get(join(path, top))?.mtimeNs;
            if (top && childMtime !== undefined) mtimes[top] = childMtime.toString();
            else delete mtimes[top];
            saveEvidence();
          };
          if (
            authority !== undefined &&
            (input.eligibility?.(jobId)?.kind !== 'expired' || input.resultHold(jobId) !== 'released')
          ) {
            budget.record({ kind: 'kept', subject: keepRetirement(), reason: 'terminal-eligibility-changed' });
            return true;
          }
          const batch = await startExportDeletionBatch(
            runtime,
            path,
            deletionBudget,
            directories,
            mutate,
            changed,
            treeCutoff,
          );
          let deleted: boolean;
          if (batch.kind === 'changed') deleted = false;
          else if (batch.kind === 'large')
            deleted = await deleteExportTree(runtime, path, deletionBudget, mutate, changed, directories, treeCutoff);
          else {
            const result = mutate(() => {
              try {
                for (const item of batch.entries)
                  if (
                    !deleteExportEntry(
                      runtime,
                      item.path,
                      deletionBudget,
                      (operation) => operation(),
                      changed,
                      directories,
                      treeCutoff,
                      item.top,
                      item.entry.isDirectory() ? undefined : item.entry,
                    )
                  )
                    return { deleted: false };
                return { deleted: true };
              } catch (error: unknown) {
                return { deleted: false, error };
              }
            });
            if ('error' in result) throw result.error;
            deleted = result.deleted;
          }
          if (!deleted) {
            outcome = { kind: 'kept', subject: keepRetirement(), reason: 'residue-recent-or-unobservable' };
            budget.record(outcome);
            return true;
          }
          outcome = { kind: 'deleted', subject: path, count: 1 };
        }
      }
    } catch (error: unknown) {
      if (budget.canMutate?.() === false) return false;
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
  const afterId = pending.restarted ? '' : input.afterId;
  let cursor = afterId;
  let scanned = 0;
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
      if (id <= afterId && !id.startsWith('.retiring-') && !id.startsWith('kept-retiring-')) continue;
      if (!budget.canContinue()) return cursor;
      if (!attempted.has(id) && !pending.subjects.has(id) && !(await process(id, budget))) return cursor;
      if (id > cursor) cursor = id;
      if (++scanned % 32 === 0) input.checkpoint?.(cursor);
      await setImmediate();
    }
    if (budget.canMutate?.() === false) return cursor;
    pending.clearOverflow();
    cursor = '';
    return '';
  } finally {
    if (budget.canMutate?.() !== false) input.checkpoint?.(cursor);
    for (const id of pending.subjects) budget.record({ kind: 'kept', subject: id, reason: 'export-cleanup-pending' });
    if (pending.overflow()) budget.record({ kind: 'kept', subject: 'exports', reason: 'export-pending-overflow' });
  }
}
