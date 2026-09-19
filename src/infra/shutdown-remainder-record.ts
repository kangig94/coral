import { join } from 'node:path';
import { z } from 'zod';

import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  thrownErrnoCode,
  type SerializedThrown,
} from './error-format.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation } from './node-process.js';
import {
  persistedProcessIncarnationSchema,
  SHUTDOWN_MODES,
  SHUTDOWN_REASONS,
  type ShutdownMode,
  type ShutdownReason,
} from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;

type ShutdownRemainderSuccessorRecoveryEvidence =
  | Readonly<{
      kind: 'startup-adoption';
      processes: readonly Readonly<{
        kind: 'durable-cli-runtime';
        jobId: string;
        pid: number;
        leaderIncarnation: ProcessIncarnation;
      }>[];
    }>
  | Readonly<{ kind: 'startup-store-recovery' }>
  | Readonly<{ kind: 'startup-liveness-recovery' }>;

type ShutdownRemainderSettlement =
  | Readonly<{ cause: 'rejected' | 'aborted'; error: SerializedThrown }>
  | Readonly<{ cause: 'timed-out'; budgetMs: number }>
  | Readonly<{ cause: 'budget-exhausted' }>
  | Readonly<{ cause: 'unconfirmed'; detail: string }>;

export type ShutdownRemainderSubject = Readonly<{ kind: 'discuss-store'; source: string }>;

type ShutdownRemainderEntry = Readonly<{
  label: string;
  subject?: ShutdownRemainderSubject;
  remainder:
    | Readonly<{ owner: 'process-exit' }>
    | Readonly<{ owner: 'successor-recovery'; evidence: ShutdownRemainderSuccessorRecoveryEvidence }>;
  settlement: ShutdownRemainderSettlement;
}>;

type DecodedShutdownRemainderEntry = ShutdownRemainderEntry & Readonly<{ entryNumber: number }>;

export type ShutdownRemainderRecord = Readonly<{
  instanceId: string;
  recordedAt: string;
  reason: ShutdownReason;
  mode: ShutdownMode;
  entries: readonly ShutdownRemainderEntry[];
}>;

export type DecodedShutdownRemainderRecord = Omit<ShutdownRemainderRecord, 'entries'> &
  Readonly<{ entries: readonly DecodedShutdownRemainderEntry[] }>;

export type ShutdownRemainderSkippedEntry = Readonly<{
  recordInstanceId: string;
  entryNumber: number;
  label: string | null;
  owner: string | null;
}>;

export type ShutdownRemainderSkippedRecord = Readonly<{
  name: string;
  age: Readonly<{ kind: 'known'; mtimeMs: number }> | Readonly<{ kind: 'unknown' }>;
  /**
   * `unreadable`: the read was refused before any byte reached this build — a genuine unknown about the
   * content, never decisive (design-philosophy.md principle 11). `undecodable`: the bytes were read and are
   * provably not a usable record (bad JSON or a rejected envelope shape) — as decisive as a schema rejection,
   * because the content was seen.
   */
  reason: 'unreadable' | 'undecodable';
}>;

export type ShutdownRemainderRecordScan = Readonly<{
  records: readonly DecodedShutdownRemainderRecord[];
  skippedEntries: readonly ShutdownRemainderSkippedEntry[];
  skippedRecords: readonly ShutdownRemainderSkippedRecord[];
}>;

export function shutdownRemainderRecordDirectory(runDir: string): string {
  return join(runDir, `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}`);
}

const PERSISTED_SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
const persistedFactSchema = z.string().min(1).max(256).regex(PERSISTED_SINGLE_LINE_PATTERN);
const persistedFileNameSchema = z.string().min(1).max(255).regex(PERSISTED_SINGLE_LINE_PATTERN);
const persistedIdentifierSchema = z
  .string()
  .min(1)
  .max(SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH)
  .regex(SERIALIZED_THROWN_IDENTIFIER_PATTERN);

function readPersistedFact(value: unknown): string | null {
  const parsed = persistedFactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readPersistedIdentifier(value: unknown): string | null {
  const parsed = persistedIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const serializedThrownSchema: z.ZodType<SerializedThrown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('error'),
        name: persistedIdentifierSchema,
        code: persistedIdentifierSchema.optional(),
        message: z.string(),
        stack: z.string().optional(),
        cause: serializedThrownSchema.optional(),
      })
      .passthrough(),
    z
      .object({
        kind: z.literal('unknown'),
        code: persistedIdentifierSchema.optional(),
        message: z.string(),
      })
      .passthrough(),
  ]),
);
const settlementSchema: z.ZodType<ShutdownRemainderSettlement> = z.discriminatedUnion('cause', [
  z.object({ cause: z.literal('rejected'), error: serializedThrownSchema }).passthrough(),
  z.object({ cause: z.literal('aborted'), error: serializedThrownSchema }).passthrough(),
  z.object({ cause: z.literal('timed-out'), budgetMs: z.number().int().positive() }).passthrough(),
  z.object({ cause: z.literal('budget-exhausted') }).passthrough(),
  z.object({ cause: z.literal('unconfirmed'), detail: z.string() }).passthrough(),
]);
const shutdownRemainderSubjectSchema: z.ZodType<ShutdownRemainderSubject> = z
  .object({ kind: z.literal('discuss-store'), source: z.string() })
  .passthrough();
