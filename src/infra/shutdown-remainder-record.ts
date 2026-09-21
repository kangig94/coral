import { join } from 'node:path';
import { z } from 'zod';

import {
  isSystemErrorCode,
  serializedThrownIdentifierSchema,
  serializedThrownSchema,
  thrownErrnoCode,
  type SystemErrorCode,
} from './error-format.js';
import { sha256Hex } from './hash.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation } from './node-process.js';
import { persistedProcessIncarnationSchema, SHUTDOWN_MODES, SHUTDOWN_REASONS } from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;
export const SHUTDOWN_REMAINDER_RECORD_NAME = `shutdown-remainder.v${SHUTDOWN_REMAINDER_RECORD_VERSION}.json`;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type ShutdownRemainderSubject = DeepReadonly<z.infer<typeof shutdownRemainderSubjectSchema>>;

export type SuccessorRecoveryEvidence = DeepReadonly<z.infer<typeof successorRecoveryEvidenceSchema>>;

export type UndischargedRemainder =
  | Readonly<{ owner: 'process-exit' }>
  | Readonly<{ owner: 'successor-recovery'; evidence: SuccessorRecoveryEvidence }>;

export type ShutdownHoldReason = z.infer<typeof shutdownHoldReasonSchema>;

export type ShutdownHoldExit = z.infer<typeof shutdownHoldExitSchema>;

export type ShutdownRetainedAuthority = DeepReadonly<z.infer<typeof shutdownRetainedAuthoritySchema>>;

export type ShutdownUndischarged = DeepReadonly<z.infer<typeof shutdownRemainderEntrySchema>>;

export type ShutdownRemainderProjection = DeepReadonly<z.infer<typeof shutdownRemainderProjectionEnvelopeSchema>>;

type ShutdownRemainderEntry = ShutdownUndischarged;

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
export const shutdownHoldReasonSchema = z.literal('required-shutdown-step-unsettled');
export const shutdownHoldExitSchema = z.enum(['shutdown-budget-exhaustion', 'authority-release-settlement']);
export const shutdownRetainedAuthoritySchema = z.object({
  ipcSocket: z.boolean(),
  providerControlProxyInstanceIds: z.array(serializedThrownIdentifierSchema).readonly(),
  cleanupObligations: z.array(persistedFactSchema).readonly(),
});
export const shutdownRemainderEntrySchema = z.object({
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
export const shutdownRemainderProjectionEnvelopeSchema = z.object({
  reason: z.enum(SHUTDOWN_REASONS),
  mode: z.enum(SHUTDOWN_MODES),
  elapsedMs: z.number().finite().nonnegative(),
  boundMs: z.number().finite().nonnegative(),
  attempt: z.object({
    started: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  lastDeclined: z
    .object({
      attempt: z.number().int().positive(),
      reason: shutdownHoldReasonSchema,
      exit: shutdownHoldExitSchema,
      undischarged: z.array(shutdownRemainderEntrySchema).readonly(),
      retainedAuthority: shutdownRetainedAuthoritySchema,
    })
    .optional(),
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
  /** `errno` is `null` only when the thrown value named no system error code, never when one applies. */
  | Readonly<{ kind: 'unreadable'; errno: SystemErrorCode | null }>
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
    const code = thrownErrnoCode(error);
    if (code === 'ENOENT') {
      try {
        storage.lstatSync(path);
      } catch (lexicalError: unknown) {
        if (thrownErrnoCode(lexicalError) === 'ENOENT') return { kind: 'vanished' };
      }
    }
    // Constraint: the read is the refusal a reader acts on, so its own code is carried even when the lexical
    // probe refused differently.
    return { kind: 'unreadable', errno: code !== undefined && isSystemErrorCode(code) ? code : null };
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
