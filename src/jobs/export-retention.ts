import { providerArtifactDiscardDirectory } from '../providers/capability.js';
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
import { type StoreReadContext } from '../store/body-codec.js';
import type { EventsRow } from '../store/schema.js';
import { readJobTerminalAge } from './terminal-age.js';
import { withJobArtifactGuard } from './conversation/artifact-guard.js';
import type { JobLocation } from './location-index.js';
import { retainedTerminal } from './terminal/identity.js';
import { readAcceptedTerminal, readEndedExecutionOutcome } from './terminal/source.js';
import { sourceReadFailureDisposition } from './source-read.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveJobRetentionMs(raw: string | undefined): number {
  const days = raw === undefined ? NaN : Number(raw);
  return (Number.isSafeInteger(days) && days > 0 ? days : 14) * DAY_MS;
}

export function jobRetentionCutoff(runtime: Pick<Runtime, 'time' | 'env'>): number {
  return runtime.time.now() - resolveJobRetentionMs(runtime.env.get('CORAL_JOBS_RETENTION_DAYS'));
}

/**
 * Only the job's own intact source can prove its terminal's age: a retained timestamp alone never authorizes expiry.
 * `absent` is a source epoch that is gone; `unusable` is one that cannot be decoded or disagrees with the retained
 * terminal.
 */
export type TerminalEligibility = Readonly<{
  source: 'readable' | 'absent' | 'transient' | 'unusable';
  age: 'expired' | 'inside' | 'unknown';
}>;

