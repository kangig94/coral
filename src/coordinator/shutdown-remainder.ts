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
  type ShutdownRemainderStageObserver,
  type ShutdownRemainderRecord,
} from '../infra/shutdown-remainder-record.js';
import { nowIsoString } from '../infra/time.js';
import type { ShutdownMode, ShutdownReason } from '../infra/persisted-scalar-contracts.js';
import type { ProcessIncarnation } from '../infra/node-process.js';
import type { ShutdownUndischarged } from './shutdown-settlement.js';

const MAX_SHUTDOWN_REMAINDER_RECORDS = 32;

type ShutdownRemainderPruneRuntime = Readonly<{
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'renameSync' | 'statSync' | 'unlinkSync'>;
  runDir: string;
  observeStageWriter?: ShutdownRemainderStageObserver;
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

export type ShutdownRemainderPruneDisposition =
  | Readonly<{ kind: 'stage-ownership-classified' }>
  | Readonly<{ kind: 'stage-ownership-held'; stageNames: readonly string[] }>
  | Readonly<{ kind: 'prune-refused' }>;

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
  let pruneRefused = false;
  try {
    const retainedStages: { name: string; age: RecordAge }[] = [];
    const observeStageWriter: ShutdownRemainderStageObserver = runtime.observeStageWriter ?? (() => 'unknown');
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
      const writerObservation = observeStageWriter(stage.writer);
      if (writerObservation === 'alive') {
        reobservableStageNames.add(name);
        continue;
      }
      if (writerObservation === 'unknown') {
        reobservableStageNames.add(name);
        retainedStages.push({ name, age });
        continue;
      }
      if (stage.partial) {
        try {
          runtime.storage.unlinkSync(path);
        } catch {
          pruneRefused = true;
          retainedStages.push({ name, age });
        }
        continue;
      }
      const classification = classifyShutdownRemainderFile(runtime.storage, path);
      if (classification.kind === 'vanished') continue;
      if (classification.kind === 'readable' && classification.record.instanceId === stage.instanceId) {
        try {
          runtime.storage.renameSync(path, join(directory, `${stage.instanceId}.json`));
          continue;
        } catch {
          pruneRefused = true;
        }
      }
      retainedStages.push({ name, age });
    }
    retainedStages.sort(byRetentionOrder);
    for (const { name } of retainedStages.slice(MAX_SHUTDOWN_REMAINDER_RECORDS)) {
      try {
        runtime.storage.unlinkSync(join(directory, name));
        reobservableStageNames.delete(name);
        backendLog.warn(`shutdown remainder stage ${name} discarded beyond the retention bound`);
      } catch {
        pruneRefused = true;
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
          backendLog.warn(`shutdown remainder record ${name} discarded: content is not valid JSON`);
        } catch {
          pruneRefused = true;
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
          backendLog.warn(`shutdown remainder record ${name} discarded: filename does not match instance identity`);
        } catch {
          pruneRefused = true;
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
      } catch {
        pruneRefused = true;
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
        backendLog.warn(
          `shutdown remainder record ${name} discarded: persistently unreadable beyond the retention bound`,
        );
      } catch {
        pruneRefused = true;
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
        backendLog.warn(
          `shutdown remainder record ${name} discarded: unsupported by this build's schema, beyond the retention bound`,
        );
      } catch {
        pruneRefused = true;
      }
    }
    if (pruneRefused) return { kind: 'prune-refused' };
    const stageNames = [...reobservableStageNames].sort((left, right) => left.localeCompare(right));
    return stageNames.length === 0
      ? { kind: 'stage-ownership-classified' }
      : { kind: 'stage-ownership-held', stageNames };
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') return { kind: 'stage-ownership-classified' };
    return { kind: 'prune-refused' };
  }
}

const SHUTDOWN_REMAINDER_REOBSERVATION_MS = 1_000;

/** Keeps at most one unref'ed re-observation pending; `stop` makes scheduling terminal. */
export function createShutdownRemainderPruner(
  runtime: ShutdownRemainderPruneRuntime & Readonly<{ time: Pick<TimePort, 'clearTimeout' | 'setTimeout'> }>,
): Readonly<{ start(): void; stop(): void }> {
  let timer: TimerHandle | null = null;
  let stopped = false;

  const pruneNow = (): void => {
    if (stopped) return;
    if (timer !== null) runtime.time.clearTimeout(timer);
    timer = null;
    const disposition = pruneShutdownRemainderRecords(runtime);
    if (!stopped && disposition.kind !== 'stage-ownership-classified') {
      timer = runtime.time.setTimeout(() => {
        timer = null;
        pruneNow();
      }, SHUTDOWN_REMAINDER_REOBSERVATION_MS);
      timer.unref?.();
    }
  };

  return {
    start: pruneNow,
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
