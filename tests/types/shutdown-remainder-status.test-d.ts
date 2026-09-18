import type { ShutdownRemainderReport } from '../../src/transport/http/backend/status.js';

type ShutdownRemainderStatus = Extract<ShutdownRemainderReport, { status: 'recent_shutdown_remainder' }>;
type OperatorFacingSettlement = ShutdownRemainderStatus['record']['entries'][number]['settlement'];

type ProjectionLeafPaths<Value, Prefix extends string = ''> = Value extends string | number | boolean | null | undefined
  ? Prefix
  : Value extends readonly (infer Item)[]
    ? ProjectionLeafPaths<Item, `${Prefix}[]`>
    : Value extends object
      ? {
          [Key in keyof Value & string]-?: ProjectionLeafPaths<
            Value[Key],
            Prefix extends '' ? Key : `${Prefix}.${Key}`
          >;
        }[keyof Value & string]
      : never;

type BroadStringLeafPaths<Value, Prefix extends string = ''> = Value extends string
  ? string extends Value
    ? Prefix
    : never
  : Value extends number | boolean | null | undefined
    ? never
    : Value extends readonly (infer Item)[]
      ? BroadStringLeafPaths<Item, `${Prefix}[]`>
      : Value extends object
        ? {
            [Key in keyof Value & string]-?: BroadStringLeafPaths<
              Value[Key],
              Prefix extends '' ? Key : `${Prefix}.${Key}`
            >;
          }[keyof Value & string]
        : never;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type ExpectedProjectionLeafPaths =
  | 'status'
  | 'record.instanceId'
  | 'record.recordedAt'
  | 'record.reason'
  | 'record.mode'
  | 'record.entries[].entryNumber'
  | 'record.entries[].obligation'
  | 'record.entries[].obligation.label'
  | 'record.entries[].obligation.ordinal'
  | 'record.entries[].obligation.occurrence'
  | 'record.entries[].subject'
  | 'record.entries[].subject.kind'
  | 'record.entries[].subject.sourceDigest'
  | 'record.entries[].remainder.owner'
  | 'record.entries[].remainder.evidence.kind'
  | 'record.entries[].remainder.evidence.processes[].kind'
  | 'record.entries[].remainder.evidence.processes[].jobId'
  | 'record.entries[].remainder.evidence.processes[].pid'
  | 'record.entries[].remainder.evidence.processes[].leaderIncarnation.present'
  | 'record.entries[].settlement.cause'
  | 'record.entries[].settlement.error.name'
  | 'record.entries[].settlement.error.code'
  | 'record.entries[].settlement.budgetMs'
  | 'skippedEntries[].entryNumber'
  | 'skippedEntries[].obligation'
  | 'skippedEntries[].obligation.label'
  | 'skippedEntries[].obligation.ordinal'
  | 'skippedEntries[].obligation.occurrence'
  | 'skippedEntries[].owner'
  | 'skippedRecordCount';

type ExpectedBroadStringLeafPaths =
  | 'record.instanceId'
  | 'record.recordedAt'
  | 'record.entries[].subject.sourceDigest'
  | 'record.entries[].remainder.evidence.processes[].jobId';

const projectionLeafCoverage: Equal<ProjectionLeafPaths<ShutdownRemainderStatus>, ExpectedProjectionLeafPaths> = true;
const broadStringLeafCoverage: Equal<
  BroadStringLeafPaths<ShutdownRemainderStatus>,
  ExpectedBroadStringLeafPaths
> = true;
void projectionLeafCoverage;
void broadStringLeafCoverage;

declare const entry: ShutdownRemainderStatus['record']['entries'][number];
void entry.entryNumber;
void entry.obligation;
// @ts-expect-error persisted prose is absent from the status projection.
void entry.label;

if (entry.subject !== undefined) {
  const subjectKind: 'discuss-store' = entry.subject.kind;
  const subjectDigest: string = entry.subject.sourceDigest;
  void subjectKind;
  void subjectDigest;
  // @ts-expect-error the raw discuss-store project source is absent from the status projection.
  void entry.subject.source;
}

if (entry.remainder.owner === 'successor-recovery' && entry.remainder.evidence.kind === 'startup-adoption') {
  const process = entry.remainder.evidence.processes[0];
  if (process !== undefined) {
    const incarnationPresent: true = process.leaderIncarnation.present;
    void incarnationPresent;
    // @ts-expect-error no other Coral surface publishes a comparable digest, so a digest here is decoration.
    void process.leaderIncarnation.sha256;
    // @ts-expect-error the opaque persisted incarnation is absent from the status projection.
    const rawIncarnation: string = process.leaderIncarnation;
    void rawIncarnation;
  }
}

declare const skippedEntry: ShutdownRemainderStatus['skippedEntries'][number];
void skippedEntry.entryNumber;
void skippedEntry.obligation;
const skippedOwner: 'process-exit' | 'successor-recovery' | null = skippedEntry.owner;
void skippedOwner;
// @ts-expect-error skipped persisted labels are absent from the status projection.
void skippedEntry.label;
// @ts-expect-error skipped record identities are absent from the status projection.
void skippedEntry.recordInstanceId;

declare const skippedRecordCount: ShutdownRemainderStatus['skippedRecordCount'];
void skippedRecordCount;
// @ts-expect-error skipped record filenames are absent from the status projection.
declare const skippedRecords: ShutdownRemainderStatus['skippedRecords'];
void skippedRecords;

declare const settlement: OperatorFacingSettlement;

void settlement.cause;
// @ts-expect-error persisted prose is absent from the status projection.
void settlement.detail;
// @ts-expect-error a rendered settlement has no top-level error message.
void settlement.message;
// @ts-expect-error a rendered settlement has no top-level stack.
void settlement.stack;

if (settlement.cause === 'rejected' || settlement.cause === 'aborted') {
  void settlement.error.name;
  void settlement.error.code;
  type ErrorName = NonNullable<typeof settlement.error.name>;
  type ErrorCode = NonNullable<typeof settlement.error.code>;
  // @ts-expect-error the projected error name is a closed repository vocabulary.
  const hostileName: ErrorName = 'RunCoralCliBackendShutdown';
  // @ts-expect-error the projected error code is a closed repository vocabulary.
  const hostileCode: ErrorCode = 'RUN_CORAL_CLI_BACKEND_SHUTDOWN';
  void hostileName;
  void hostileCode;
  // @ts-expect-error the thrown fingerprint excludes the persisted message.
  void settlement.error.message;
  // @ts-expect-error the thrown fingerprint excludes the persisted stack.
  void settlement.error.stack;
  // @ts-expect-error the thrown fingerprint excludes the persisted cause chain.
  void settlement.error.cause;
}
