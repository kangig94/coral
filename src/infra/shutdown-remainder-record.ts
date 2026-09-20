import { join } from 'node:path';
import { z } from 'zod';

import {
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  isSystemErrorCode,
  serializedThrownIdentifierSchema,
  serializedThrownSchema,
  thrownErrnoCode,
} from './error-format.js';
import { sha256Hex } from './hash.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation, ProcessLiveness } from './node-process.js';
import { persistedProcessIncarnationSchema, SHUTDOWN_MODES, SHUTDOWN_REASONS } from './persisted-scalar-contracts.js';
import { compareText } from './persisted-contract.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;
export const SHUTDOWN_REMAINDER_SCAN_LIMIT = 128;
export const SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH = 4096;

export type ShutdownRemainderFilesystemSubject = Readonly<{
  identity: string;
  label: string;
}>;

export type ShutdownRemainderCleanupSubject = ShutdownRemainderFilesystemSubject;

const SHUTDOWN_REMAINDER_SUBJECT_UNSAFE_PATTERN = /[\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
export const shutdownRemainderCleanupCursorSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** This digest identifies only the raw lexical spelling; it is not a physical filesystem identity. */
export function shutdownRemainderFilesystemSubject(subject: string): ShutdownRemainderFilesystemSubject {
  const identity = sha256Hex(subject);
  const escaped = subject.replace(
    SHUTDOWN_REMAINDER_SUBJECT_UNSAFE_PATTERN,
    (character) => `\\u{${(character.codePointAt(0) as number).toString(16).toUpperCase()}}`,
  );
  if (escaped.length <= SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH) return { identity, label: escaped };
  const suffix = `...[sha256:${identity}]`;
  const prefix = escaped
    .slice(0, SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH - suffix.length)
    .replace(/[\uD800-\uDBFF]$/u, '');
  return { identity, label: `${prefix}${suffix}` };
}

/** A transported filesystem label must not contain terminal-active code points. */
export function isShutdownRemainderFilesystemSubject(value: unknown): value is ShutdownRemainderFilesystemSubject {
  return (
    isRecord(value) &&
    shutdownRemainderCleanupCursorSchema.safeParse(value.identity).success &&
    typeof value.label === 'string' &&
    value.label.length <= SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.label)
  );
}

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
  nextCursor?: string;
}>;

export type ShutdownRemainderScanPage = Readonly<{
  after?: string;
}>;