const successorRecoveryEvidenceSchema: z.ZodType<ShutdownRemainderSuccessorRecoveryEvidence> = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('startup-adoption'),
        processes: z.array(
          z
            .object({
              kind: z.literal('durable-cli-runtime'),
              jobId: persistedIdentifierSchema,
              pid: z.number().int().positive(),
              leaderIncarnation: persistedProcessIncarnationSchema,
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    z.object({ kind: z.literal('startup-store-recovery') }).passthrough(),
    z.object({ kind: z.literal('startup-liveness-recovery') }).passthrough(),
  ],
);
const shutdownRemainderEntrySchema: z.ZodType<ShutdownRemainderEntry> = z
  .object({
    label: persistedFactSchema,
    subject: shutdownRemainderSubjectSchema.optional(),
    remainder: z.discriminatedUnion('owner', [
      z.object({ owner: z.literal('process-exit') }).passthrough(),
      z
        .object({
          owner: z.literal('successor-recovery'),
          evidence: successorRecoveryEvidenceSchema,
        })
        .passthrough(),
    ]),
    settlement: settlementSchema,
  })
  .passthrough();
const shutdownRemainderRecordEnvelopeSchema = z
  .object({
    instanceId: persistedIdentifierSchema,
    recordedAt: z.string().datetime(),
    reason: z.enum(SHUTDOWN_REASONS),
    mode: z.enum(SHUTDOWN_MODES),
    entries: z.array(z.unknown()).readonly(),
  })
  .passthrough();
/**
 * Constraint: a `z.ZodType<X>` annotation alone does not force this — a narrower schema output is assignable
 * to a wider annotated `X` with no error, so a hand-edited enum can silently stay behind a widened `X`.
 * `ExactlyMatches` requires assignability in both directions, so it fails to compile the moment `reason` or
 * `mode`'s zod enum and its record field type name a different set of literals.
 */
type ExactlyMatches<A extends string, B extends string> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _shutdownReasonStaysSynced: ExactlyMatches<
  ShutdownReason,
  z.infer<typeof shutdownRemainderRecordEnvelopeSchema>['reason']
> = true;
const _shutdownModeStaysSynced: ExactlyMatches<
  ShutdownMode,
  z.infer<typeof shutdownRemainderRecordEnvelopeSchema>['mode']
> = true;

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
  | Readonly<{ kind: 'undecodable' }>
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
 * 11 forbids treating this as decisive). `undecodable`: the bytes were read and are provably not a usable
 * record. `readable`: a decoded record.
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
    return { kind: 'undecodable' };
  }

  const decoded = decodeShutdownRemainderRecord(parsedJson);
  return decoded.kind === 'shape-rejected'
    ? { kind: 'undecodable' }
    : { kind: 'readable', record: decoded.record, skippedEntries: decoded.skippedEntries };
}

export function scanShutdownRemainderRecords(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'statSync'>,
  directory: string,
): ShutdownRemainderRecordScan {
  type RecordFile = Readonly<{
    name: string;
    reportedName: string;
    age: ShutdownRemainderSkippedRecord['age'];
  }>;
  const records: DecodedShutdownRemainderRecord[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  const skippedRecords: ShutdownRemainderSkippedRecord[] = [];
  const recordFiles = storage
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name): RecordFile[] => {
      const reportedName = persistedFileNameSchema.safeParse(name);
      try {
        return [
          {
            name,
            reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
            age: { kind: 'known', mtimeMs: storage.statSync(join(directory, name)).mtimeMs },
          },
        ];
      } catch (error: unknown) {
        if (thrownErrnoCode(error) === 'ENOENT') return [];
        return [
          {
            name,
            reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
            age: { kind: 'unknown' },
          },
        ];
      }
    })
    .sort((left, right) => {
      if (left.age.kind === 'known' && right.age.kind === 'known') {
        return left.age.mtimeMs - right.age.mtimeMs || left.name.localeCompare(right.name);
      }
      if (left.age.kind !== right.age.kind) return left.age.kind === 'known' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  for (const { name, reportedName, age } of recordFiles) {
    const classification = classifyShutdownRemainderFile(storage, join(directory, name));
    switch (classification.kind) {
      // Same race as the `statSync` step above, one step later: the file lost the race between `readdirSync`
      // and this read. It is silently absent, not corrupt, so it must not become a skipped record.
      case 'vanished':
        continue;
      case 'unreadable':
        skippedRecords.push({ name: reportedName, age, reason: 'unreadable' });
        continue;
      case 'undecodable':
        skippedRecords.push({ name: reportedName, age, reason: 'undecodable' });
        continue;
      case 'readable':
        records.push(classification.record);
        skippedEntries.push(...classification.skippedEntries);
        continue;
    }
  }

  return { records, skippedEntries, skippedRecords };
}
