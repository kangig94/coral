import { join } from 'node:path';

import { backendLog } from '../infra/backend-log.js';
import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  serializeThrown,
  thrownErrnoCode,
  type SerializedThrown,
} from '../infra/error-format.js';
import { sha256Hex } from '../infra/hash.js';
import type { StoragePath, StoragePort, TimePort, TimerHandle } from '../infra/port-types.js';
import {
  classifyShutdownRemainderDirectoryEntry,
  classifyShutdownRemainderFile,
  SHUTDOWN_REMAINDER_SCAN_LIMIT,
  shutdownRemainderCleanupSubject,
  shutdownRemainderCleanupRefusal,
  shutdownRemainderDirectoryEntryPath,
  shutdownRemainderFilesystemSubject,
  shutdownRemainderStageName,
  shutdownRemainderRecordDirectory,
  type ShutdownRemainderCleanupRefusal,
  type ShutdownRemainderCleanupIncarnation,
  type ShutdownRemainderCleanupSubject,
  type ShutdownRemainderRecord,
  type ShutdownRemainderStageObservation,
  type ShutdownRemainderStageWriter,
} from '../infra/shutdown-remainder-record.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from '../infra/persisted-scalar-contracts.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { ShutdownUndischarged } from './shutdown-settlement.js';

const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type RecordAge = Readonly<{ kind: 'known'; mtimeMs: number }> | Readonly<{ kind: 'unknown' }>;

type ShutdownRemainderDeferralCause =
  | 'age-unobservable'
  | 'content-unreadable'
  | 'content-unsupported'
  | 'malformed-stage'
  | 'stage-publication-unavailable'
  | 'stage-writer-unobservable';

type ShutdownRemainderCapacityTruncationCause = Extract<
  ShutdownRemainderDeferralCause,
  'age-unobservable' | 'content-unreadable' | 'content-unsupported'
>;

function isShutdownRemainderCapacityTruncationCause(
  cause: ShutdownRemainderDeferralCause,
): cause is ShutdownRemainderCapacityTruncationCause {
  return cause === 'age-unobservable' || cause === 'content-unreadable' || cause === 'content-unsupported';
}

export type ShutdownRemainderDeferredSubject = Readonly<{
  subject: ShutdownRemainderCleanupSubject;
  cause: ShutdownRemainderDeferralCause;
  successor: Readonly<{ owner: 'next-coordinator-start'; retry: 'once' }>;
}>;

export type ShutdownRemainderCapacityTruncation = Readonly<{
  authority: 'bounded-shutdown-remainder-store';
  selection: 'decodable-first-then-bytewise-subject-order';
  lost: readonly Readonly<{
    subject: ShutdownRemainderCleanupSubject;
    cause: ShutdownRemainderCapacityTruncationCause;
  }>[];
  retainedRecordCount: number;
  survivingEvidence: 'subject-identity-and-cause';
}>;

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
  | Readonly<{
      kind: 'refused';
      operation: 'publish';
      code: 'write-returned-false' | 'filesystem-operation-failed';
      correlation: string;
      diagnostic: SerializedThrown;
    }>
  | Readonly<{
      kind: 'verification-unavailable';
      operation: 'verify-publication';
      code: 'filesystem-operation-failed';
      correlation: string;
      diagnostic: SerializedThrown;
    }>;

function shutdownRemainderWriteFailure<
  Operation extends 'publish' | 'verify-publication',
  Code extends 'write-returned-false' | 'filesystem-operation-failed',
>(
  operation: Operation,
  code: Code,
  error: unknown,
): Readonly<{
  operation: Operation;
  code: Code;
  correlation: string;
  diagnostic: SerializedThrown;
}> {
  const diagnostic = serializeThrown(error);
  return {
    operation,
    code,
    correlation: sha256Hex(`${operation}\0${code}\0${JSON.stringify(diagnostic)}`),
    diagnostic,
  };
}