export function shutdownRemainderRecordDirectory(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}`);
}

const PERSISTED_SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
const persistedFactSchema = z.string().min(1).max(256).regex(PERSISTED_SINGLE_LINE_PATTERN);
// Constraint: a persisted filename may cross to an operator-facing status line unread, so it carries the same
// closed identifier charset as other identifier-shaped fields rather than the broader single-line prose schema.
const persistedFileNameSchema = z.string().min(1).max(255).regex(SERIALIZED_THROWN_IDENTIFIER_PATTERN);

export type ShutdownRemainderCleanupRefusal = Readonly<{
  subject: ShutdownRemainderCleanupSubject;
  cause:
    | Readonly<{ kind: 'system-error'; operation: 'delete' | 'promote' | 'scan-directory'; code: string }>
    | Readonly<{ kind: 'unclassified-error'; operation: 'delete' | 'promote' | 'scan-directory' }>;
}>;

/** ENOENT is absence; every other cleanup failure retains only a bounded errno identifier. */
export function shutdownRemainderCleanupRefusal(
  subject: string,
  operation: ShutdownRemainderCleanupRefusal['cause']['operation'],
  error: unknown,
): ShutdownRemainderCleanupRefusal | null {
  const code = thrownErrnoCode(error);
  if (code === 'ENOENT') return null;
  return {
    subject: shutdownRemainderFilesystemSubject(subject),
    cause:
      code !== undefined && isSystemErrorCode(code)
        ? { kind: 'system-error', operation, code }
        : { kind: 'unclassified-error', operation },
  };
}

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

/** A target-following ENOENT proves absence only when the lexical directory entry is also absent. */
export function classifyShutdownRemainderFile(
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync'>,
  path: string,
): ShutdownRemainderFileClassification {
  let raw: string;
  try {
    raw = storage.readFileSync(path, 'utf-8');
  } catch (error: unknown) {
    if (thrownErrnoCode(error) === 'ENOENT') {
      try {
        storage.lstatSync(path);
      } catch (lexicalError: unknown) {
        if (thrownErrnoCode(lexicalError) === 'ENOENT') return { kind: 'vanished' };
      }
    }
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
    : {
        kind: 'readable',
        record: decoded.record,
        skippedEntries: decoded.skippedEntries,
      };
}

export function scanShutdownRemainderRecords(
  storage: Pick<StoragePort, 'lstatSync' | 'readFileSync' | 'readdirSync'>,
  directory: string,
  observeStageWriter: ShutdownRemainderStageObserver = () => 'unknown',
  observeDirectoryEntries?: (names: readonly string[]) => void,
  page: ShutdownRemainderScanPage = {},
): ShutdownRemainderRecordScan {
  type RecordFile = Readonly<{ name: string; reportedName: string }>;
  type StageFile = Extract<ShutdownRemainderDirectoryEntry, { kind: 'stage' | 'malformed-stage' }>;
  const records: DecodedShutdownRemainderRecord[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  const skippedRecords: ShutdownRemainderSkippedRecord[] = [];
  const stageFiles: StageFile[] = [];
  const recordFiles: RecordFile[] = [];
  const stageCandidates: StageFile[] = [];
  const recordCandidates: RecordFile[] = [];
  const names = storage.readdirSync(directory).sort(compareText);
  observeDirectoryEntries?.(names);
  for (const name of names) {
    const entry = classifyShutdownRemainderDirectoryEntry(name);
    if (entry.kind === 'stage' || entry.kind === 'malformed-stage') {
      stageCandidates.push(entry);
      continue;
    }
    if (entry.kind !== 'record') continue;
    const reportedName = persistedFileNameSchema.safeParse(name);
    recordCandidates.push({
      name,
      reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
    });
  }

  const candidateNames = [
    ...stageCandidates.map((entry) => (entry.kind === 'stage' ? entry.stage.name : entry.name)),
    ...recordCandidates.map(({ name }) => name),
  ]
    .filter((name) => page.after === undefined || compareText(name, page.after) > 0)
    .sort(compareText);
  const selectedNames = new Set(candidateNames.slice(0, SHUTDOWN_REMAINDER_SCAN_LIMIT));
  stageFiles.push(
    ...stageCandidates.filter((entry) => selectedNames.has(entry.kind === 'stage' ? entry.stage.name : entry.name)),
  );
  recordFiles.push(...recordCandidates.filter(({ name }) => selectedNames.has(name)));
  const unscannedStageCount = stageCandidates.filter((entry) => {
    const name = entry.kind === 'stage' ? entry.stage.name : entry.name;
    return (page.after === undefined || compareText(name, page.after) > 0) && !selectedNames.has(name);
  }).length;
  const unscannedRecordCount = recordCandidates.filter(
    ({ name }) => (page.after === undefined || compareText(name, page.after) > 0) && !selectedNames.has(name),
  ).length;
  const selectedNameList = candidateNames.slice(0, SHUTDOWN_REMAINDER_SCAN_LIMIT);
  const nextCursor = candidateNames.length > selectedNameList.length ? selectedNameList.at(-1) : undefined;

  for (const entry of stageFiles) {
    const name = entry.kind === 'stage' ? entry.stage.name : entry.name;
    if (entry.kind === 'malformed-stage') {
      try {
        storage.lstatSync(join(directory, name));
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
      }
      skippedRecords.push({
        name: persistedFileNameSchema.safeParse(name).success ? name : 'invalid-record-name',
        reason: 'malformed-staging',
      });
      continue;
    }
    const stage = entry.stage;
    const observation = stageObservation(stage, observeStageWriter);
    if (stage.partial) {
      try {
        storage.lstatSync(join(directory, name));
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') continue;
      }
    } else {
      const classification = classifyShutdownRemainderFile(storage, join(directory, name));
      if (classification.kind === 'vanished') continue;
    }
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

  for (const { name, reportedName } of recordFiles) {
    const classification = classifyShutdownRemainderFile(storage, join(directory, name));
    switch (classification.kind) {
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
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
