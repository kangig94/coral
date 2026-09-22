import { join } from 'node:path';
import { z } from 'zod';

import {
  isSystemErrorCode,
  serializedThrownIdentifierSchema,
  thrownErrnoCode,
  type SystemErrorCode,
} from './error-format.js';
import { sha256Hex } from './hash.js';
import { isRecord } from './json.js';
import type { ProcessIncarnation } from './node-process.js';
import {
  SHUTDOWN_MODES,
  SHUTDOWN_REASONS,
  shutdownReasonModeMatches,
  type ShutdownMode,
  type ShutdownReason,
  shutdownRemainderEntrySchema,
  type ShutdownUndischarged,
} from './shutdown-contract.js';
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

export function shutdownRemainderStagePath(
  runDir: string,
  writer: Readonly<{ pid: number; incarnation: ProcessIncarnation | null }>,
): string {
  return `${shutdownRemainderRecordPath(runDir)}.stage.${writer.pid}.${
    writer.incarnation === null ? 'unobserved' : sha256Hex(writer.incarnation)
  }`;
}

function readPersistedFact(value: unknown): string | null {
  const parsed = shutdownRemainderEntrySchema.shape.label.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readPersistedIdentifier(value: unknown): string | null {
  const parsed = serializedThrownIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function refineShutdownReasonMode(
  value: Readonly<{ reason: ShutdownReason; mode: ShutdownMode }>,
  context: z.RefinementCtx,
): void {
  if (!shutdownReasonModeMatches(value.reason, value.mode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'mode does not match reason' });
  }
}
const shutdownRemainderRecordEnvelopeSchema = z
  .object({
    instanceId: serializedThrownIdentifierSchema,
    recordedAt: z.string().datetime(),
    reason: z.enum(SHUTDOWN_REASONS),
    mode: z.enum(SHUTDOWN_MODES),
    entries: z.array(z.unknown()).readonly(),
  })
  .superRefine(refineShutdownReasonMode);

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