type ShutdownRemainderCleanupDisposition =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{
      kind: 'deferred';
      subjects: readonly ShutdownRemainderDeferredSubject[];
    }>
  | Readonly<{
      kind: 'truncated';
      truncation: ShutdownRemainderCapacityTruncation;
      deferredSubjects: readonly ShutdownRemainderDeferredSubject[];
    }>
  | Readonly<{
      kind: 'refused';
      refusals: readonly ShutdownRemainderCleanupRefusal[];
      unreportedRefusalCount?: number;
      deferredSubjects?: readonly ShutdownRemainderDeferredSubject[];
      truncation?: ShutdownRemainderCapacityTruncation;
    }>;

export type ShutdownRemainderPruneDisposition = Readonly<{
  stageOwnership:
    | Readonly<{ kind: 'classified' }>
    | Readonly<{ kind: 'held'; subjectCorrelations: readonly string[] }>
    | Readonly<{ kind: 'unclassified'; subjectCorrelations: readonly string[] }>;
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
  left: Readonly<{ rawName: Buffer; age: RecordAge; deferred: ShutdownRemainderDeferredSubject | null }>,
  right: Readonly<{ rawName: Buffer; age: RecordAge; deferred: ShutdownRemainderDeferredSubject | null }>,
): number {
  const leftRank = left.deferred === null ? 1 : left.deferred.cause === 'age-unobservable' ? 0 : 2;
  const rightRank = right.deferred === null ? 1 : right.deferred.cause === 'age-unobservable' ? 0 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.age.kind === 'known' && right.age.kind === 'known') {
    return right.age.mtimeMs - left.age.mtimeMs || Buffer.compare(right.rawName, left.rawName);
  }
  return Buffer.compare(right.rawName, left.rawName);
}

type CleanupRefusalCollection = {
  readonly bySubject: Map<
    string,
    Readonly<{ path: StoragePath; rawSubject: string | Uint8Array; refusal: ShutdownRemainderCleanupRefusal }>
  >;
};

function cleanupRefusalCollection(): CleanupRefusalCollection {
  return {
    bySubject: new Map(),
  };
}

function nextCleanupRefusalSnapshotOrder(
  previousOrder: readonly string[],
  current: CleanupRefusalCollection['bySubject'],
  reportedSubjects: ReadonlySet<string>,
  observedAtMs: number,
): readonly string[] {
  if (previousOrder.length === 0) {
    const ordered = [...current.keys()].sort((left, right) => left.localeCompare(right));
    const cohortCount = Math.ceil(ordered.length / SHUTDOWN_REMAINDER_SCAN_LIMIT);
    if (cohortCount <= 1) return ordered;
    const cohort = Math.floor(observedAtMs / SHUTDOWN_REMAINDER_REOBSERVATION_MS) % cohortCount;
    const start = cohort * SHUTDOWN_REMAINDER_SCAN_LIMIT;
    return [...ordered.slice(start), ...ordered.slice(0, start)];
  }
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
  return [
    ...retained.filter((subject) => !reportedSubjects.has(subject)),
    ...retained.filter((subject) => reportedSubjects.has(subject)),
  ];
}

function forgetCleanupFailure(collection: CleanupRefusalCollection, key: string): void {
  collection.bySubject.delete(key);
}

type CleanupSubjectObservation =
  | Readonly<{
      kind: 'observed';
      incarnation: ShutdownRemainderCleanupIncarnation;
      subject: ShutdownRemainderCleanupSubject;
    }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unobservable'; error: unknown; subject: ShutdownRemainderCleanupSubject }>;

function observeCleanupSubject(
  runtime: ShutdownRemainderPruneRuntime,
  path: StoragePath,
  rawSubject: string | Uint8Array,
): CleanupSubjectObservation {
  try {
    const incarnation = runtime.storage.lstatSync(path, { bigint: true });
    return {
      kind: 'observed',
      incarnation,
      subject: shutdownRemainderCleanupSubject(rawSubject, incarnation),
    };
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unobservable', error, subject: shutdownRemainderFilesystemSubject(rawSubject) };
  }
}

