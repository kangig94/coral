import { join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  thrownErrnoCode,
} from '../infra/error-format.js';
import type { StoragePort, TimePort, TimerHandle } from '../infra/port-types.js';
import {
  classifyShutdownRemainderDirectoryEntry,
  classifyShutdownRemainderFile,
  shutdownRemainderStageName,
  shutdownRemainderRecordDirectory,
  type ShutdownRemainderRecord,
  type ShutdownRemainderStageObservation,
  type ShutdownRemainderStageWriter,
} from '../infra/shutdown-remainder-record.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from '../infra/persisted-scalar-contracts.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { ShutdownUndischarged } from './shutdown-settlement.js';

const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type ShutdownRemainderPruneStageObserver = (
  writer: ShutdownRemainderStageWriter,
  stageName: string,
) => ShutdownRemainderStageObservation;

type ShutdownRemainderPruneRuntime = Readonly<{
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'renameSync' | 'statSync' | 'unlinkSync'>;
  runDir: string;
  observeStageWriter?: ShutdownRemainderPruneStageObserver;
}>;

type ShutdownRemainderWriteRuntime = Readonly<{
  storage: Pick<StoragePort, 'mkdirSync' | 'renameSync' | 'unlinkSync' | 'writeAtomicSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
  writer: Readonly<{ pid: number; incarnation?: ProcessIncarnation }>;
}>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  undischarged: readonly ShutdownUndischarged[];
}>;

export function shutdownRemainderPath(runDir: string): string {
  return shutdownRemainderRecordDirectory(runDir);
}

type RecordAge = Readonly<{ kind: 'known'; mtimeMs: number }> | Readonly<{ kind: 'unknown' }>;

export type ShutdownRemainderPruneDisposition = Readonly<{
  stageOwnership:
    | Readonly<{ kind: 'classified' }>
    | Readonly<{ kind: 'held'; stageNames: readonly string[] }>
    | Readonly<{ kind: 'unclassified'; stageNames: readonly string[] }>;
  cleanup: Readonly<{ kind: 'complete' }> | Readonly<{ kind: 'refused'; subjectNames: readonly string[] }>;
}>;

// Newest-known-first, with every 'unknown' age ranked older than any known mtime: a file this build could not
// stat carries no age evidence to assert a real age from, but still needs the same bounded-retention exit as
// every other unreadable file (design-philosophy.md principle 11/12), so it is the first to fall outside the
// retained window once the bound is exceeded rather than being exempted from the bound entirely.
function byRetentionOrder(
  left: Readonly<{ name: string; age: RecordAge }>,
  right: Readonly<{ name: string; age: RecordAge }>,
): number {
  if (left.age.kind === 'known' && right.age.kind === 'known') {
    return right.age.mtimeMs - left.age.mtimeMs || right.name.localeCompare(left.name);
  }
  if (left.age.kind !== right.age.kind) return left.age.kind === 'known' ? -1 : 1;
  return right.name.localeCompare(left.name);
}