export function terminalEligibility(
  runtime: Pick<Runtime, 'time' | 'env'>,
  location: JobLocation | null,
  withSource: <T>(read: (db: Database) => T) => T | null,
  sourceTerminal?: EventsRow,
): TerminalEligibility {
  const terminal = location === null ? null : retainedTerminal(location);
  if (location === null || terminal === null) return { source: 'unusable', age: 'unknown' };
  let observed: ReturnType<typeof readJobTerminalAge> | 'disagrees' | null;
  try {
    observed = withSource((db) => {
      const accepted = sourceTerminal ?? readAcceptedTerminal(db, location.jobId);
      if (!accepted || accepted.seq !== terminal.seq || accepted.ts !== terminal.ts) return 'disagrees';
      return readJobTerminalAge(db, accepted);
    });
  } catch (error) {
    return {
      source: sourceReadFailureDisposition(error) === 'transient-unknown' ? 'transient' : 'unusable',
      age: 'unknown',
    };
  }
  if (observed === null) return { source: 'absent', age: 'unknown' };
  if (observed === 'disagrees') return { source: 'unusable', age: 'unknown' };
  return {
    source: 'readable',
    age: typeof observed !== 'number' ? 'unknown' : observed < jobRetentionCutoff(runtime) ? 'expired' : 'inside',
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
    if (latest.type !== 'job.execution.ended') return { kind: 'nonterminal' };
    readEndedExecutionOutcome(db, latest, readCtx);
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

interface ExportRetentionInput {
  db: Database;
  runtime: Runtime;
  cutoff: number;
  afterId: string;
  budget: RetentionRunBudget;
  jobState(jobId: string): ExportJobRetentionState;
  resultHold(jobId: string): 'released' | 'required' | 'unknown';
  mutate<T>(operation: () => T): T;
  checkpoint?(nextId: string): void;
}

interface ExportPruneContext {
  input: ExportRetentionInput;
  root: string;
  rootIdentity: StorageBigIntStat;
  mutate<T>(operation: () => T): T;
  pending: ReturnType<typeof createRetentionPendingSet>;
}

interface ExportRetirement {
  id: string;
  jobId: string;
  workId: string;
  path: string;
  recovering: boolean;
  keptRetirement: boolean;
  admissionKey: string;
  admissionReset: boolean;
  admittedCutoff: number | null;
  deleting: boolean;
}

interface ExportDeletionEvidence {
  ageCutoff: number;
  mtimes: Record<string, string>;
  directories: Map<string, StorageBigIntStat>;
}

type ExportAdmission =
  | { kind: 'admitted'; evidence: ExportDeletionEvidence }
  | { kind: 'outcome'; outcome: RetentionOutcome }
  | { kind: 'recorded' }
  | { kind: 'paused' };

function exportRetirementEvidenceKey(name: string): string {
  return `storage-retention.exports.retirement.v1.${name}`;
}

function clearExportAdmission({ input, mutate }: ExportPruneContext, subject: ExportRetirement): void {
  mutate(() => {
    input.db
      .prepare('DELETE FROM meta WHERE key IN (?, ?, ?)')
      .run(
        subject.admissionKey,
        `storage-retention.exports.admission.v1.${subject.workId}`,
        exportRetirementEvidenceKey(subject.workId),
      );
  });
}

function keepExportRetirement(context: ExportPruneContext, subject: ExportRetirement): string {
  const { input, root, rootIdentity, mutate, pending } = context;
  const { runtime } = input;
  return mutate(() => {
    const rootEntry = runtime.storage.lstatSync(root, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.dev !== rootIdentity.dev || rootEntry.ino !== rootIdentity.ino)
      throw new Error('export-root-identity-changed');
    const original = join(root, subject.jobId);
    let occupied = true;
    try {
      runtime.storage.lstatSync(original);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      occupied = false;
    }
    const keptId = occupied ? subject.workId.replace('.retiring-', 'kept-retiring-') : subject.jobId;
    const kept = join(root, keptId);
    runtime.storage.renameSync(subject.path, kept);
    clearExportAdmission(context, subject);
    pending.remove(subject.id);
    pending.remove(subject.workId);
    return kept;
  });
}

function readExportRetirement(context: ExportPruneContext, id: string, jobId: string): ExportRetirement {
  const { input, root, mutate } = context;
  const { cutoff, budget } = input;
  const admissionKey = `storage-retention.exports.admission.v1.${id}`;
  const { value: admission, reset: admissionReset } = readRetentionMeta<number | null>({
    db: input.db,
    key: admissionKey,
    mutate,
    record: budget.record,
    decode: (value) => z.number().finite().parse(JSON.parse(value)),
    fresh: () => null,
  });
  return {
    id,
    jobId,
    workId: id,
    path: join(root, id),
    recovering: id.startsWith('.retiring-'),
    keptRetirement: id.startsWith('kept-retiring-'),
    admissionKey,
    admissionReset,
    admittedCutoff: admission !== null && Number.isFinite(admission) && admission <= cutoff ? admission : null,
    deleting: false,
  };
}

function exportTerminalExpired(terminalAt: number, cutoff: number): boolean {
  return Number.isFinite(terminalAt) && terminalAt < cutoff;
}

function exportStateHold(
  context: ExportPruneContext,
  subject: ExportRetirement,
  entry: StorageBigIntStat,
  state: ExportJobRetentionState,
): RetentionOutcome | null {
  const { cutoff } = context.input;
  if (!entry.isDirectory()) return { kind: 'kept', subject: subject.path, reason: 'export-directory-unproven' };
  if (state.kind === 'regression')
    return {
      kind: 'kept',
      subject: subject.recovering ? keepExportRetirement(context, subject) : subject.path,
      reason: 'terminal-clock-regression',
    };
  if (state.kind === 'unknown' || state.kind === 'nonterminal')
    return {
      kind: 'kept',
      subject: subject.recovering ? keepExportRetirement(context, subject) : subject.path,
      reason: state.kind,
      pending: state.kind === 'unknown',
    };
  if (state.kind === 'terminal' && !exportTerminalExpired(state.terminalAt, cutoff))
    return {
      kind: 'kept',
      subject: subject.recovering ? keepExportRetirement(context, subject) : subject.path,
      reason: 'terminal-not-expired-or-unknown',
    };
  return null;
}

function restoreExportDeletionEvidence(
  { input: { cutoff } }: ExportPruneContext,
  subject: ExportRetirement,
  evidence: z.infer<typeof retirementEvidenceSchema> | null,
): ExportDeletionEvidence {
  if (subject.recovering && evidence !== null && evidence.cutoff <= cutoff) subject.admittedCutoff = evidence.cutoff;
  if (subject.keptRetirement) return { ageCutoff: cutoff, mtimes: {}, directories: new Map() };
  const ageCutoff = subject.admittedCutoff ?? cutoff;
  const mtimes = evidence?.cutoff === ageCutoff ? evidence.mtimes : {};
  return { ageCutoff, mtimes, directories: new Map() };
}

function readExportDeletionEvidence(
  context: ExportPruneContext,
  subject: ExportRetirement,
): ExportDeletionEvidence | null {
  const { input, mutate } = context;
  const { budget } = input;
  const { value: evidence, reset: evidenceReset } = readRetentionMeta<z.infer<typeof retirementEvidenceSchema> | null>({
    db: input.db,
    key: exportRetirementEvidenceKey(subject.id),
    mutate,
    record: budget.record,
    decode: (value) => retirementEvidenceSchema.parse(JSON.parse(value)),
    fresh: () => null,
  });
  if (subject.admissionReset || evidenceReset) {
    budget.record({
      kind: 'kept',
      subject: subject.recovering ? keepExportRetirement(context, subject) : subject.path,
      reason: 'retirement-evidence-reset',
      pending: true,
    });
    return null;
  }
  return restoreExportDeletionEvidence(context, subject, evidence);
}

function exportDeletionExpired(
  { input: { runtime, cutoff } }: ExportPruneContext,
  subject: ExportRetirement,
  state: ExportJobRetentionState,
  { ageCutoff, mtimes, directories }: ExportDeletionEvidence,
): Promise<boolean> | boolean {
  if (subject.recovering || subject.keptRetirement)
    return exportTreeExpired(runtime, subject.path, ageCutoff, mtimes, ageCutoff, directories);
  return state.kind !== 'absent' || subject.admittedCutoff !== null || exportTreeExpired(runtime, subject.path, cutoff);
}

function exportDeletionHold(
  context: ExportPruneContext,
  subject: ExportRetirement,
  expired: boolean,
): RetentionOutcome | null {
  const { input } = context;
  if (!expired) {
    const kept = subject.recovering ? keepExportRetirement(context, subject) : subject.path;
    clearExportAdmission(context, subject);
    return { kind: 'kept', subject: kept, reason: 'residue-recent-or-unobservable' };
  }
  if (input.resultHold(subject.jobId) !== 'released')
    return {
      kind: 'kept',
      subject: subject.recovering ? keepExportRetirement(context, subject) : subject.path,
      reason: 'epoch-result-proof-required-or-unknown',
    };
  return null;
}

function deferExportDeletion(
  { input, mutate }: ExportPruneContext,
  subject: ExportRetirement,
  state: ExportJobRetentionState,
): void {
  const { cutoff } = input;
  if (state.kind === 'absent' && subject.admittedCutoff === null && !subject.recovering)
    mutate(() =>
      input.db
        .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
        .run(subject.admissionKey, String(cutoff)),
    );
}

async function admitExportDeletion(
  context: ExportPruneContext,
  subject: ExportRetirement,
  entry: StorageBigIntStat,
  deletionBudget: RetentionRunBudget,
): Promise<ExportAdmission> {
  const { input } = context;
  const { budget } = input;
  const state = input.jobState(subject.jobId);
  const hold = exportStateHold(context, subject, entry, state);
  if (hold !== null) return { kind: 'outcome', outcome: hold };
  const evidence = readExportDeletionEvidence(context, subject);
  if (evidence === null) return { kind: 'recorded' };
  const expired = await exportDeletionExpired(context, subject, state, evidence);
  if (budget.canMutate?.() === false) return { kind: 'paused' };
  const deletionHold = exportDeletionHold(context, subject, expired);
  if (deletionHold !== null) return { kind: 'outcome', outcome: deletionHold };
  if (!deletionBudget.canContinue()) {
    deferExportDeletion(context, subject, state);
    return { kind: 'paused' };
  }
  return { kind: 'admitted', evidence };
}

function saveExportRetirementEvidence(
  { input }: ExportPruneContext,
  subject: ExportRetirement,
  { ageCutoff, mtimes }: ExportDeletionEvidence,
): void {
  input.db
    .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
    .run(exportRetirementEvidenceKey(subject.workId), JSON.stringify({ cutoff: ageCutoff, mtimes }));
}

function renameExportForRetirement(
  context: ExportPruneContext,
  subject: ExportRetirement,
  entry: StorageBigIntStat,
  evidence: ExportDeletionEvidence,
  { retiredId, directoryMtime }: { retiredId: string; directoryMtime: bigint },
): void {
  const { input, root, rootIdentity, mutate, pending } = context;
  const { runtime } = input;
  const { ageCutoff, mtimes } = evidence;
  mutate(() => {
    const rootEntry = runtime.storage.lstatSync(root, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.dev !== rootIdentity.dev || rootEntry.ino !== rootIdentity.ino)
      throw new Error('export-root-identity-changed');
    const current = runtime.storage.lstatSync(subject.path, { bigint: true });
    if (!current.isDirectory() || current.dev !== entry.dev || current.ino !== entry.ino)
      throw new Error('export-directory-identity-changed');
    runtime.storage.renameSync(subject.path, join(root, retiredId));
    subject.workId = retiredId;
    subject.path = join(root, retiredId);
    mtimes[''] = directoryMtime.toString();
    saveExportRetirementEvidence(context, subject, evidence);
    input.db.prepare('DELETE FROM meta WHERE key = ?').run(subject.admissionKey);
    input.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run(`storage-retention.exports.admission.v1.${subject.workId}`, String(ageCutoff));
    pending.remove(subject.id);
  });
}

async function retireExportDirectory(
  context: ExportPruneContext,
  subject: ExportRetirement,
  entry: StorageBigIntStat,
  evidence: ExportDeletionEvidence,
): Promise<'ready' | 'recorded' | 'paused'> {
  const { input, mutate } = context;
  const { runtime, budget } = input;
  const { ageCutoff, mtimes, directories } = evidence;
  let outcome: RetentionOutcome;
  if (!subject.recovering) {
    const renameTime = runtime.time.now();
    const directoryEntry = runtime.storage.lstatSync(subject.path, { bigint: true });
    const directoryMtime = directoryEntry.mtimeNs;
    const retiredId = `.retiring-${encodeURIComponent(subject.jobId)}-${randomUUID()}`;
    renameExportForRetirement(context, subject, entry, evidence, { retiredId, directoryMtime });
    const unchanged = sameExportEntry(directoryEntry, runtime.storage.lstatSync(subject.path, { bigint: true }));
    const expiredAfterRename = await exportTreeExpired(
      runtime,
      subject.path,
      ageCutoff,
      mtimes,
      renameTime,
      directories,
    );
    if (budget.canMutate?.() === false) return 'paused';
    if (!unchanged || !expiredAfterRename) {
      outcome = {
        kind: 'kept',
        subject: keepExportRetirement(context, subject),
        reason: 'residue-recent-or-unobservable',
      };
      budget.record(outcome);
      return 'recorded';
    }
    mtimes[''] = directoryMtime.toString();
  }
  if (subject.recovering)
    mutate(() => {
      saveExportRetirementEvidence(context, subject, evidence);
      input.db
        .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
        .run(`storage-retention.exports.admission.v1.${subject.workId}`, String(ageCutoff));
    });
  return 'ready';
}

function deleteExportBatch(
  { input: { runtime }, mutate }: ExportPruneContext,
  entries: Array<{ path: string; top: string; entry: StorageBigIntStat }>,
  { ageCutoff, directories }: ExportDeletionEvidence,
  deletionBudget: RetentionRunBudget,
  changed: (top: string) => void,
) {
  return mutate(() => {
    try {
      for (const item of entries)
        if (
          !deleteExportEntry(
            runtime,
            item.path,
            deletionBudget,
            (operation) => operation(),
            changed,
            directories,
            ageCutoff,
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
}

async function deleteRetiredExport(
  context: ExportPruneContext,
  subject: ExportRetirement,
  evidence: ExportDeletionEvidence,
  deletionBudget: RetentionRunBudget,
  currentRoot: StorageBigIntStat,
): Promise<boolean> {
  const { input, root, mutate, pending } = context;
  const { runtime } = input;
  const { ageCutoff, mtimes, directories } = evidence;
  const deletionRoot = runtime.storage.lstatSync(root, { bigint: true });
  if (!deletionRoot.isDirectory() || deletionRoot.dev !== currentRoot.dev || deletionRoot.ino !== currentRoot.ino)
    throw new Error('export-root-identity-changed');
  directories.set(root, deletionRoot);
  const changed = (top: string): void => {
    const rootMtime = directories.get(subject.path)?.mtimeNs;
    if (rootMtime === undefined) {
      clearExportAdmission(context, subject);
      pending.remove(subject.workId);
      return;
    }
    mtimes[''] = rootMtime.toString();
    const childMtime = directories.get(join(subject.path, top))?.mtimeNs;
    if (top && childMtime !== undefined) mtimes[top] = childMtime.toString();
    else delete mtimes[top];
    saveExportRetirementEvidence(context, subject, evidence);
  };
  const batch = await startExportDeletionBatch(
    runtime,
    subject.path,
    deletionBudget,
    directories,
    mutate,
    changed,
    ageCutoff,
  );
  let deleted: boolean;
  if (batch.kind === 'changed') deleted = false;
  else if (batch.kind === 'large')
    deleted = await deleteExportTree(runtime, subject.path, deletionBudget, mutate, changed, directories, ageCutoff);
  else {
    const result = deleteExportBatch(context, batch.entries, evidence, deletionBudget, changed);
    if ('error' in result) throw result.error;
    deleted = result.deleted;
  }
  return deleted;
}

function recordExportOutcome(
  { input, pending }: ExportPruneContext,
  subject: ExportRetirement,
  outcome: RetentionOutcome,
): boolean {
  if (outcome.kind === 'failed') {
    if (!pending.add(subject.workId)) {
      input.budget.record(outcome);
      return false;
    }
  } else if (outcome.kind === 'deleted' || outcome.pending === false) pending.remove(subject.workId);
  input.budget.record(outcome);
  return true;
}

async function retireAndDeleteExport(
  context: ExportPruneContext,
  subject: ExportRetirement,
  currentRoot: StorageBigIntStat,
  deletionBudget: RetentionRunBudget,
  { entry, evidence }: { entry: StorageBigIntStat; evidence: ExportDeletionEvidence },
): Promise<Exclude<ExportAdmission, { kind: 'admitted' }>> {
  const { budget } = context.input;
  subject.deleting = true;
  const retirement = await retireExportDirectory(context, subject, entry, evidence);
  if (retirement === 'paused') return { kind: 'paused' };
  if (retirement === 'recorded') return { kind: 'recorded' };
  const deleted = await deleteRetiredExport(context, subject, evidence, deletionBudget, currentRoot);
  if (!deleted) {
    budget.record({
      kind: 'kept',
      subject: keepExportRetirement(context, subject),
      reason: 'residue-recent-or-unobservable',
    });
    return { kind: 'recorded' };
  }
  return { kind: 'outcome', outcome: { kind: 'deleted', subject: subject.path, count: 1 } };
}

function settleExportDeletionFailure(
  context: ExportPruneContext,
  subject: ExportRetirement,
  error: unknown,
): Exclude<ExportAdmission, { kind: 'admitted' }> {
  const {
    input: { budget },
    pending,
  } = context;
  if (budget.canMutate?.() === false) return { kind: 'paused' };
  if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !subject.deleting) {
    pending.remove(subject.id);
    clearExportAdmission(context, subject);
    return { kind: 'recorded' };
  }
  return {
    kind: 'outcome',
    outcome: { kind: subject.deleting ? 'failed' : 'kept', subject: subject.path, reason: errorMessage(error) },
  };
}

async function pruneGuardedExport(
  context: ExportPruneContext,
  subject: ExportRetirement,
  currentRoot: StorageBigIntStat,
  deletionBudget: RetentionRunBudget,
): Promise<boolean> {
  const { input } = context;
  const { runtime, budget } = input;
  let deletion: Exclude<ExportAdmission, { kind: 'admitted' }>;
  try {
    const entry = runtime.storage.lstatSync(subject.path, { bigint: true });
    if (budget.canMutate?.() === false) return false;
    const admission = await admitExportDeletion(context, subject, entry, deletionBudget);
    deletion =
      admission.kind === 'admitted'
        ? await retireAndDeleteExport(context, subject, currentRoot, deletionBudget, {
            entry,
            evidence: admission.evidence,
          })
        : admission;
  } catch (error: unknown) {
    deletion = settleExportDeletionFailure(context, subject, error);
  }
  if (deletion.kind === 'paused') return false;
  if (deletion.kind === 'recorded') return true;
  return recordExportOutcome(context, subject, deletion.outcome);
}

async function processExportSubject(
  context: ExportPruneContext,
  id: string,
  deletionBudget: RetentionRunBudget,
  attempted: Set<string>,
): Promise<boolean> {
  const { input, root, rootIdentity, pending } = context;
  const { runtime, budget } = input;
  if (id === '.provider-artifact-discard' || id === providerArtifactDiscardDirectory) return true;
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
  const recovering = id.startsWith('.retiring-');
  const keptRetirement = id.startsWith('kept-retiring-');
  const jobId = recovering || keptRetirement ? retiringJobId(id) : id;
  if (jobId === null) {
    budget.record({ kind: 'kept', subject: join(root, id), reason: 'export-retirement-kept' });
    return true;
  }
  return withJobArtifactGuard(runtime, jobId, () =>
    pruneGuardedExport(context, readExportRetirement(context, id, jobId), currentRoot, deletionBudget),
  );
}

interface ExportScan {
  attempted: Set<string>;
  afterId: string;
  cursor: string;
  scanned: number;
}

async function retryExportSubjects(context: ExportPruneContext, attempted: Set<string>): Promise<void> {
  const {
    input: { budget },
    pending,
  } = context;
  const retryBudget: RetentionRunBudget = {
    ...budget,
    canContinue: () => (budget.canRetry?.() ?? true) && budget.canContinue(),
  };
  for (const id of pending.retryOrder()) {
    if (!retryBudget.canContinue()) break;
    pending.advance(id);
    await processExportSubject(context, id, retryBudget, attempted);
    await setImmediate();
  }
}

function exportSubjectBeforeCursor(id: string, afterId: string): boolean {
  return id <= afterId && !id.startsWith('.retiring-') && !id.startsWith('kept-retiring-');
}

function visitExportSubject(
  context: ExportPruneContext,
  id: string,
  attempted: Set<string>,
): Promise<boolean> | boolean {
  return (
    attempted.has(id) ||
    context.pending.subjects.has(id) ||
    processExportSubject(context, id, context.input.budget, attempted)
  );
}

async function scanListedExportSubjects(
  context: ExportPruneContext,
  ids: string[],
  scan: ExportScan,
): Promise<'completed' | 'paused'> {
  const { input } = context;
  for (const id of ids) {
    if (exportSubjectBeforeCursor(id, scan.afterId)) continue;
    if (!input.budget.canContinue()) return 'paused';
    if (!(await visitExportSubject(context, id, scan.attempted))) return 'paused';
    if (id > scan.cursor) scan.cursor = id;
    if (++scan.scanned % 32 === 0) input.checkpoint?.(scan.cursor);
    await setImmediate();
  }
  return 'completed';
}

async function scanExportSubjects(context: ExportPruneContext, ids: string[]): Promise<string> {
  const { input, pending } = context;
  const { budget } = input;
  const afterId = pending.restarted ? '' : input.afterId;
  const scan = { attempted: new Set<string>(), afterId, cursor: afterId, scanned: 0 };
  try {
    await retryExportSubjects(context, scan.attempted);
    if ((await scanListedExportSubjects(context, ids, scan)) === 'paused') return scan.cursor;
    if (budget.canMutate?.() === false) return scan.cursor;
    pending.clearOverflow();
    scan.cursor = '';
    return '';
  } finally {
    if (budget.canMutate?.() !== false) input.checkpoint?.(scan.cursor);
    for (const id of pending.subjects) budget.record({ kind: 'kept', subject: id, reason: 'export-cleanup-pending' });
    if (pending.overflow()) budget.record({ kind: 'kept', subject: 'exports', reason: 'export-pending-overflow' });
  }
}

async function observeExportRoot(
  { runtime, budget }: ExportRetentionInput,
  root: string,
): Promise<StorageBigIntStat | null> {
  let rootIdentity: StorageBigIntStat;
  try {
    const rootEntry = await runtime.storage.lstat(root);
    rootIdentity = runtime.storage.lstatSync(root, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
      budget.record({ kind: 'kept', subject: root, reason: 'export-root-unproven' });
      return null;
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      budget.record({ kind: 'kept', subject: root, reason: errorMessage(error) });
    return null;
  }
  return rootIdentity;
}

/** A retained epoch's independent result proof must outlive the epoch itself. */
export async function pruneJobExports(input: ExportRetentionInput): Promise<string> {
  const { runtime, budget } = input;
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
  const rootIdentity = await observeExportRoot(input, root);
  if (rootIdentity === null) return '';
  if (budget.canMutate?.() === false) return input.afterId;
  const ids = (await runtime.storage.readdir(root)).sort();
  budget.observation?.record('exports', { subjects: ids.length });
  if (budget.canMutate?.() === false) return input.afterId;
  mutate(() => input.db.prepare('DELETE FROM meta WHERE key = ?').run('storage-retention.exports.eligibility.v1'));
  const pending = createRetentionPendingSet(input.db, 'storage-retention.exports.pending.v1', mutate, budget.record);
  return scanExportSubjects({ input, root, rootIdentity, mutate, pending }, ids);
}
