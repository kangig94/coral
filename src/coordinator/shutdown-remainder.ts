import { join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  formatError,
  thrownErrnoCode,
} from '../infra/error-format.js';
import type { StoragePath, StoragePort, TimePort, TimerHandle } from '../infra/port-types.js';
import {
  classifyShutdownRemainderDirectoryEntry,
  classifyShutdownRemainderFile,
  SHUTDOWN_REMAINDER_SCAN_LIMIT,
  shutdownRemainderCleanupRefusal,
  shutdownRemainderDirectoryEntryPath,
  shutdownRemainderFilesystemSubject,
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
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'readdirSync' | 'renameSync' | 'statSync' | 'unlinkSync'>;
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
}>;

export type ShutdownRemainderCleanupSnapshot = Readonly<{
  refusals: readonly ShutdownRemainderCleanupRefusal[];
  resolvedRefusalCount: number;
  absentRefusalCount: number;
  unobservableRefusalCount: number;
  uncheckedRefusalCount: number;
  overflowedRefusalCount: number;
  observedAt: string | null;
  retry:
    | Readonly<{ state: 'scheduled'; owner: 'coordinator' }>
    | Readonly<{ state: 'stopped-until-restart'; owner: 'next-coordinator-start' }>;
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
  readonly bySubject: Map<string, Readonly<{ path: StoragePath; refusal: ShutdownRemainderCleanupRefusal }>>;
};

function cleanupRefusalCollection(): CleanupRefusalCollection {
  return {
    bySubject: new Map(),
  };
}

function nextCleanupRefusalSnapshotOrder(
  previousOrder: readonly string[],
  current: CleanupRefusalCollection['bySubject'],
): readonly string[] {
  const rotated = [
    ...previousOrder.slice(SHUTDOWN_REMAINDER_SCAN_LIMIT),
    ...previousOrder.slice(0, SHUTDOWN_REMAINDER_SCAN_LIMIT),
  ];
  const retained = rotated.filter((subject) => current.has(subject));
  const known = new Set(retained);
  for (const subject of current.keys()) {
    if (known.has(subject)) continue;
    retained.push(subject);
    known.add(subject);
  }
  return retained;
}

function forgetCleanupFailure(collection: CleanupRefusalCollection, key: string): void {
  collection.bySubject.delete(key);
}

function recordCleanupFailure(
  collection: CleanupRefusalCollection,
  key: string,
  path: StoragePath,
  subject: string | Uint8Array,
  operation: ShutdownRemainderCleanupRefusal['cause']['operation'],
  error: unknown,
): 'absent' | 'refused' {
  const refusal = shutdownRemainderCleanupRefusal(subject, operation, error);
  if (refusal === null) {
    forgetCleanupFailure(collection, key);
    return 'absent';
  }
  collection.bySubject.set(key, { path, refusal });
  return 'refused';
}