export function pruneShutdownRemainderRecords(
  runtime: ShutdownRemainderPruneRuntime,
): ShutdownRemainderPruneDisposition {
  const directory = shutdownRemainderPath(runtime.runDir);
  const reobservableStageNames = new Set<string>();
  const refusedCleanupSubjectNames = new Set<string>();
  const disposition = (stageOwnershipClassified: boolean): ShutdownRemainderPruneDisposition => {
    const stageNames = [...reobservableStageNames].sort((left, right) => left.localeCompare(right));
    const subjectNames = [...refusedCleanupSubjectNames].sort((left, right) => left.localeCompare(right));
    return {
      stageOwnership: stageOwnershipClassified
        ? stageNames.length === 0
          ? { kind: 'classified' }
          : { kind: 'held', stageNames }
        : { kind: 'unclassified', stageNames },
      cleanup: subjectNames.length === 0 ? { kind: 'complete' } : { kind: 'refused', subjectNames },
    };
  };
  try {
    const retainedStages: { name: string; age: RecordAge }[] = [];
    const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
    for (const name of runtime.storage.readdirSync(directory)) {
      const entry = classifyShutdownRemainderDirectoryEntry(name);
      if (entry.kind === 'other' || entry.kind === 'record') continue;
      let age: RecordAge = { kind: 'unknown' };
      const path = join(directory, name);
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
      }
      if (entry.kind === 'malformed-stage') {
        retainedStages.push({ name, age });
        continue;
      }
      const stage = entry.stage;
      if (stage.writer === null) {
        retainedStages.push({ name, age });
        continue;
      }
      const writerObservation = observeStageWriter(stage.writer, name);
      if (writerObservation === 'alive') {
        reobservableStageNames.add(name);
        continue;
      }
      if (writerObservation === 'unknown') {
        reobservableStageNames.add(name);
        continue;
      }
      if (stage.partial) {
        try {
          runtime.storage.unlinkSync(path);
          refusedCleanupSubjectNames.delete(name);
        } catch {
          refusedCleanupSubjectNames.add(name);
          retainedStages.push({ name, age });
        }
        continue;
      }
      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') continue;
      if (classification.kind === 'readable' && classification.record.instanceId === stage.instanceId) {
        try {
          runtime.storage.renameSync(path, join(directory, `${stage.instanceId}.json`));
          refusedCleanupSubjectNames.delete(name);
          continue;
        } catch {
          refusedCleanupSubjectNames.add(name);
        }
      }
      retainedStages.push({ name, age });
    }
    retainedStages.sort(byRetentionOrder);
    for (const { name } of retainedStages.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        refusedCleanupSubjectNames.delete(name);
        reobservableStageNames.delete(name);
        backendLog.warn(`shutdown remainder stage ${name} discarded beyond the retention bound`);
      } catch {
        refusedCleanupSubjectNames.add(name);
      }
    }

    const known: { name: string; age: RecordAge }[] = [];
    const unreadable: { name: string; age: RecordAge }[] = [];
    const unsupported: { name: string; age: RecordAge }[] = [];
    for (const name of runtime.storage.readdirSync(directory)) {
      if (classifyShutdownRemainderDirectoryEntry(name).kind !== 'record') continue;
      const path = join(directory, name);
      let age: RecordAge = { kind: 'unknown' };
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
      }

      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') continue;
      if (classification.kind === 'corrupt') {
        // Constraint: a decisive decode failure (design-philosophy.md principle 11) authorizes reclaiming this
        // file regardless of age — it is deleted outright rather than competing for a slot in the retention
        // count below.
        try {
          runtime.storage.unlinkSync(path);
          refusedCleanupSubjectNames.delete(name);
          backendLog.warn(`shutdown remainder record ${name} discarded: content is not valid JSON`);
        } catch {
          refusedCleanupSubjectNames.add(name);
        }
        continue;
      }
      if (classification.kind === 'unsupported') {
        // Constraint: a schema rejection is decisive only about this build, never about an older or newer one
        // that may still decode the same bytes (design-philosophy.md principle 10's rollback case) — so unlike
        // `corrupt`, it is held under the same bounded retention as `unreadable` below rather than deleted
        // outright, competing only against other unsupported files for its own slot count.
        unsupported.push({ name, age });
        continue;
      }
      if (classification.kind === 'unreadable') {
        // Constraint: a record this build cannot prove readable is not proven old or content-invalid, and
        // unknown must not authorize deletion by content (design-philosophy.md principle 11). It competes only
        // against other unreadable files for the bounded slot count below — never against a known-readable
        // record — so persistent unreadability cannot displace genuinely decodable evidence out of its cap.
        unreadable.push({ name, age });
        continue;
      }
      if (name !== `${classification.record.instanceId}.json`) {
        try {
          runtime.storage.unlinkSync(path);
          refusedCleanupSubjectNames.delete(name);
          backendLog.warn(`shutdown remainder record ${name} discarded: filename does not match instance identity`);
        } catch {
          refusedCleanupSubjectNames.add(name);
        }
        continue;
      }
      // Constraint: a decodable record whose age this build could not establish (`statSync` and
      // `readFileSync` are independent syscalls, so one can fail transiently while the other succeeds) is
      // still evidence, not an unknown to discard (design-philosophy.md principle 11) — it joins `known`
      // rather than falling outside every retention bound, and `byRetentionOrder` ranks it as the oldest
      // entry in that bucket for exactly this reason.
      known.push({ name, age });
    }
    known.sort(byRetentionOrder);
    for (const { name } of known.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        refusedCleanupSubjectNames.delete(name);
      } catch {
        refusedCleanupSubjectNames.add(name);
      }
    }
    unreadable.sort(byRetentionOrder);
    // Constraint: this retention bound is the unreadable hold's only exit (design-philosophy.md principle 11 —
    // every hold names what ends it; principle 12 — no state may wait on an operator who is not there), for
    // every unreadable file including one this build could not even stat: `byRetentionOrder` ranks it as the
    // oldest, so it is reclaimed first once the bucket exceeds this same bound, without asserting anything
    // about its actual age.
    for (const { name } of unreadable.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        refusedCleanupSubjectNames.delete(name);
        backendLog.warn(
          `shutdown remainder record ${name} discarded: persistently unreadable beyond the retention bound`,
        );
      } catch {
        refusedCleanupSubjectNames.add(name);
      }
    }
    unsupported.sort(byRetentionOrder);
    // Constraint: this retention bound is the unsupported hold's only exit, on the same footing as
    // `unreadable` above — a build-relative schema rejection does not authorize deletion (design-philosophy.md
    // principle 10/11), so this bucket is reclaimed only once it exceeds its own bound, independent of `known`
    // and `unreadable`.
    for (const { name } of unsupported.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        refusedCleanupSubjectNames.delete(name);
        backendLog.warn(
          `shutdown remainder record ${name} discarded: unsupported by this build's schema, beyond the retention bound`,
        );
      } catch {
        refusedCleanupSubjectNames.add(name);
      }
    }
    return disposition(true);
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') {
      return {
        stageOwnership: { kind: 'classified' },
        cleanup: { kind: 'complete' },
      };
    }
    refusedCleanupSubjectNames.add(directory);
    return disposition(false);
  }
}

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 1_000;
const SHUTDOWN_REMAINDER_DISCOVERY_MS = 60_000;
const SHUTDOWN_REMAINDER_STAGE_REOBSERVATION_LIMIT = 3;
const SHUTDOWN_REMAINDER_PRUNE_RETRY_LIMIT = 1;

