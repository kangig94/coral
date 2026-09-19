import { join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  formatError,
  thrownErrnoCode,
} from '../infra/error-format.js';
import type { StoragePort, TimePort, TimerHandle } from '../infra/port-types.js';
import {
  classifyShutdownRemainderDirectoryEntry,
  classifyShutdownRemainderFile,
  SHUTDOWN_REMAINDER_SCAN_LIMIT,
  shutdownRemainderCleanupRefusal,
  shutdownRemainderStageName,
  shutdownRemainderRecordDirectory,
  type ShutdownRemainderCleanupRefusal,
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
  storage: Pick<StoragePort, 'mkdirSync' | 'readFileSync' | 'renameSync' | 'unlinkSync' | 'writeAtomicSync'>;
  time: Pick<TimePort, 'now'>;
  runDir: string;
  writer: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>;
}>;

export type ShutdownRemainderRecordInput = Readonly<{
  instanceId: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  undischarged: readonly ShutdownUndischarged[];
}>;

export type ShutdownRemainderWriteDisposition =
  | Readonly<{ kind: 'published' }>
  | Readonly<{ kind: 'refused'; detail: string }>
  | Readonly<{ kind: 'verification-unavailable'; detail: string }>;

export function shutdownRemainderPath(runDir: string): string {
  return shutdownRemainderRecordDirectory(runDir);
}

type RecordAge = Readonly<{ kind: 'known'; mtimeMs: number }> | Readonly<{ kind: 'unknown' }>;

type ShutdownRemainderCleanupDisposition =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{
      kind: 'quarantined';
      subjectNames: readonly string[];
    }>
  | Readonly<{
      kind: 'refused';
      refusals: readonly ShutdownRemainderCleanupRefusal[];
      unreportedRefusalCount?: number;
      quarantinedSubjectNames?: readonly string[];
    }>;

export type ShutdownRemainderPruneDisposition = Readonly<{
  stageOwnership:
    | Readonly<{ kind: 'classified' }>
    | Readonly<{ kind: 'held'; stageNames: readonly string[] }>
    | Readonly<{ kind: 'unclassified'; stageNames: readonly string[] }>;
  cleanup: ShutdownRemainderCleanupDisposition;
  unowned?: Readonly<{
    kind: 'present';
    subjectNames: readonly string[];
    unreportedSubjectCount?: number;
  }>;
}>;

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

type CleanupRefusalCollection = {
  readonly bySubject: Map<string, ShutdownRemainderCleanupRefusal>;
  unreportedCount: number;
};

function cleanupRefusalCollection(): CleanupRefusalCollection {
  return {
    bySubject: new Map(),
    unreportedCount: 0,
  };
}

function recordCleanupFailure(
  collection: CleanupRefusalCollection,
  name: string,
  operation: ShutdownRemainderCleanupRefusal['cause']['operation'],
  retryAction: ShutdownRemainderCleanupRefusal['retry']['action'],
  error: unknown,
): void {
  const refusal = shutdownRemainderCleanupRefusal(name, operation, retryAction, error);
  if (refusal === null) {
    collection.bySubject.delete(name);
    return;
  }
  if (collection.bySubject.has(name) || collection.bySubject.size < SHUTDOWN_REMAINDER_SCAN_LIMIT) {
    collection.bySubject.set(name, refusal);
  } else {
    collection.unreportedCount += 1;
  }
}

function pruneDisposition(
  input: Readonly<{
    stageOwnershipClassified: boolean;
    reobservableStageNames: ReadonlySet<string>;
    cleanupRefusals: CleanupRefusalCollection;
    quarantinedSubjectNames: ReadonlySet<string>;
    unrecognizedSubjectNames: ReadonlySet<string>;
    unreportedUnrecognizedSubjectCount: number;
  }>,
): ShutdownRemainderPruneDisposition {
  const stageNames = [...input.reobservableStageNames].sort((left, right) => left.localeCompare(right));
  const refusals = [...input.cleanupRefusals.bySubject.values()].sort((left, right) =>
    left.subject.localeCompare(right.subject),
  );
  const quarantinedNames = [...input.quarantinedSubjectNames].sort((left, right) => left.localeCompare(right));
  const unrecognizedNames = [...input.unrecognizedSubjectNames].sort((left, right) => left.localeCompare(right));
  let cleanup: ShutdownRemainderCleanupDisposition;
  if (refusals.length > 0 || input.cleanupRefusals.unreportedCount > 0) {
    cleanup = {
      kind: 'refused',
      refusals,
      ...(input.cleanupRefusals.unreportedCount === 0
        ? {}
        : { unreportedRefusalCount: input.cleanupRefusals.unreportedCount }),
      ...(quarantinedNames.length === 0 ? {} : { quarantinedSubjectNames: quarantinedNames }),
    };
  } else if (quarantinedNames.length > 0) {
    cleanup = { kind: 'quarantined', subjectNames: quarantinedNames };
  } else {
    cleanup = { kind: 'complete' };
  }
  return {
    stageOwnership: input.stageOwnershipClassified
      ? stageNames.length === 0
        ? { kind: 'classified' }
        : { kind: 'held', stageNames }
      : { kind: 'unclassified', stageNames },
    cleanup,
    ...(unrecognizedNames.length === 0 && input.unreportedUnrecognizedSubjectCount === 0
      ? {}
      : {
          unowned: {
            kind: 'present' as const,
            subjectNames: unrecognizedNames,
            ...(input.unreportedUnrecognizedSubjectCount === 0
              ? {}
              : { unreportedSubjectCount: input.unreportedUnrecognizedSubjectCount }),
          },
        }),
  };
}

