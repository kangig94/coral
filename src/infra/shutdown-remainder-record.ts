import { join } from 'node:path';
import { z } from 'zod';

import {
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  serializedThrownIdentifierSchema,
  serializedThrownSchema,
  thrownErrnoCode,
} from './error-format.js';
import { sha256Hex } from './hash.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation, ProcessLiveness } from './node-process.js';
import { persistedProcessIncarnationSchema, SHUTDOWN_MODES, SHUTDOWN_REASONS } from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;
export const SHUTDOWN_REMAINDER_SCAN_LIMIT = 128;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ShutdownRemainderSubject = DeepReadonly<z.infer<typeof shutdownRemainderSubjectSchema>>;

type ShutdownRemainderEntry = DeepReadonly<z.infer<typeof shutdownRemainderEntrySchema>>;

type DecodedShutdownRemainderEntry = ShutdownRemainderEntry & Readonly<{ entryNumber: number }>;

export type ShutdownRemainderRecord = DeepReadonly<
  Omit<z.infer<typeof shutdownRemainderRecordEnvelopeSchema>, 'entries'> & { entries: ShutdownRemainderEntry[] }
>;

export type DecodedShutdownRemainderRecord = Omit<ShutdownRemainderRecord, 'entries'> &
  Readonly<{ entries: readonly DecodedShutdownRemainderEntry[] }>;

export type ShutdownRemainderSkippedEntry = Readonly<{
  recordInstanceId: string;
  entryNumber: number;
  label: string | null;
  owner: string | null;
}>;

export type ShutdownRemainderSkippedRecord =
  /**
   * The read was refused before any byte reached this build — a genuine unknown about the content, never
   * decisive (design-philosophy.md principle 11).
   */
  | Readonly<{ name: string; reason: 'unreadable' }>
  /**
   * The bytes were read and are not JSON at all — decisive for every build, because nothing can ever parse
   * them (design-philosophy.md principle 10/11).
   */
  | Readonly<{ name: string; reason: 'corrupt' }>
  /**
   * The bytes parsed as JSON but this build's envelope schema refused the shape — decisive only about this
   * build: a build with a different `SHUTDOWN_REASONS`/`SHUTDOWN_MODES` vocabulary (older or newer) may still
   * decode it, so the fact proven here does not authorize deleting it the way `corrupt` does
   * (design-philosophy.md principle 10's rollback case, principle 11's third answer). `detail` is
   * `decodeShutdownRemainderRecord`'s own `shape-rejected` message, carried for a future reader with a wider
   * schema; it never crosses to an operator-facing surface (see `src/transport/http/backend/status.ts`).
   */
  | Readonly<{ name: string; reason: 'unsupported'; detail: string }>
  | Readonly<{ name: string; reason: 'malformed-staging' | 'record-identity-mismatch' }>
  | Readonly<{
      name: string;
      instanceId: string;
      reason: 'staging-writer-alive' | 'staging-writer-unobservable' | 'orphaned-staging';
    }>;

export type ShutdownRemainderStageWriter = Readonly<{
  pid: number;
  incarnationDigest?: string;
}>;

export type ShutdownRemainderStageObservation = ProcessLiveness;

export type ShutdownRemainderStageObserver = (
  writer: ShutdownRemainderStageWriter,
) => ShutdownRemainderStageObservation;

export type ShutdownRemainderRecordScan = Readonly<{
  records: readonly DecodedShutdownRemainderRecord[];
  skippedEntries: readonly ShutdownRemainderSkippedEntry[];
  skippedRecords: readonly ShutdownRemainderSkippedRecord[];
  unscannedStageCount?: number;
  unscannedRecordCount?: number;
}>;