function pruneDisposition(
  input: Readonly<{
    stageOwnershipClassified: boolean;
    reobservableStageNames: ReadonlySet<string>;
    cleanupRefusals: CleanupRefusalCollection;
    quarantinedSubjectNames: ReadonlySet<string>;
  }>,
): ShutdownRemainderPruneDisposition {
  const stageNames = [...input.reobservableStageNames].sort((left, right) => left.localeCompare(right));
  const refusals: ShutdownRemainderCleanupRefusal[] = [];
  for (const { refusal } of input.cleanupRefusals.bySubject.values()) {
    if (refusals.length === SHUTDOWN_REMAINDER_SCAN_LIMIT) break;
    refusals.push(refusal);
  }
  const unreportedRefusalCount = input.cleanupRefusals.bySubject.size - refusals.length;
  const quarantinedNames = [...input.quarantinedSubjectNames].sort((left, right) => left.localeCompare(right));
  let cleanup: ShutdownRemainderCleanupDisposition;
  if (refusals.length > 0 || unreportedRefusalCount > 0) {
    cleanup = {
      kind: 'refused',
      refusals,
      ...(unreportedRefusalCount === 0 ? {} : { unreportedRefusalCount }),
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
  };
}

export function pruneShutdownRemainderRecords(
  runtime: ShutdownRemainderPruneRuntime,
): ShutdownRemainderPruneDisposition {
  return pruneShutdownRemainderRecordsWithRefusals(runtime).disposition;
}

function pruneShutdownRemainderRecordsWithRefusals(
  runtime: ShutdownRemainderPruneRuntime,
  previousCleanupRefusals: CleanupRefusalCollection['bySubject'] = new Map(),
): Readonly<{
  disposition: ShutdownRemainderPruneDisposition;
  cleanupRefusalsByName: CleanupRefusalCollection['bySubject'];
  resolvedCleanupSubjectNames: ReadonlySet<string>;
  checkedCleanupSubjectNames: ReadonlySet<string>;
  absentCleanupSubjectNames: ReadonlySet<string>;
}> {
  const directory = shutdownRemainderRecordDirectory(runtime.runDir);
  const reobservableStageNames = new Set<string>();
  const cleanupRefusals = cleanupRefusalCollection();
  const resolvedCleanupSubjectNames = new Set<string>();
  const checkedCleanupSubjectNames = new Set<string>();
  const absentCleanupSubjectNames = new Set<string>();
  const quarantinedSubjectNames = new Set<string>();
  const result = (
    stageOwnershipClassified: boolean,
  ): Readonly<{
    disposition: ShutdownRemainderPruneDisposition;
    cleanupRefusalsByName: CleanupRefusalCollection['bySubject'];
    resolvedCleanupSubjectNames: ReadonlySet<string>;
    checkedCleanupSubjectNames: ReadonlySet<string>;
    absentCleanupSubjectNames: ReadonlySet<string>;
  }> => ({
    disposition: pruneDisposition({
      stageOwnershipClassified,
      reobservableStageNames,
      cleanupRefusals,
      quarantinedSubjectNames,
    }),
    cleanupRefusalsByName: new Map(cleanupRefusals.bySubject),
    resolvedCleanupSubjectNames: new Set(resolvedCleanupSubjectNames),
    checkedCleanupSubjectNames: new Set(checkedCleanupSubjectNames),
    absentCleanupSubjectNames: new Set(absentCleanupSubjectNames),
  });
  const resolveCleanupFailure = (key: string): void => {
    forgetCleanupFailure(cleanupRefusals, key);
    if (previousCleanupRefusals.has(key)) resolvedCleanupSubjectNames.add(key);
  };
  const quarantine = (key: string): void => {
    quarantinedSubjectNames.add(key);
    reobservableStageNames.delete(key);
  };
  try {
    const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
    const initialNames = runtime.storage.readdirSync(directory, { encoding: 'buffer' }).map((rawName) => {
      const bytes = rawName;
      const name = bytes.toString('utf8');
      return {
        key: Buffer.from(name).equals(bytes) ? name : `raw:${bytes.toString('hex')}`,
        name,
        path: shutdownRemainderDirectoryEntryPath(directory, bytes),
        rawName: bytes,
      };
    });
    if (previousCleanupRefusals.get(directory)?.refusal.cause.operation === 'scan-directory') {
      resolvedCleanupSubjectNames.add(directory);
    }
    for (const { key, name, path, rawName } of initialNames) {
      const entry = classifyShutdownRemainderDirectoryEntry(name);
      if (entry.kind === 'other') continue;
      if (entry.kind === 'record') continue;
      checkedCleanupSubjectNames.add(key);
      forgetCleanupFailure(cleanupRefusals, key);
      try {
        runtime.storage.lstatSync(path);
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') {
          absentCleanupSubjectNames.add(key);
          forgetCleanupFailure(cleanupRefusals, key);
          continue;
        }
      }
      if (entry.kind === 'malformed-stage') {
        quarantine(key);
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
          quarantine(key);
          continue;
        }
        try {
          runtime.storage.unlinkSync(path);
          resolveCleanupFailure(key);
        } catch (error: unknown) {
          if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'delete', error) === 'absent') {
            absentCleanupSubjectNames.add(key);
          }
        }
        continue;
      }
      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') {
        absentCleanupSubjectNames.add(key);
        forgetCleanupFailure(cleanupRefusals, key);
        continue;
      }
      if (classification.kind === 'readable' && classification.record.instanceId === stage.instanceId) {
        try {
          runtime.storage.renameSync(path, join(directory, `${stage.instanceId}.json`));
          resolveCleanupFailure(key);
          continue;
        } catch (error: unknown) {
          if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'promote', error) === 'absent') {
            absentCleanupSubjectNames.add(key);
            continue;
          }
        }
      }
      if (writerObservation === 'alive') {
        reobservableStageNames.add(name);
        continue;
      }
      if (!cleanupRefusals.bySubject.has(key)) quarantine(key);
    }

    const known: { key: string; name: string; path: Buffer; rawName: Buffer; age: RecordAge }[] = [];
    for (const { key, name, path, rawName } of initialNames) {
      if (classifyShutdownRemainderDirectoryEntry(name).kind !== 'record') continue;
      forgetCleanupFailure(cleanupRefusals, key);
      try {
        runtime.storage.lstatSync(path);
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') {
          absentCleanupSubjectNames.add(key);
          forgetCleanupFailure(cleanupRefusals, key);
          continue;
        }
      }
      checkedCleanupSubjectNames.add(key);

      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') {
        absentCleanupSubjectNames.add(key);
        forgetCleanupFailure(cleanupRefusals, key);
        continue;
      }
      if (classification.kind === 'corrupt') {
        // Constraint: a decisive decode failure (design-philosophy.md principle 11) authorizes reclaiming this
        // file regardless of age — it is deleted outright rather than competing for a slot in the retention
        // count below.
        try {
          runtime.storage.unlinkSync(path);
          resolveCleanupFailure(key);
          backendLog.warn(
            `shutdown remainder record ${shutdownRemainderFilesystemSubject(rawName).label} discarded: content is not valid JSON`,
          );
        } catch (error: unknown) {
          if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'delete', error) === 'absent') {
            absentCleanupSubjectNames.add(key);
          }
        }
        continue;
      }
      if (classification.kind === 'unsupported') {
        quarantine(key);
        continue;
      }
      if (classification.kind === 'unreadable') {
        quarantine(key);
        continue;
      }
      if (name !== `${classification.record.instanceId}.json`) {
        try {
          runtime.storage.unlinkSync(path);
          resolveCleanupFailure(key);
          backendLog.warn(
            `shutdown remainder record ${shutdownRemainderFilesystemSubject(rawName).label} discarded: filename does not match instance identity`,
          );
        } catch (error: unknown) {
          if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'delete', error) === 'absent') {
            absentCleanupSubjectNames.add(key);
          }
        }
        continue;
      }
      if (previousCleanupRefusals.has(key)) resolvedCleanupSubjectNames.add(key);
      let age: RecordAge = { kind: 'unknown' };
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch {
        age = { kind: 'unknown' };
      }
      known.push({ key, name, path, rawName, age });
    }
    known.sort(byRetentionOrder);
    for (const { key, path, rawName } of known.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(path);
        resolveCleanupFailure(key);
      } catch (error: unknown) {
        if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'delete', error) === 'absent') {
          absentCleanupSubjectNames.add(key);
        }
      }
    }
    return result(true);
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') {
      return {
        disposition: {
          stageOwnership: { kind: 'classified' },
          cleanup: { kind: 'complete' },
        },
        cleanupRefusalsByName: new Map(),
        resolvedCleanupSubjectNames: new Set(),
        checkedCleanupSubjectNames: new Set(),
        absentCleanupSubjectNames: new Set(),
      };
    }
    void recordCleanupFailure(cleanupRefusals, directory, directory, directory, 'scan-directory', error);
    return result(false);
  }
}

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 60_000;