export function pruneShutdownRemainderRecords(
  runtime: ShutdownRemainderPruneRuntime,
  heldSubjectNames: ReadonlySet<string> = new Set(),
): ShutdownRemainderPruneDisposition {
  const directory = shutdownRemainderPath(runtime.runDir);
  const reobservableStageNames = new Set<string>();
  const cleanupRefusals = cleanupRefusalCollection();
  const quarantinedSubjectNames = new Set<string>();
  const unrecognizedSubjectNames = new Set<string>();
  let unreportedUnrecognizedSubjectCount = 0;
  const disposition = (stageOwnershipClassified: boolean): ShutdownRemainderPruneDisposition =>
    pruneDisposition({
      stageOwnershipClassified,
      reobservableStageNames,
      cleanupRefusals,
      quarantinedSubjectNames,
      unrecognizedSubjectNames,
      unreportedUnrecognizedSubjectCount,
    });
  const quarantine = (name: string): void => {
    quarantinedSubjectNames.add(name);
    reobservableStageNames.delete(name);
  };
  try {
    const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
    const initialNames = runtime.storage.readdirSync(directory);
    for (const name of initialNames) {
      const entry = classifyShutdownRemainderDirectoryEntry(name);
      if (entry.kind === 'other') {
        if (unrecognizedSubjectNames.size < SHUTDOWN_REMAINDER_SCAN_LIMIT) {
          unrecognizedSubjectNames.add(name);
        } else {
          unreportedUnrecognizedSubjectCount += 1;
        }
        continue;
      }
      if (entry.kind === 'record') continue;
      if (heldSubjectNames.has(name)) {
        quarantine(name);
        continue;
      }
      cleanupRefusals.bySubject.delete(name);
      const path = join(directory, name);
      try {
        runtime.storage.statSync(path);
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') {
          cleanupRefusals.bySubject.delete(name);
          continue;
        }
      }
      if (entry.kind === 'malformed-stage') {
        quarantine(name);
        continue;
      }
      const stage = entry.stage;
      const writerObservation = observeStageWriter(stage.writer, name);
      if (stage.partial) {
        if (writerObservation === 'alive') {
          reobservableStageNames.add(name);
          continue;
        }
        if (writerObservation === 'unknown') {
          quarantine(name);
          continue;
        }
        try {
          runtime.storage.unlinkSync(path);
          cleanupRefusals.bySubject.delete(name);
        } catch (error: unknown) {
          recordCleanupFailure(cleanupRefusals, name, 'delete', 'rescan-subject', error);
        }
        continue;
      }
      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') {
        cleanupRefusals.bySubject.delete(name);
        continue;
      }
      if (classification.kind === 'readable' && classification.record.instanceId === stage.instanceId) {
        try {
          runtime.storage.renameSync(path, join(directory, `${stage.instanceId}.json`));
          cleanupRefusals.bySubject.delete(name);
          continue;
        } catch (error: unknown) {
          if (thrownErrnoCode(error) === 'ENOENT') {
            cleanupRefusals.bySubject.delete(name);
            continue;
          }
          recordCleanupFailure(cleanupRefusals, name, 'promote', 'rescan-subject', error);
        }
      }
      if (writerObservation === 'alive') {
        reobservableStageNames.add(name);
        continue;
      }
      if (!cleanupRefusals.bySubject.has(name)) quarantine(name);
    }

    const known: { name: string; age: RecordAge }[] = [];
    for (const name of runtime.storage.readdirSync(directory)) {
      if (classifyShutdownRemainderDirectoryEntry(name).kind !== 'record') continue;
      if (heldSubjectNames.has(name)) {
        quarantine(name);
        continue;
      }
      cleanupRefusals.bySubject.delete(name);
      const path = join(directory, name);
      let age: RecordAge = { kind: 'unknown' };
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') {
          cleanupRefusals.bySubject.delete(name);
          continue;
        }
      }

      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') {
        cleanupRefusals.bySubject.delete(name);
        continue;
      }
      if (classification.kind === 'corrupt') {
        // Constraint: a decisive decode failure (design-philosophy.md principle 11) authorizes reclaiming this
        // file regardless of age — it is deleted outright rather than competing for a slot in the retention
        // count below.
        try {
          runtime.storage.unlinkSync(path);
          cleanupRefusals.bySubject.delete(name);
          backendLog.warn(`shutdown remainder record ${name} discarded: content is not valid JSON`);
        } catch (error: unknown) {
          recordCleanupFailure(cleanupRefusals, name, 'delete', 'rescan-subject', error);
        }
        continue;
      }
      if (classification.kind === 'unsupported') {
        quarantine(name);
        continue;
      }
      if (classification.kind === 'unreadable') {
        quarantine(name);
        continue;
      }
      if (name !== `${classification.record.instanceId}.json`) {
        try {
          runtime.storage.unlinkSync(path);
          cleanupRefusals.bySubject.delete(name);
          backendLog.warn(`shutdown remainder record ${name} discarded: filename does not match instance identity`);
        } catch (error: unknown) {
          recordCleanupFailure(cleanupRefusals, name, 'delete', 'rescan-subject', error);
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
        cleanupRefusals.bySubject.delete(name);
      } catch (error: unknown) {
        recordCleanupFailure(cleanupRefusals, name, 'delete', 'rescan-subject', error);
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
    for (const name of heldSubjectNames) quarantine(name);
    recordCleanupFailure(cleanupRefusals, directory, 'scan-directory', 'rescan-directory', error);
    return disposition(false);
  }
}

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 60_000;