function recordCleanupFailure(
  collection: CleanupRefusalCollection,
  key: string,
  path: StoragePath,
  subject: string | Uint8Array,
  operation: ShutdownRemainderCleanupRefusal['cause']['operation'],
  error: unknown,
  incarnation?: ShutdownRemainderCleanupIncarnation,
): 'absent' | 'refused' {
  const refusal = shutdownRemainderCleanupRefusal(subject, operation, error, incarnation);
  if (refusal === null) {
    forgetCleanupFailure(collection, key);
    return 'absent';
  }
  collection.bySubject.set(key, { path, rawSubject: subject, refusal });
  return 'refused';
}

function pruneDisposition(
  input: Readonly<{
    stageOwnershipClassified: boolean;
    reobservableStageNames: ReadonlySet<string>;
    cleanupRefusals: CleanupRefusalCollection;
    deferredSubjects: ReadonlyMap<string, ShutdownRemainderDeferredSubject>;
    truncatedSubjects: readonly ShutdownRemainderCapacityTruncation['lost'][number][];
    retainedRecordCount: number;
  }>,
): ShutdownRemainderPruneDisposition {
  const stageSubjectCorrelations = [...input.reobservableStageNames].sort((left, right) => left.localeCompare(right));
  const refusals: ShutdownRemainderCleanupRefusal[] = [];
  for (const { refusal } of input.cleanupRefusals.bySubject.values()) {
    if (refusals.length === SHUTDOWN_REMAINDER_SCAN_LIMIT) break;
    refusals.push(refusal);
  }
  const unreportedRefusalCount = input.cleanupRefusals.bySubject.size - refusals.length;
  const deferredSubjects = [...input.deferredSubjects.values()].sort((left, right) =>
    left.subject.identity.localeCompare(right.subject.identity),
  );
  const truncation: ShutdownRemainderCapacityTruncation | undefined =
    input.truncatedSubjects.length === 0
      ? undefined
      : {
          authority: 'bounded-shutdown-remainder-store',
          selection: 'decodable-first-then-bytewise-subject-order',
          lost: [...input.truncatedSubjects],
          retainedRecordCount: input.retainedRecordCount,
          survivingEvidence: 'subject-identity-and-cause',
        };
  let cleanup: ShutdownRemainderCleanupDisposition;
  if (refusals.length > 0 || unreportedRefusalCount > 0) {
    cleanup = {
      kind: 'refused',
      refusals,
      ...(unreportedRefusalCount === 0 ? {} : { unreportedRefusalCount }),
      ...(deferredSubjects.length === 0 ? {} : { deferredSubjects }),
      ...(truncation === undefined ? {} : { truncation }),
    };
  } else if (truncation !== undefined) {
    cleanup = { kind: 'truncated', truncation, deferredSubjects };
  } else if (deferredSubjects.length > 0) {
    cleanup = { kind: 'deferred', subjects: deferredSubjects };
  } else {
    cleanup = { kind: 'complete' };
  }
  return {
    stageOwnership: input.stageOwnershipClassified
      ? stageSubjectCorrelations.length === 0
        ? { kind: 'classified' }
        : { kind: 'held', subjectCorrelations: stageSubjectCorrelations }
      : { kind: 'unclassified', subjectCorrelations: stageSubjectCorrelations },
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
  previousDeferredSubjects: ReadonlyMap<string, ShutdownRemainderDeferredSubject> = new Map(),
): Readonly<{
  disposition: ShutdownRemainderPruneDisposition;
  cleanupRefusalsByName: CleanupRefusalCollection['bySubject'];
  resolvedCleanupSubjectNames: ReadonlySet<string>;
  checkedCleanupSubjectNames: ReadonlySet<string>;
  absentCleanupSubjectNames: ReadonlySet<string>;
  deferredSubjectsByName: ReadonlyMap<string, ShutdownRemainderDeferredSubject>;
}> {
  const directory = shutdownRemainderRecordDirectory(runtime.runDir);
  const directoryKey = shutdownRemainderFilesystemSubject(directory).identity;
  const reobservableStageNames = new Set<string>();
  const cleanupRefusals = cleanupRefusalCollection();
  const resolvedCleanupSubjectNames = new Set<string>();
  const checkedCleanupSubjectNames = new Set<string>();
  const absentCleanupSubjectNames = new Set<string>();
  const deferredSubjects = new Map<string, ShutdownRemainderDeferredSubject>();
  const truncatedSubjects: ShutdownRemainderCapacityTruncation['lost'][number][] = [];
  let retainedRecordCount = 0;
  const result = (
    stageOwnershipClassified: boolean,
  ): Readonly<{
    disposition: ShutdownRemainderPruneDisposition;
    cleanupRefusalsByName: CleanupRefusalCollection['bySubject'];
    resolvedCleanupSubjectNames: ReadonlySet<string>;
    checkedCleanupSubjectNames: ReadonlySet<string>;
    absentCleanupSubjectNames: ReadonlySet<string>;
    deferredSubjectsByName: ReadonlyMap<string, ShutdownRemainderDeferredSubject>;
  }> => ({
    disposition: pruneDisposition({
      stageOwnershipClassified,
      reobservableStageNames,
      cleanupRefusals,
      deferredSubjects,
      truncatedSubjects,
      retainedRecordCount,
    }),
    cleanupRefusalsByName: new Map(cleanupRefusals.bySubject),
    resolvedCleanupSubjectNames: new Set(resolvedCleanupSubjectNames),
    checkedCleanupSubjectNames: new Set(checkedCleanupSubjectNames),
    absentCleanupSubjectNames: new Set(absentCleanupSubjectNames),
    deferredSubjectsByName: new Map(deferredSubjects),
  });
  const resolveCleanupFailure = (key: string): void => {
    forgetCleanupFailure(cleanupRefusals, key);
    if (previousCleanupRefusals.has(key)) resolvedCleanupSubjectNames.add(key);
  };
  const defer = (
    key: string,
    subject: ShutdownRemainderCleanupSubject,
    cause: ShutdownRemainderDeferralCause,
  ): ShutdownRemainderDeferredSubject => {
    const deferred = { subject, cause, successor: { owner: 'next-coordinator-start', retry: 'once' } } as const;
    deferredSubjects.set(key, deferred);
    reobservableStageNames.delete(key);
    return deferred;
  };
  try {
    const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
    const initialNames = runtime.storage.readdirSync(directory, { encoding: 'buffer' }).map((rawName) => {
      const bytes = rawName;
      const name = bytes.toString('utf8');
      return {
        name,
        path: shutdownRemainderDirectoryEntryPath(directory, bytes),
        rawName: bytes,
      };
    });
    if (previousCleanupRefusals.get(directoryKey)?.refusal.cause.operation === 'scan-directory') {
      resolvedCleanupSubjectNames.add(directoryKey);
    }
    for (const { name, path, rawName } of initialNames) {
      const entry = classifyShutdownRemainderDirectoryEntry(name);
      if (entry.kind === 'other') continue;
      if (entry.kind === 'record') continue;
      const subjectObservation = observeCleanupSubject(runtime, path, rawName);
      const subject =
        subjectObservation.kind === 'absent' ? shutdownRemainderFilesystemSubject(rawName) : subjectObservation.subject;
      const key = subject.identity;
      checkedCleanupSubjectNames.add(key);
      forgetCleanupFailure(cleanupRefusals, key);
      if (subjectObservation.kind === 'absent') {
        absentCleanupSubjectNames.add(key);
        continue;
      }
      const previousDeferral = previousDeferredSubjects.get(key);
      if (previousDeferral !== undefined) {
        defer(key, subject, previousDeferral.cause);
        continue;
      }
      if (entry.kind === 'malformed-stage') {
        defer(key, subject, 'malformed-stage');
        continue;
      }
      const stage = entry.stage;
      const writerObservation = observeStageWriter(stage.writer, name);
      if (stage.partial) {
        if (writerObservation === 'alive') {
          reobservableStageNames.add(key);
          continue;
        }
        if (writerObservation === 'unknown') {
          defer(key, subject, 'stage-writer-unobservable');
          continue;
        }
        try {
          runtime.storage.unlinkSync(path);
          resolveCleanupFailure(key);
        } catch (error: unknown) {
          if (
            recordCleanupFailure(
              cleanupRefusals,
              key,
              path,
              rawName,
              'delete',
              error,
              subjectObservation.kind === 'observed' ? subjectObservation.incarnation : undefined,
            ) === 'absent'
          ) {
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
          if (
            recordCleanupFailure(
              cleanupRefusals,
              key,
              path,
              rawName,
              'promote',
              error,
              subjectObservation.kind === 'observed' ? subjectObservation.incarnation : undefined,
            ) === 'absent'
          ) {
            absentCleanupSubjectNames.add(key);
            continue;
          }
        }
      }
      if (writerObservation === 'alive') {
        reobservableStageNames.add(key);
        continue;
      }
      if (!cleanupRefusals.bySubject.has(key)) defer(key, subject, 'stage-publication-unavailable');
    }

    const retentionCandidates: {
      key: string;
      name: string;
      path: Buffer;
      rawName: Buffer;
      age: RecordAge;
      subject: ShutdownRemainderCleanupSubject;
      deferred: ShutdownRemainderDeferredSubject | null;
      incarnation?: ShutdownRemainderCleanupIncarnation;
    }[] = [];
    for (const { name, path, rawName } of initialNames) {
      if (classifyShutdownRemainderDirectoryEntry(name).kind !== 'record') continue;
      const subjectObservation = observeCleanupSubject(runtime, path, rawName);
      const subject =
        subjectObservation.kind === 'absent' ? shutdownRemainderFilesystemSubject(rawName) : subjectObservation.subject;
      const key = subject.identity;
      forgetCleanupFailure(cleanupRefusals, key);
      if (subjectObservation.kind === 'absent') {
        absentCleanupSubjectNames.add(key);
        continue;
      }
      checkedCleanupSubjectNames.add(key);

      const previousDeferral = previousDeferredSubjects.get(key);
      if (previousDeferral !== undefined) {
        retentionCandidates.push({
          key,
          name,
          path,
          rawName,
          age: { kind: 'unknown' },
          subject,
          deferred: defer(key, subject, previousDeferral.cause),
          ...(subjectObservation.kind === 'observed' ? { incarnation: subjectObservation.incarnation } : {}),
        });
        continue;
      }

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
            `shutdown remainder cleanup correlation=${subject.identity} class=directory-entry cause=corrupt-record operation=delete outcome=discarded`,
          );
        } catch (error: unknown) {
          if (
            recordCleanupFailure(
              cleanupRefusals,
              key,
              path,
              rawName,
              'delete',
              error,
              subjectObservation.kind === 'observed' ? subjectObservation.incarnation : undefined,
            ) === 'absent'
          ) {
            absentCleanupSubjectNames.add(key);
          }
        }
        continue;
      }
      if (classification.kind === 'unsupported') {
        retentionCandidates.push({
          key,
          name,
          path,
          rawName,
          age: { kind: 'unknown' },
          subject,
          deferred: defer(key, subject, 'content-unsupported'),
          ...(subjectObservation.kind === 'observed' ? { incarnation: subjectObservation.incarnation } : {}),
        });
        continue;
      }
      if (classification.kind === 'unreadable') {
        retentionCandidates.push({
          key,
          name,
          path,
          rawName,
          age: { kind: 'unknown' },
          subject,
          deferred: defer(key, subject, 'content-unreadable'),
          ...(subjectObservation.kind === 'observed' ? { incarnation: subjectObservation.incarnation } : {}),
        });
        continue;
      }
      if (name !== `${classification.record.instanceId}.json`) {
        try {
          runtime.storage.unlinkSync(path);
          resolveCleanupFailure(key);
          backendLog.warn(
            `shutdown remainder cleanup correlation=${subject.identity} class=directory-entry cause=identity-mismatch operation=delete outcome=discarded`,
          );
        } catch (error: unknown) {
          if (
            recordCleanupFailure(
              cleanupRefusals,
              key,
              path,
              rawName,
              'delete',
              error,
              subjectObservation.kind === 'observed' ? subjectObservation.incarnation : undefined,
            ) === 'absent'
          ) {
            absentCleanupSubjectNames.add(key);
          }
        }
        continue;
      }
      let age: RecordAge;
      let deferred: ShutdownRemainderDeferredSubject | null = null;
      try {
        age = { kind: 'known', mtimeMs: runtime.storage.statSync(path).mtimeMs };
      } catch (error: unknown) {
        age = { kind: 'unknown' };
        deferred = defer(key, subject, 'age-unobservable');
        if (
          recordCleanupFailure(
            cleanupRefusals,
            key,
            path,
            rawName,
            'inspect-age',
            error,
            subjectObservation.kind === 'observed' ? subjectObservation.incarnation : undefined,
          ) === 'absent'
        ) {
          absentCleanupSubjectNames.add(key);
          continue;
        }
      }
      if (age.kind === 'known' && previousCleanupRefusals.has(key)) resolvedCleanupSubjectNames.add(key);
      retentionCandidates.push({
        key,
        name,
        path,
        rawName,
        age,
        subject,
        deferred,
        ...(subjectObservation.kind === 'observed' ? { incarnation: subjectObservation.incarnation } : {}),
      });
    }
    retentionCandidates.sort(byRetentionOrder);
    retainedRecordCount = Math.min(retentionCandidates.length, MAX_SHUTDOWN_REMAINDER_RECORDS);
    for (const { key, path, rawName, incarnation, deferred } of retentionCandidates.slice(
      MAX_SHUTDOWN_REMAINDER_RECORDS,
    )) {
      try {
        runtime.storage.unlinkSync(path);
        resolveCleanupFailure(key);
        if (deferred !== null && isShutdownRemainderCapacityTruncationCause(deferred.cause)) {
          deferredSubjects.delete(key);
          truncatedSubjects.push({ subject: deferred.subject, cause: deferred.cause });
        }
      } catch (error: unknown) {
        if (recordCleanupFailure(cleanupRefusals, key, path, rawName, 'delete', error, incarnation) === 'absent') {
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
        deferredSubjectsByName: new Map(),
      };
    }
    for (const [key, deferred] of previousDeferredSubjects) deferredSubjects.set(key, deferred);
    void recordCleanupFailure(cleanupRefusals, directoryKey, directory, directory, 'scan-directory', error);
    return result(false);
  }
}

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 60_000;

