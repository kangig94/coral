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
  parseShutdownRemainderQuarantineAddress,
  scanShutdownRemainderQuarantine,
  shutdownRemainderQuarantineAddress,
  shutdownRemainderQuarantineDirectory,
  shutdownRemainderQuarantineEvidencePath,
  shutdownRemainderQuarantineSlotDirectory,
  shutdownRemainderQuarantineSubjectDirectory,
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
  storage: Pick<
    StoragePort,
    'linkSync' | 'mkdirSync' | 'readFileSync' | 'readdirSync' | 'renameSync' | 'rmdirSync' | 'statSync' | 'unlinkSync'
  >;
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

export type ShutdownRemainderPruneDisposition = Readonly<{
  stageOwnership:
    | Readonly<{ kind: 'classified' }>
    | Readonly<{ kind: 'held'; stageNames: readonly string[] }>
    | Readonly<{ kind: 'unclassified'; stageNames: readonly string[] }>;
  cleanup:
    | Readonly<{ kind: 'complete' }>
    | Readonly<{ kind: 'quarantined'; subjectNames: readonly string[] }>
    | Readonly<{
        kind: 'refused';
        subjectNames: readonly string[];
        quarantinedSubjectNames?: readonly string[];
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

function removeEmptyQuarantineDirectories(
  runtime: ShutdownRemainderPruneRuntime,
  directory: string,
  address: string,
): void {
  const parsed = parseShutdownRemainderQuarantineAddress(address);
  if (parsed === null) return;
  for (const candidate of [
    shutdownRemainderQuarantineSlotDirectory(directory, parsed.subject, parsed.slot),
    shutdownRemainderQuarantineSubjectDirectory(directory, parsed.subject),
    shutdownRemainderQuarantineDirectory(directory),
  ]) {
    try {
      runtime.storage.rmdirSync(candidate);
    } catch {
      return;
    }
  }
}

function quarantineMatchesActive(
  runtime: ShutdownRemainderPruneRuntime,
  quarantinePath: string,
  activePath: string,
): boolean {
  try {
    const quarantineStat = runtime.storage.statSync(quarantinePath, { bigint: true });
    const activeStat = runtime.storage.statSync(activePath, { bigint: true });
    if (quarantineStat.dev === activeStat.dev && quarantineStat.ino === activeStat.ino) return true;
  } catch {
    // Removing the quarantine requires inode identity or equal bytes; a failed identity probe proves neither.
  }
  try {
    return runtime.storage.readFileSync(quarantinePath, 'utf-8') === runtime.storage.readFileSync(activePath, 'utf-8');
  } catch {
    return false;
  }
}

function retryShutdownRemainderQuarantine(runtime: ShutdownRemainderPruneRuntime): void {
  const directory = shutdownRemainderPath(runtime.runDir);
  let names: string[];
  try {
    names = runtime.storage.readdirSync(directory);
  } catch {
    return;
  }
  let quarantined;
  try {
    quarantined = scanShutdownRemainderQuarantine(runtime.storage, directory, new Set(names)).quarantined;
  } catch {
    return;
  }
  for (const evidence of quarantined) {
    const activePath = join(directory, evidence.subject);
    const quarantinePath = shutdownRemainderQuarantineEvidencePath(directory, evidence.address);
    let redundant: boolean;
    try {
      runtime.storage.linkSync(quarantinePath, activePath);
      redundant = true;
    } catch (error: unknown) {
      redundant = thrownErrnoCode(error) === 'EEXIST' && quarantineMatchesActive(runtime, quarantinePath, activePath);
    }
    if (!redundant) continue;
    try {
      runtime.storage.unlinkSync(quarantinePath);
    } catch {
      continue;
    }
    removeEmptyQuarantineDirectories(runtime, directory, evidence.address);
  }
}

export function pruneShutdownRemainderRecords(
  runtime: ShutdownRemainderPruneRuntime,
): ShutdownRemainderPruneDisposition {
  const directory = shutdownRemainderPath(runtime.runDir);
  const reobservableStageNames = new Set<string>();
  const refusedCleanupSubjectNames = new Set<string>();
  const quarantinedSubjectNames = new Set<string>();
  const disposition = (stageOwnershipClassified: boolean): ShutdownRemainderPruneDisposition => {
    const stageNames = [...reobservableStageNames].sort((left, right) => left.localeCompare(right));
    const subjectNames = [...refusedCleanupSubjectNames].sort((left, right) => left.localeCompare(right));
    const quarantinedNames = [...quarantinedSubjectNames].sort((left, right) => left.localeCompare(right));
    const cleanup: ShutdownRemainderPruneDisposition['cleanup'] =
      subjectNames.length > 0
        ? {
            kind: 'refused',
            subjectNames,
            ...(quarantinedNames.length === 0 ? {} : { quarantinedSubjectNames: quarantinedNames }),
          }
        : quarantinedNames.length > 0
          ? { kind: 'quarantined', subjectNames: quarantinedNames }
          : { kind: 'complete' };
    return {
      stageOwnership: stageOwnershipClassified
        ? stageNames.length === 0
          ? { kind: 'classified' }
          : { kind: 'held', stageNames }
        : { kind: 'unclassified', stageNames },
      cleanup,
    };
  };
  const quarantine = (name: string): void => {
    let slotDirectory: string | null = null;
    try {
      const subjectDirectory = shutdownRemainderQuarantineSubjectDirectory(directory, name);
      runtime.storage.mkdirSync(subjectDirectory, { recursive: true });
      let slot = 1;
      while (true) {
        slotDirectory = shutdownRemainderQuarantineSlotDirectory(directory, name, slot);
        try {
          runtime.storage.mkdirSync(slotDirectory);
          break;
        } catch (error: unknown) {
          if (thrownErrnoCode(error) !== 'EEXIST' || slot === Number.MAX_SAFE_INTEGER) throw error;
          slot += 1;
        }
      }
      const address = shutdownRemainderQuarantineAddress(name, slot);
      runtime.storage.renameSync(join(directory, name), shutdownRemainderQuarantineEvidencePath(directory, address));
      quarantinedSubjectNames.add(name);
      refusedCleanupSubjectNames.delete(name);
      reobservableStageNames.delete(name);
    } catch (error: unknown) {
      if (slotDirectory !== null) {
        try {
          runtime.storage.rmdirSync(slotDirectory);
        } catch {
          // Failure to reclaim an unused slot must not replace the subject's cleanup refusal.
        }
      }
      if (thrownErrnoCode(error) !== 'ENOENT') refusedCleanupSubjectNames.add(name);
    }
  };
  try {
    const observeStageWriter: ShutdownRemainderPruneStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
    const initialNames = runtime.storage.readdirSync(directory);
    const existingQuarantine = scanShutdownRemainderQuarantine(runtime.storage, directory, new Set(initialNames));
    for (const evidence of existingQuarantine.quarantined) quarantinedSubjectNames.add(evidence.subject);
    for (const name of initialNames) {
      const entry = classifyShutdownRemainderDirectoryEntry(name);
      if (entry.kind === 'other' || entry.kind === 'record' || entry.kind === 'quarantine') continue;
      const path = join(directory, name);
      try {
        runtime.storage.statSync(path);
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
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
          refusedCleanupSubjectNames.delete(name);
        } catch {
          refusedCleanupSubjectNames.add(name);
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
        } catch (error: unknown) {
          if (thrownErrnoCode(error) === 'ENOENT') continue;
          refusedCleanupSubjectNames.add(name);
        }
      }
      if (writerObservation === 'alive') {
        reobservableStageNames.add(name);
        continue;
      }
      quarantine(name);
    }

    const known: { name: string; age: RecordAge }[] = [];
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

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 60_000;

/** Remainder maintenance must not keep the coordinator process alive. */
export function createShutdownRemainderPruner(
  runtime: ShutdownRemainderPruneRuntime & Readonly<{ time: Pick<TimePort, 'clearInterval' | 'setInterval'> }>,
): Readonly<{ start(): ShutdownRemainderPruneDisposition | null; stop(): void }> {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const prune = (): ShutdownRemainderPruneDisposition => pruneShutdownRemainderRecords(runtime);

  return {
    start: () => {
      if (stopped) return null;
      retryShutdownRemainderQuarantine(runtime);
      const disposition = prune();
      timer = runtime.time.setInterval(prune, SHUTDOWN_REMAINDER_REOBSERVATION_MS);
      timer.unref?.();
      return disposition;
    },
    stop: () => {
      stopped = true;
      if (timer !== null) runtime.time.clearInterval(timer);
      timer = null;
    },
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