/** Remainder maintenance must not keep the coordinator process alive. */
export function createShutdownRemainderPruner(
  runtime: ShutdownRemainderPruneRuntime &
    Readonly<{
      time: Pick<TimePort, 'clearInterval' | 'setInterval'>;
    }>,
): Readonly<{
  start(): ShutdownRemainderPruneDisposition | null;
  stop(): void;
  readCleanupRefusals(): readonly ShutdownRemainderCleanupRefusal[];
  readUnreportedCleanupRefusalCount(): number;
}> {
  let timer: TimerHandle | null = null;
  let stopped = false;
  let heldSubjectNames = new Set<string>();
  let cleanupRefusals: readonly ShutdownRemainderCleanupRefusal[] = [];
  let unreportedCleanupRefusalCount = 0;
  const prune = (retryHeldSubjects: boolean): ShutdownRemainderPruneDisposition => {
    const result = pruneShutdownRemainderRecords(runtime, retryHeldSubjects ? new Set() : heldSubjectNames);
    heldSubjectNames = new Set(
      result.cleanup.kind === 'quarantined'
        ? result.cleanup.subjectNames
        : result.cleanup.kind === 'refused'
          ? result.cleanup.quarantinedSubjectNames
          : [],
    );
    cleanupRefusals = result.cleanup.kind === 'refused' ? result.cleanup.refusals : [];
    unreportedCleanupRefusalCount =
      result.cleanup.kind === 'refused' ? (result.cleanup.unreportedRefusalCount ?? 0) : 0;
    return result;
  };

  return {
    start: () => {
      if (stopped) return null;
      const disposition = prune(true);
      timer = runtime.time.setInterval(() => prune(false), SHUTDOWN_REMAINDER_REOBSERVATION_MS);
      timer.unref?.();
      return disposition;
    },
    stop: () => {
      stopped = true;
      if (timer !== null) runtime.time.clearInterval(timer);
      timer = null;
    },
    readCleanupRefusals: () => cleanupRefusals,
    readUnreportedCleanupRefusalCount: () => unreportedCleanupRefusalCount,
  };
}

export function recordShutdownRemainder(
  runtime: ShutdownRemainderWriteRuntime,
  input: ShutdownRemainderRecordInput,
): ShutdownRemainderWriteDisposition {
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
  const serializedRecord = `${JSON.stringify(record, null, 2)}\n`;
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
      !runtime.storage.writeAtomicSync(stagePath, serializedRecord, {
        encoding: 'utf-8',
        mode: 0o600,
      })
    ) {
      removeStage();
      return { kind: 'refused', detail: 'record publication returned false' };
    }
    try {
      runtime.storage.renameSync(stagePath, path);
    } catch (error: unknown) {
      if (thrownErrnoCode(error) === 'ENOENT') {
        try {
          if (runtime.storage.readFileSync(path, 'utf-8') === serializedRecord) return { kind: 'published' };
        } catch (verificationError: unknown) {
          removeStage();
          return { kind: 'verification-unavailable', detail: formatError(verificationError) };
        }
      }
      throw error;
    }
    return { kind: 'published' };
  } catch (error: unknown) {
    removeStage();
    return { kind: 'refused', detail: formatError(error) };
  }
}
