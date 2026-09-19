import { join } from 'node:path';
import { z } from 'zod';

import {
  SERIALIZED_THROWN_IDENTIFIER_PATTERN,
  serializedThrownIdentifierSchema,
  serializedThrownSchema,
  thrownErrnoCode,
} from './error-format.js';
import { isRecord } from './json.js';
import { persistedProcessIncarnationSchema, SHUTDOWN_MODES, SHUTDOWN_REASONS } from './persisted-scalar-contracts.js';
import type { StoragePort } from './port-types.js';

export const SHUTDOWN_REMAINDER_RECORD_VERSION = 1;

export type ShutdownRemainderSubject = z.infer<typeof shutdownRemainderSubjectSchema>;

type ShutdownRemainderEntry = z.infer<typeof shutdownRemainderEntrySchema>;

type DecodedShutdownRemainderEntry = ShutdownRemainderEntry & Readonly<{ entryNumber: number }>;

export type ShutdownRemainderRecord = Omit<z.infer<typeof shutdownRemainderRecordEnvelopeSchema>, 'entries'> &
  Readonly<{ entries: readonly ShutdownRemainderEntry[] }>;

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
  | Readonly<{ name: string; reason: 'unsupported'; detail: string }>;

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
// Constraint: every legitimate file this build writes under `shutdownRemainderRecordDirectory` is
// `${instanceId}.json` with `instanceId` already bound by `SERIALIZED_THROWN_IDENTIFIER_PATTERN`, so that same
// charset admits every real name. It crosses to an operator-facing status line unread (`Record: <name>`), so it
// carries the same restrictive charset as the other identifier-shaped fields on that boundary rather than the
// single-line-only `PERSISTED_SINGLE_LINE_PATTERN`, which still admits spaces, quotes, and other prose bytes.
const persistedFileNameSchema = z.string().min(1).max(255).regex(SERIALIZED_THROWN_IDENTIFIER_PATTERN);

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
): ShutdownRemainderRecordScan {
  type RecordFile = Readonly<{ name: string; reportedName: string }>;
  const records: DecodedShutdownRemainderRecord[] = [];
  const skippedEntries: ShutdownRemainderSkippedEntry[] = [];
  const skippedRecords: ShutdownRemainderSkippedRecord[] = [];
  const recordFiles = storage
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name): RecordFile[] => {
      const reportedName = persistedFileNameSchema.safeParse(name);
      const recordFile: RecordFile = {
        name,
        reportedName: reportedName.success ? reportedName.data : 'invalid-record-name',
      };
      try {
        // A stat failure other than ENOENT carries no evidence about the file's content, so it still gets a
        // read attempt below (see `classifyShutdownRemainderFile`) rather than being treated as decisive.
        storage.statSync(join(directory, name));
        return [recordFile];
      } catch (error: unknown) {
        return thrownErrnoCode(error) === 'ENOENT' ? [] : [recordFile];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const { name, reportedName } of recordFiles) {
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
        records.push(classification.record);
        skippedEntries.push(...classification.skippedEntries);
        continue;
    }
  }

  return { records, skippedEntries, skippedRecords };
}