export function shutdownRemainderRecordDirectory(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}`);
}

const PERSISTED_SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
const persistedFactSchema = z.string().min(1).max(256).regex(PERSISTED_SINGLE_LINE_PATTERN);
// Constraint: a persisted filename may cross to an operator-facing status line unread, so it carries the same
// closed identifier charset as other identifier-shaped fields rather than the broader single-line prose schema.
const persistedFileNameSchema = z.string().min(1).max(255).regex(SERIALIZED_THROWN_IDENTIFIER_PATTERN);
const SHUTDOWN_REMAINDER_STAGE_PATTERN =
  /^(?<instanceId>.+)\.json\.stage\.(?<pid>[1-9][0-9]*)\.(?<incarnation>[a-f0-9]{64}|unobserved)(?<partial>\.tmp)?$/u;
const SHUTDOWN_REMAINDER_STAGE_SHAPE_PATTERN = /\.json\.(?:stage|tmp)(?:\.|$)/u;

export type ShutdownRemainderStage = Readonly<{
  name: string;
  instanceId: string;
  writer: ShutdownRemainderStageWriter;
  partial: boolean;
}>;

export type ShutdownRemainderDirectoryEntry =
  | Readonly<{ kind: 'stage'; stage: ShutdownRemainderStage }>
  | Readonly<{ kind: 'malformed-stage'; name: string }>
  | Readonly<{ kind: 'record'; name: string }>
  | Readonly<{ kind: 'other' }>;

export function shutdownRemainderStageName(
  instanceId: string,
  writer: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>,
): string {
  return `${instanceId}.json.stage.${writer.pid}.${
    writer.incarnation === null ? 'unobserved' : sha256Hex(writer.incarnation)
  }`;
}

function parseShutdownRemainderStage(name: string): ShutdownRemainderStage | null {
  const matched = SHUTDOWN_REMAINDER_STAGE_PATTERN.exec(name);
  if (matched !== null) {
    const instanceId = matched.groups?.instanceId;
    const pid = Number(matched.groups?.pid);
    const incarnation = matched.groups?.incarnation;
    if (
      instanceId === undefined ||
      !serializedThrownIdentifierSchema.safeParse(instanceId).success ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      incarnation === undefined
    ) {
      return null;
    }
    return {
      name,
      instanceId,
      writer: {
        pid,
        ...(incarnation === 'unobserved' ? {} : { incarnationDigest: incarnation }),
      },
      partial: matched.groups?.partial !== undefined,
    };
  }
  return null;
}

export function observeShutdownRemainderStageWriter(
  writer: ShutdownRemainderStageWriter,
  runtime: Readonly<{
    platform: string;
    observeLiveness(pid: number): ProcessLiveness;
    readProcessIncarnation(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
  }>,
): ShutdownRemainderStageObservation {
  try {
    if (writer.incarnationDigest === undefined) {
      return runtime.observeLiveness(writer.pid) === 'absent' ? 'absent' : 'unknown';
    }
    const incarnation = runtime.readProcessIncarnation(writer.pid, runtime.platform as NodeJS.Platform);
    if (incarnation !== null) return sha256Hex(incarnation) === writer.incarnationDigest ? 'alive' : 'absent';
    return runtime.observeLiveness(writer.pid) === 'absent' ? 'absent' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function stageObservation(
  stage: ShutdownRemainderStage,
  observeStageWriter: ShutdownRemainderStageObserver,
): ShutdownRemainderStageObservation {
  return observeStageWriter(stage.writer);
}

/** Stage-shaped names must be classified before any `.json` entry can be selected as final evidence. */
export function classifyShutdownRemainderDirectoryEntry(name: string): ShutdownRemainderDirectoryEntry {
  const stage = parseShutdownRemainderStage(name);
  if (stage !== null) return { kind: 'stage', stage };
  if (SHUTDOWN_REMAINDER_STAGE_SHAPE_PATTERN.test(name)) return { kind: 'malformed-stage', name };
  return name.endsWith('.json') ? { kind: 'record', name } : { kind: 'other' };
}

function readPersistedFact(value: unknown): string | null {
  const parsed = persistedFactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readPersistedIdentifier(value: unknown): string | null {
  const parsed = serializedThrownIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Constraint: default stripping accepts additive durable keys without preserving unvalidated data for later use.
const settlementSchema = z.discriminatedUnion('cause', [
  z.object({ cause: z.literal('rejected'), error: serializedThrownSchema }),
  z.object({ cause: z.literal('aborted'), error: serializedThrownSchema }),
  z.object({ cause: z.literal('timed-out'), budgetMs: z.number().int().positive() }),
  z.object({ cause: z.literal('budget-exhausted') }),
  z.object({ cause: z.literal('unconfirmed'), detail: z.string() }),
]);
const shutdownRemainderSubjectSchema = z.object({ kind: z.literal('discuss-store'), source: z.string() });
const successorRecoveryEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('startup-adoption'),
    processes: z
      .array(
        z.object({
          kind: z.literal('durable-cli-runtime'),
          jobId: serializedThrownIdentifierSchema,
          pid: z.number().int().positive(),
          leaderIncarnation: persistedProcessIncarnationSchema,
        }),
      )
      .readonly(),
  }),
  z.object({ kind: z.literal('startup-store-recovery') }),
  z.object({ kind: z.literal('startup-liveness-recovery') }),
]);
const shutdownRemainderEntrySchema = z.object({
  label: persistedFactSchema,
  subject: shutdownRemainderSubjectSchema.optional(),
  remainder: z.discriminatedUnion('owner', [
    z.object({ owner: z.literal('process-exit') }),
    z.object({
      owner: z.literal('successor-recovery'),
      evidence: successorRecoveryEvidenceSchema,
    }),
  ]),
  settlement: settlementSchema,
});
const shutdownRemainderRecordEnvelopeSchema = z.object({
  instanceId: serializedThrownIdentifierSchema,
  recordedAt: z.string().datetime(),
  reason: z.enum(SHUTDOWN_REASONS),
  mode: z.enum(SHUTDOWN_MODES),
  entries: z.array(z.unknown()).readonly(),
});

export function decodeShutdownRemainderRecord(value: unknown):
  | Readonly<{
      kind: 'readable';
      record: DecodedShutdownRemainderRecord;
      skippedEntries: readonly ShutdownRemainderSkippedEntry[];
    }>
  | Readonly<{ kind: 'shape-rejected'; detail: string }> {
  const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(value);
  if (!parsedRecord.success) return { kind: 'shape-rejected', detail: parsedRecord.error.message };

  const entries: DecodedShutdownRemainderEntry[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  for (const [index, rawEntry] of parsedRecord.data.entries.entries()) {
    const parsedEntry = shutdownRemainderEntrySchema.safeParse(rawEntry);
    if (parsedEntry.success) entries.push({ ...parsedEntry.data, entryNumber: index + 1 });
    else {
      const rawRemainder = isRecord(rawEntry) && isRecord(rawEntry.remainder) ? rawEntry.remainder : null;
      skippedEntries.push({
        recordInstanceId: parsedRecord.data.instanceId,
        entryNumber: index + 1,
        label: isRecord(rawEntry) ? readPersistedFact(rawEntry.label) : null,
        owner: rawRemainder === null ? null : readPersistedIdentifier(rawRemainder.owner),
      });
    }
  }

  return {
    kind: 'readable',
    record: {
      instanceId: parsedRecord.data.instanceId,
      recordedAt: parsedRecord.data.recordedAt,
      reason: parsedRecord.data.reason,
      mode: parsedRecord.data.mode,
      entries,
    },
    skippedEntries,
  };
}

export type ShutdownRemainderFileClassification =
  | Readonly<{ kind: 'vanished' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'corrupt' }>
  | Readonly<{ kind: 'unsupported'; detail: string }>
  | Readonly<{
      kind: 'readable';
      record: DecodedShutdownRemainderRecord;
      skippedEntries: readonly ShutdownRemainderSkippedEntry[];
    }>;

/**
 * Classifies one remainder file by what its content proves, shared by the report path
 * (`scanShutdownRemainderRecords`) and the reclaim path (`pruneShutdownRemainderRecords` in
 * `src/coordinator/shutdown-remainder.ts`) so the two dispositions cannot drift between them.
 *
 * `vanished`: the file lost the readdir-to-read race (`ENOENT`) — silently absent, not corrupt. `unreadable`:
 * the read was refused before any byte reached this build — a genuine unknown (design-philosophy.md principle
 * 11 forbids treating this as decisive). `corrupt`: the bytes were read and are not JSON at all — decisive for
 * every build, nothing can ever parse them. `unsupported`: the bytes parsed but this build's envelope schema
 * refused the shape — decisive only about this build, never about an older or newer one (design-philosophy.md
 * principle 10). `readable`: a decoded record.
 */
export function classifyShutdownRemainderFile(
  storage: Pick<StoragePort, 'readFileSync'>,
  path: string,
): ShutdownRemainderFileClassification {
  let raw: string;
  try {
    raw = storage.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') return { kind: 'vanished' };
    return { kind: 'unreadable' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }

  const decoded = decodeShutdownRemainderRecord(parsedJson);
  return decoded.kind === 'shape-rejected'
    ? { kind: 'unsupported', detail: decoded.detail }
    : { kind: 'readable', record: decoded.record, skippedEntries: decoded.skippedEntries };
}

export function scanShutdownRemainderRecords(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'statSync'>,
  directory: string,
  observeStageWriter: ShutdownRemainderStageObserver = () => 'unknown',
): ShutdownRemainderRecordScan {
  type RecordFile = Readonly<{ name: string; reportedName: string }>;
  type StageFile = Extract<ShutdownRemainderDirectoryEntry, { kind: 'stage' | 'malformed-stage' }>;
  const records: DecodedShutdownRemainderRecord[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  const skippedRecords: ShutdownRemainderSkippedRecord[] = [];
  const names = storage.readdirSync(directory);
  const stageFiles: StageFile[] = [];
  const recordFiles: RecordFile[] = [];
  let unscannedStageCount = 0;
  let unscannedRecordCount = 0;
  for (const name of names) {
    const entry = classifyShutdownRemainderDirectoryEntry(name);
    if (entry.kind === 'stage' || entry.kind === 'malformed-stage') {
      if (stageFiles.length < SHUTDOWN_REMAINDER_SCAN_LIMIT) stageFiles.push(entry);
      else unscannedStageCount += 1;
      continue;
    }
    if (entry.kind !== 'record') continue;
    if (recordFiles.length >= SHUTDOWN_REMAINDER_SCAN_LIMIT) {
      unscannedRecordCount += 1;
      continue;
    }
    const reportedName = persistedFileNameSchema.safeParse(name);
    recordFiles.push({
      name,
      reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
    });
  }

  for (const entry of stageFiles) {
    const name = entry.kind === 'stage' ? entry.stage.name : entry.name;
    try {
      storage.statSync(join(directory, name));
    } catch (error: unknown) {
      if (thrownErrnoCode(error) === 'ENOENT') continue;
    }
    if (entry.kind === 'malformed-stage') {
      skippedRecords.push({
        name: persistedFileNameSchema.safeParse(name).success ? name : 'invalid-record-name',
        reason: 'malformed-staging',
      });
      continue;
    }
    const stage = entry.stage;
    const observation = stageObservation(stage, observeStageWriter);
    skippedRecords.push({
      name: persistedFileNameSchema.safeParse(stage.name).success ? stage.name : 'invalid-record-name',
      instanceId: stage.instanceId,
      reason:
        observation === 'alive'
          ? 'staging-writer-alive'
          : observation === 'absent'
            ? 'orphaned-staging'
            : 'staging-writer-unobservable',
    });
  }

  const existingRecordFiles = recordFiles
    .flatMap((recordFile): RecordFile[] => {
      try {
        // A stat failure other than ENOENT carries no evidence about the file's content, so it still gets a
        // read attempt below (see `classifyShutdownRemainderFile`) rather than being treated as decisive.
        storage.statSync(join(directory, recordFile.name));
        return [recordFile];
      } catch (error: unknown) {
        return thrownErrnoCode(error) === 'ENOENT' ? [] : [recordFile];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const { name, reportedName } of existingRecordFiles) {
    const classification = classifyShutdownRemainderFile(storage, join(directory, name));
    switch (classification.kind) {
      // Same race as the `statSync` step above, one step later: the file lost the race between `readdirSync`
      // and this read. It is silently absent, not corrupt, so it must not become a skipped record.
      case 'vanished':
        continue;
      case 'unreadable':
        skippedRecords.push({ name: reportedName, reason: 'unreadable' });
        continue;
      case 'corrupt':
        skippedRecords.push({ name: reportedName, reason: 'corrupt' });
        continue;
      case 'unsupported':
        skippedRecords.push({ name: reportedName, reason: 'unsupported', detail: classification.detail });
        continue;
      case 'readable':
        if (name !== `${classification.record.instanceId}.json`) {
          skippedRecords.push({ name: reportedName, reason: 'record-identity-mismatch' });
          continue;
        }
        records.push(classification.record);
        skippedEntries.push(...classification.skippedEntries);
        continue;
    }
  }

  return {
    records,
    skippedEntries,
    skippedRecords,
    ...(unscannedStageCount === 0 ? {} : { unscannedStageCount }),
    ...(unscannedRecordCount === 0 ? {} : { unscannedRecordCount }),
  };
}