export function logShutdownRemainderStartupPrune(disposition: ShutdownRemainderPruneDisposition): void {
  const stage =
    disposition.stageOwnership.kind === 'classified'
      ? 'stageOwnership=classified'
      : `stageOwnership=${disposition.stageOwnership.kind} stageCorrelations=${disposition.stageOwnership.subjectCorrelations.join(',')}`;
  let cleanup: string;
  switch (disposition.cleanup.kind) {
    case 'complete':
      cleanup = 'cleanup=complete';
      break;
    case 'deferred':
      cleanup = `cleanup=deferred owner=next-coordinator-start retry=once subjects=${disposition.cleanup.subjects.length}`;
      break;
    case 'truncated':
      cleanup = `cleanup=truncated authority=${disposition.cleanup.truncation.authority} lost=${disposition.cleanup.truncation.lost.length} retained=${disposition.cleanup.truncation.retainedRecordCount} survivingEvidence=${disposition.cleanup.truncation.survivingEvidence}`;
      break;
    case 'refused':
      cleanup = [
        'cleanup=refused',
        'owner=coordinator',
        'successor=periodic-cleanup-retry',
        ...disposition.cleanup.refusals.map(
          (refusal) =>
            `correlation=${refusal.subject.identity}:class=directory-entry:cause=${refusal.cause.kind}:operation=${refusal.cause.operation}:errno=${refusal.cause.kind === 'system-error' ? refusal.cause.code : 'unavailable'}`,
        ),
        ...(disposition.cleanup.unreportedRefusalCount === undefined
          ? []
          : [`unreported=${disposition.cleanup.unreportedRefusalCount}`]),
        ...(disposition.cleanup.deferredSubjects === undefined
          ? []
          : [`deferred=${disposition.cleanup.deferredSubjects.length}`]),
        ...(disposition.cleanup.truncation === undefined
          ? []
          : [
              `authority=${disposition.cleanup.truncation.authority}`,
              `lost=${disposition.cleanup.truncation.lost.length}`,
              `survivingEvidence=${disposition.cleanup.truncation.survivingEvidence}`,
            ]),
      ].join(' ');
      break;
  }
  backendLog.info(`Shutdown remainder startup prune: ${stage} ${cleanup}`);
}

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
  let deferredSubjectsByName = new Map<string, ShutdownRemainderDeferredSubject>();
  let cleanupRefusalSnapshotOrder: readonly string[] = [];
  const reportedCleanupRefusalSubjects = new Set<string>();
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
      deferredSubjectsByName: currentDeferredSubjects,
    } = pruneShutdownRemainderRecordsWithRefusals(runtime, previousCleanupRefusals, deferredSubjectsByName);
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
      const observation = observeCleanupSubject(runtime, entry.path, entry.rawSubject);
      if (observation.kind === 'observed') {
        if (observation.subject.identity !== name) {
          absentRefusalCount += 1;
          continue;
        }
        uncheckedRefusalCount += 1;
        retainedCleanupRefusals.set(name, entry);
        continue;
      }
      if (observation.kind === 'absent') {
        absentRefusalCount += 1;
        continue;
      }
      unobservableRefusalCount += 1;
      retainedCleanupRefusals.set(name, entry);
    }
    const observedAtMs = runtime.time.now?.() ?? 0;
    cleanupRefusalSnapshotOrder = nextCleanupRefusalSnapshotOrder(
      cleanupRefusalSnapshotOrder,
      retainedCleanupRefusals,
      reportedCleanupRefusalSubjects,
      observedAtMs,
    );
    cleanupRefusalsByName = retainedCleanupRefusals;
    deferredSubjectsByName = new Map(currentDeferredSubjects);
    resolvedCleanupRefusalCount = resolvedRefusalCount;
    absentCleanupRefusalCount = absentRefusalCount;
    unobservableCleanupRefusalCount = unobservableRefusalCount;
    uncheckedCleanupRefusalCount = uncheckedRefusalCount;
    observedAt = runtime.time.now === undefined ? null : nowIsoString(observedAtMs);
    return result;
  };
  const readCleanupRefusalSnapshot = (): ShutdownRemainderCleanupSnapshot => {
    const refusals = cleanupRefusalSnapshotOrder
      .slice(0, SHUTDOWN_REMAINDER_SCAN_LIMIT)
      .map((subject) => cleanupRefusalsByName.get(subject)?.refusal)
      .filter((refusal): refusal is ShutdownRemainderCleanupRefusal => refusal !== undefined);
    for (const subject of cleanupRefusalSnapshotOrder.slice(0, refusals.length)) {
      reportedCleanupRefusalSubjects.add(subject);
    }
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
    runtime.storage.mkdirSync(directory, { recursive: true });
    if (
      !runtime.storage.writeAtomicSync(stagePath, serializedRecord, {
        encoding: 'utf-8',
        mode: 0o600,
      })
    ) {
      removeStage();
      return {
        kind: 'refused',
        ...shutdownRemainderWriteFailure('publish', 'write-returned-false', 'record publication returned false'),
      };
    }
    try {
      runtime.storage.renameSync(stagePath, path);
    } catch (error: unknown) {
      if (thrownErrnoCode(error) === 'ENOENT') {
        try {
          if (runtime.storage.readFileSync(path, 'utf-8') === serializedRecord) return { kind: 'published' };
        } catch (verificationError: unknown) {
          removeStage();
          return {
            kind: 'verification-unavailable',
            ...shutdownRemainderWriteFailure('verify-publication', 'filesystem-operation-failed', verificationError),
          };
        }
      }
      throw error;
    }
    return { kind: 'published' };
  } catch (error: unknown) {
    removeStage();
    return {
      kind: 'refused',
      ...shutdownRemainderWriteFailure('publish', 'filesystem-operation-failed', error),
    };
  }
}