type ShutdownRemainderPrunerFollowUp =
  | Readonly<{
      kind: 'retry';
      stageNames: ReadonlySet<string>;
      cleanupSubjectNames: ReadonlySet<string>;
    }>
  | Readonly<{ kind: 'discover' }>;

/** Remainder maintenance must not keep the coordinator process alive. */
export function createShutdownRemainderPruner(
  runtime: ShutdownRemainderPruneRuntime & Readonly<{ time: Pick<TimePort, 'clearTimeout' | 'setTimeout'> }>,
): Readonly<{ start(): void; stop(): void }> {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const stageReobservations = new Map<string, number>();
  const cleanupRetries = new Map<string, number>();
  const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');

  const takeFollowUp = (disposition: ShutdownRemainderPruneDisposition): ShutdownRemainderPrunerFollowUp => {
    const observedStageNames =
      disposition.stageOwnership.kind === 'classified' ? [] : disposition.stageOwnership.stageNames;
    const retainedStageNames = new Set(observedStageNames);
    if (disposition.stageOwnership.kind !== 'unclassified') {
      for (const stageName of stageReobservations.keys()) {
        if (!retainedStageNames.has(stageName)) stageReobservations.delete(stageName);
      }
    }
    const stageCandidates =
      disposition.stageOwnership.kind === 'unclassified'
        ? new Set([...stageReobservations.keys(), ...observedStageNames])
        : retainedStageNames;
    const stageNames = new Set(
      [...stageCandidates].filter(
        (stageName) => (stageReobservations.get(stageName) ?? 0) < SHUTDOWN_REMAINDER_STAGE_REOBSERVATION_LIMIT,
      ),
    );

    const refusedSubjectNames = new Set(disposition.cleanup.kind === 'refused' ? disposition.cleanup.subjectNames : []);
    if (disposition.stageOwnership.kind !== 'unclassified') {
      for (const subjectName of cleanupRetries.keys()) {
        if (!refusedSubjectNames.has(subjectName)) cleanupRetries.delete(subjectName);
      }
    }
    const cleanupCandidates =
      disposition.stageOwnership.kind === 'unclassified'
        ? new Set([...cleanupRetries.keys(), ...refusedSubjectNames])
        : refusedSubjectNames;
    const cleanupSubjectNames = new Set(
      [...cleanupCandidates].filter(
        (subjectName) => (cleanupRetries.get(subjectName) ?? 0) < SHUTDOWN_REMAINDER_PRUNE_RETRY_LIMIT,
      ),
    );

    return stageNames.size === 0 && cleanupSubjectNames.size === 0
      ? { kind: 'discover' }
      : { kind: 'retry', stageNames, cleanupSubjectNames };
  };

  const pruneNow = (stageNames?: ReadonlySet<string>): void => {
    if (stopped) return;
    if (timer !== null) runtime.time.clearTimeout(timer);
    timer = null;
    const disposition = pruneShutdownRemainderRecords({
      ...runtime,
      observeStageWriter: (writer, stageName) =>
        stageNames === undefined || stageNames.has(stageName) ? observeStageWriter(writer, stageName) : 'unknown',
    });
    if (!stopped) {
      const followUp = takeFollowUp(disposition);
      timer = runtime.time.setTimeout(
        () => {
          timer = null;
          if (followUp.kind === 'discover') {
            stageReobservations.clear();
            cleanupRetries.clear();
            pruneNow();
            return;
          }
          for (const stageName of followUp.stageNames) {
            stageReobservations.set(stageName, (stageReobservations.get(stageName) ?? 0) + 1);
          }
          for (const subjectName of followUp.cleanupSubjectNames) {
            cleanupRetries.set(subjectName, (cleanupRetries.get(subjectName) ?? 0) + 1);
          }
          pruneNow(followUp.stageNames.size === 0 ? undefined : followUp.stageNames);
        },
        followUp.kind === 'discover' ? SHUTDOWN_REMAINDER_DISCOVERY_MS : SHUTDOWN_REMAINDER_REOBSERVATION_MS,
      );
      timer.unref?.();
    }
  };

  return {
    start: () => {
      cleanupRetries.clear();
      pruneNow();
    },
    stop: () => {
      stopped = true;
      if (timer !== null) runtime.time.clearTimeout(timer);
      timer = null;
    },
  };
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderWriteRuntime,
  input: ShutdownRemainderRecordInput,
): boolean {
  // Constraint: the reader (`persistedIdentifierSchema`/`persistedFileNameSchema` in
  // src/infra/shutdown-remainder-record.ts) accepts only an `instanceId` bound by
  // `SERIALIZED_THROWN_IDENTIFIER_PATTERN`, both as the filename and as the record's own `instanceId` field.
  // Refusing an out-of-charset value here, before the write, keeps that acceptance true instead of writing a
  // file every reader — this build's own included — can only ever classify `unsupported`.
  if (
    input.instanceId.length === 0 ||
    input.instanceId.length > SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH ||
    !SERIALIZED_THROWN_IDENTIFIER_PATTERN.test(input.instanceId)
  ) {
    throw new Error(
      `Shutdown remainder instanceId is not a valid identifier: it must match ${SERIALIZED_THROWN_IDENTIFIER_PATTERN} within ${SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH} characters.`,
    );
  }
  if (!Number.isSafeInteger(runtime.writer.pid) || runtime.writer.pid <= 0) {
    throw new Error('Shutdown remainder writer pid must be a positive safe integer.');
  }
  const directory = shutdownRemainderPath(runtime.runDir);
  const path = join(directory, `${input.instanceId}.json`);
  const stagePath = join(directory, shutdownRemainderStageName(input.instanceId, runtime.writer));
  const record: ShutdownRemainderRecord = {
    instanceId: input.instanceId,
    recordedAt: nowIsoString(runtime.time),
    reason: input.reason,
    mode: input.mode,
    entries: input.undischarged,
  };
  runtime.storage.mkdirSync(directory, { recursive: true });
  // Constraint: do not use `writeAtomicDurableSync`; `docs/design-rationale.md` §12.5 excludes its unbounded
  // journal commit waits from the coordinator exit path.
  const removeStage = (): void => {
    for (const candidate of [stagePath, `${stagePath}.tmp`]) {
      try {
        runtime.storage.unlinkSync(candidate);
      } catch {
        /* Publication cleanup must preserve the originating failure. */
      }
    }
  };
  try {
    if (
      !runtime.storage.writeAtomicSync(stagePath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      })
    ) {
      removeStage();
      return false;
    }
    runtime.storage.renameSync(stagePath, path);
    return true;
  } catch (error: unknown) {
    removeStage();
    throw error;
  }
}