/** Remainder maintenance must not keep the coordinator process alive. */
export function createShutdownRemainderPruner(
  runtime: ShutdownRemainderPruneRuntime &
    Readonly<{
      time: Pick<TimePort, 'clearInterval' | 'setInterval'> & Partial<Pick<TimePort, 'now'>>;
    }>,
): Readonly<{
  start(): ShutdownRemainderPruneDisposition | null;
  stop(): void;
  readCleanupRefusalSnapshot(): ShutdownRemainderCleanupSnapshot;
}> {
  let timer: TimerHandle | null = null;
  let stopped = false;
  let cleanupRefusalsByName: CleanupRefusalCollection['bySubject'] = new Map();
  let cleanupRefusalSnapshotOrder: readonly string[] = [];
  let resolvedCleanupRefusalCount = 0;
  let absentCleanupRefusalCount = 0;
  let unobservableCleanupRefusalCount = 0;
  let uncheckedCleanupRefusalCount = 0;
  let observedAt: string | null = null;
  let retry: ShutdownRemainderCleanupSnapshot['retry'] = { state: 'scheduled', owner: 'coordinator' };
  const prune = (): ShutdownRemainderPruneDisposition => {
    let resolvedRefusalCount = 0;
    let absentRefusalCount = 0;
    let unobservableRefusalCount = 0;
    let uncheckedRefusalCount = 0;
    const previousCleanupRefusals = cleanupRefusalsByName;
    const {
      disposition: result,
      cleanupRefusalsByName: currentCleanupRefusals,
      resolvedCleanupSubjectNames,
      checkedCleanupSubjectNames,
      absentCleanupSubjectNames,
    } = pruneShutdownRemainderRecordsWithRefusals(runtime, previousCleanupRefusals);
    const retainedCleanupRefusals = new Map(currentCleanupRefusals);
    for (const [name, entry] of previousCleanupRefusals) {
      if (currentCleanupRefusals.has(name)) continue;
      if (resolvedCleanupSubjectNames.has(name)) {
        resolvedRefusalCount += 1;
        continue;
      }
      if (absentCleanupSubjectNames.has(name)) {
        absentRefusalCount += 1;
        continue;
      }
      if (checkedCleanupSubjectNames.has(name)) {
        retainedCleanupRefusals.set(name, entry);
        continue;
      }
      try {
        runtime.storage.lstatSync(entry.path);
        uncheckedRefusalCount += 1;
        retainedCleanupRefusals.set(name, entry);
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') absentRefusalCount += 1;
        else {
          unobservableRefusalCount += 1;
          retainedCleanupRefusals.set(name, entry);
        }
      }
    }
    cleanupRefusalSnapshotOrder = nextCleanupRefusalSnapshotOrder(cleanupRefusalSnapshotOrder, retainedCleanupRefusals);
    cleanupRefusalsByName = retainedCleanupRefusals;
    resolvedCleanupRefusalCount = resolvedRefusalCount;
    absentCleanupRefusalCount = absentRefusalCount;
    unobservableCleanupRefusalCount = unobservableRefusalCount;
    uncheckedCleanupRefusalCount = uncheckedRefusalCount;
    observedAt = runtime.time.now === undefined ? null : nowIsoString(runtime.time.now());
    return result;
  };
  const readCleanupRefusalSnapshot = (): ShutdownRemainderCleanupSnapshot => {
    const refusals = cleanupRefusalSnapshotOrder
      .slice(0, SHUTDOWN_REMAINDER_SCAN_LIMIT)
      .map((subject) => cleanupRefusalsByName.get(subject)?.refusal)
      .filter((refusal): refusal is ShutdownRemainderCleanupRefusal => refusal !== undefined);
    return {
      refusals,
      resolvedRefusalCount: resolvedCleanupRefusalCount,
      absentRefusalCount: absentCleanupRefusalCount,
      unobservableRefusalCount: unobservableCleanupRefusalCount,
      uncheckedRefusalCount: uncheckedCleanupRefusalCount,
      overflowedRefusalCount: Math.max(0, cleanupRefusalsByName.size - SHUTDOWN_REMAINDER_SCAN_LIMIT),
      observedAt,
      retry,
    };
  };

  return {
    start: () => {
      if (stopped) return null;
      retry = { state: 'scheduled', owner: 'coordinator' };
      const disposition = prune();
      timer = runtime.time.setInterval(prune, SHUTDOWN_REMAINDER_REOBSERVATION_MS);
      timer.unref?.();
      return disposition;
    },
    stop: () => {
      stopped = true;
      retry = { state: 'stopped-until-restart', owner: 'next-coordinator-start' };
      if (timer !== null) runtime.time.clearInterval(timer);
      timer = null;
    },
    readCleanupRefusalSnapshot,
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
  const directory = shutdownRemainderRecordDirectory(runtime.runDir);
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
