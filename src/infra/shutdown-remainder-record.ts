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

// Constraint: `serializedThrownSchema` is recursive (`cause` refers back to itself), and only a
// `z.ZodType<X>`-annotated binding breaks that self-reference for the type checker — an un-annotated
// `z.lazy(() => ...)` here reports "implicitly has type 'any' because it references itself" (measured). The
// annotation freezes `serializedThrownSchema`'s own declared type to `SerializedThrown`, so a completeness guard
// checked against `z.infer<typeof serializedThrownSchema>` would compare `SerializedThrown` to itself and catch
// nothing; `serializedThrownShape` is factored out so the guard below checks its real, un-annotated return type.
const serializedThrownShape = () =>
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
  ]);
const serializedThrownSchema: z.ZodType<SerializedThrown> = z.lazy(serializedThrownShape);
const settlementSchema = z.discriminatedUnion('cause', [
  z.object({ cause: z.literal('rejected'), error: serializedThrownSchema }).passthrough(),
  z.object({ cause: z.literal('aborted'), error: serializedThrownSchema }).passthrough(),
  z.object({ cause: z.literal('timed-out'), budgetMs: z.number().int().positive() }).passthrough(),
  z.object({ cause: z.literal('budget-exhausted') }).passthrough(),
  z.object({ cause: z.literal('unconfirmed'), detail: z.string() }).passthrough(),
]) satisfies z.ZodType<ShutdownRemainderSettlement>;
const shutdownRemainderSubjectSchema = z
  .object({ kind: z.literal('discuss-store'), source: z.string() })
  .passthrough() satisfies z.ZodType<ShutdownRemainderSubject>;
const successorRecoveryEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('startup-adoption'),
      processes: z
        .array(
          z
            .object({
              kind: z.literal('durable-cli-runtime'),
              jobId: persistedIdentifierSchema,
              pid: z.number().int().positive(),
              leaderIncarnation: persistedProcessIncarnationSchema,
            })
            .passthrough(),
        )
        .readonly(),
    })
    .passthrough(),
  z.object({ kind: z.literal('startup-store-recovery') }).passthrough(),
  z.object({ kind: z.literal('startup-liveness-recovery') }).passthrough(),
]) satisfies z.ZodType<ShutdownRemainderSuccessorRecoveryEvidence>;
const shutdownRemainderEntrySchema = z
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
  .passthrough() satisfies z.ZodType<ShutdownRemainderEntry>;
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
 * Constraint: a `z.ZodType<X>` type annotation on a `const` declaration freezes that binding's own declared
 * type to `X` — `z.infer<typeof binding>` then trivially equals `X` forever after, so checking it against `X`
 * again catches nothing (measured: a discriminated union missing an arm, or a narrower hand-copied enum, both
 * still compile under that pattern). `ExactlyMatches` requires assignability in both directions, so it fails to
 * compile the moment the checked type and the schema's real inferred type disagree on a required member or a
 * member's own type — provided the schema binding is NOT itself `z.ZodType<X>`-annotated. `shutdownRemainderRecordEnvelopeSchema`
 * (`reason`/`mode`) and the five below (`satisfies z.ZodType<X>` instead of `: z.ZodType<X>`, or — for the
 * recursive `serializedThrownSchema` — the factored, un-annotated `serializedThrownShape`) all keep their real
 * inferred type reachable through `z.infer` for exactly this reason.
 *
 * Constraint: neither `Mutual<A, B>` (direct mutual assignability) nor `Mutual<Required<A>, Required<B>>`
 * catches every divergence alone — each misses exactly what the other one is for, so `ExactlyMatches` requires
 * both.
 *
 * `Mutual<A, B>` misses an **optional member present on only one side**: an object lacking an optional
 * property is structurally assignable to, and from, one that carries it (measured: adding
 * `subject?: ShutdownRemainderSubject` to `ShutdownRemainderEntry` while leaving it out of
 * `shutdownRemainderEntrySchema`, and the reverse, both still satisfy `[A] extends [B] ? [B] extends [A]`).
 * Wrapping each side in `Required<...>` catches that: a member missing on one side becomes a required member
 * that side does not have at all, which mutual assignability does reject.
 *
 * But `Required<...>` strips the optional modifier from a member **present on both sides**, so a member
 * required on one side and optional on the other becomes identical on both after wrapping, and
 * `Mutual<Required<A>, Required<B>>` alone accepts it (measured: a schema field made `.optional()` while the
 * TypeScript type keeps it required compiles clean under the `Required<...>`-wrapped comparison by itself).
 * That is exactly the edit design-philosophy.md §10 forbids by name — a field "may not be … made newly
 * required" — so a `Required<...>`-only guard would be blind to a prohibited edit while catching only the
 * sanctioned one (adding an optional member). `Mutual<A, B>`, required to hold first, still sees this
 * divergence: a member required on one side and absent from the other is not directly assignable in the
 * direction that lacks it.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ExactlyMatches<A, B> = Mutual<A, B> extends true ? Mutual<Required<A>, Required<B>> : false;
const _shutdownReasonStaysSynced: ExactlyMatches<
  ShutdownReason,
  z.infer<typeof shutdownRemainderRecordEnvelopeSchema>['reason']
> = true;
const _shutdownModeStaysSynced: ExactlyMatches<
  ShutdownMode,
  z.infer<typeof shutdownRemainderRecordEnvelopeSchema>['mode']
> = true;
type SerializedThrownRealShape =
  ReturnType<typeof serializedThrownShape> extends z.ZodType<infer Output> ? Output : never;
const _serializedThrownStaysSynced: ExactlyMatches<SerializedThrown, SerializedThrownRealShape> = true;
const _settlementStaysSynced: ExactlyMatches<ShutdownRemainderSettlement, z.infer<typeof settlementSchema>> = true;
const _shutdownRemainderSubjectStaysSynced: ExactlyMatches<
  ShutdownRemainderSubject,
  z.infer<typeof shutdownRemainderSubjectSchema>
> = true;
const _successorRecoveryEvidenceStaysSynced: ExactlyMatches<
  ShutdownRemainderSuccessorRecoveryEvidence,
  z.infer<typeof successorRecoveryEvidenceSchema>
> = true;
const _shutdownRemainderEntryStaysSynced: ExactlyMatches<
  ShutdownRemainderEntry,
  z.infer<typeof shutdownRemainderEntrySchema>
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
