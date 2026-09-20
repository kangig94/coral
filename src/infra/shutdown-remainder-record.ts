import { join } from 'node:path';
import { z } from 'zod';

import { serializedThrownIdentifierSchema, serializedThrownSchema, thrownErrnoCode } from './error-format.js';
import { sha256Hex } from './hash.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation } from './node-process.js';
import { persistedProcessIncarnationSchema, SHUTDOWN_MODES, SHUTDOWN_REASONS } from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;
export const SHUTDOWN_REMAINDER_RECORD_NAME = `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}.json`;
const SHUTDOWN_REMAINDER_FILESYSTEM_SUBJECT_MAX_LENGTH = 4096;

export type ShutdownRemainderFilesystemSubject = Readonly<{
  identity: string;
  label: string;
}>;

const SHUTDOWN_REMAINDER_SUBJECT_UNSAFE_PATTERN = /[\\\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

export function shutdownRemainderFilesystemSubject(subject: string | Uint8Array): ShutdownRemainderFilesystemSubject {
  const identity = sha256Hex(subject);
  const text = typeof subject === 'string' ? subject : Buffer.from(subject).toString('utf8');
  const escaped = text.replace(
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

export function shutdownRemainderRecordPath(runDir: string): string {
  return join(runDir, SHUTDOWN_REMAINDER_RECORD_NAME);
}

const PERSISTED_SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u;
const persistedFactSchema = z.string().min(1).max(256).regex(PERSISTED_SINGLE_LINE_PATTERN);

export function shutdownRemainderStagePath(
  runDir: string,
  writer: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>,
): string {
  return `${shutdownRemainderRecordPath(runDir)}.stage.${writer.pid}.${
    writer.incarnation === null ? 'unobserved' : sha256Hex(writer.incarnation)
  }`;
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
  path: string | Buffer,
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
