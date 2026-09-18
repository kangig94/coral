import { join } from 'node:path';
import { z } from 'zod';

import {
  SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH,
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  type SerializedThrown,
} from './error-format.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation } from './node-process.js';
import { persistedProcessIncarnationSchema } from './persisted-scalar-contracts.js';
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
  reason: 'replaced' | 'sigterm' | 'sigint' | 'provider-proxy-lifecycle-fatal' | 'idle' | 'test-teardown';
  mode: 'handoff' | 'hard';
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
  mtimeMs: number;
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
    reason: z.enum(['replaced', 'sigterm', 'sigint', 'provider-proxy-lifecycle-fatal', 'idle', 'test-teardown']),
    mode: z.enum(['handoff', 'hard']),
    entries: z.array(z.unknown()).readonly(),
  })
  .passthrough();

export function decodeShutdownRemainderRecord(value: unknown):
  | Readonly<{
      kind: 'readable';
      record: DecodedShutdownRemainderRecord;
      skippedEntries: readonly ShutdownRemainderSkippedEntry[];
    }>
  | Readonly<{ kind: 'unreadable'; detail: string }> {
  const parsedRecord = shutdownRemainderRecordEnvelopeSchema.safeParse(value);
  if (!parsedRecord.success) return { kind: 'unreadable', detail: parsedRecord.error.message };

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

export function scanShutdownRemainderRecords(
  storage: Pick<StoragePort, 'readFileSync' | 'readdirSync' | 'statSync'>,
  directory: string,
): ShutdownRemainderRecordScan {
  const records: DecodedShutdownRemainderRecord[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  const skippedRecords: ShutdownRemainderSkippedRecord[] = [];
  const recordFiles = storage
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const reportedName = persistedFileNameSchema.safeParse(name);
      try {
        return {
          name,
          reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
          mtimeMs: storage.statSync(join(directory, name)).mtimeMs,
        };
      } catch {
        return {
          name,
          reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
          mtimeMs: Number.NEGATIVE_INFINITY,
        };
      }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));

  for (const { name, reportedName, mtimeMs } of recordFiles) {
    try {
      const decoded = decodeShutdownRemainderRecord(JSON.parse(storage.readFileSync(join(directory, name), 'utf-8')));
      if (decoded.kind === 'unreadable') {
        skippedRecords.push({ name: reportedName, mtimeMs });
        continue;
      }
      records.push(decoded.record);
      skippedEntries.push(...decoded.skippedEntries);
    } catch {
      skippedRecords.push({ name: reportedName, mtimeMs });
    }
  }

  return { records, skippedEntries, skippedRecords };
}
