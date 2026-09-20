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
  | 'record.entries[].remainder.owner'
  | 'record.entries[].remainder.evidence.kind'
  | 'record.entries[].remainder.evidence.processes[].kind'
  | 'record.entries[].remainder.evidence.processes[].jobId'
  | 'record.entries[].remainder.evidence.processes[].pid'
  | 'record.entries[].settlement.cause'
  | 'record.entries[].settlement.error.name'
  | 'record.entries[].settlement.error.code'
  | 'record.entries[].settlement.budgetMs'
  | 'skippedEntries[].entryNumber'
  | 'skippedEntries[].obligation'
  | 'skippedEntries[].obligation.label'
  | 'skippedEntries[].obligation.ordinal'
  | 'skippedEntries[].obligation.occurrence'
  | 'skippedEntries[].owner';

type ExpectedBroadStringLeafPaths =
  | 'record.instanceId'
  | 'record.recordedAt'
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

// @ts-expect-error persisted subjects are absent from the status projection.
void entry.subject;

if (entry.remainder.owner === 'successor-recovery' && entry.remainder.evidence.kind === 'startup-adoption') {
  const process = entry.remainder.evidence.processes[0];
  if (process !== undefined) {
    void process.jobId;
    void process.pid;
    // @ts-expect-error a constant incarnation-presence marker is absent from the status projection.
    void process.leaderIncarnation;
  }
}

declare const skippedEntry: ShutdownRemainderStatus['skippedEntries'][number];
void skippedEntry.entryNumber;
void skippedEntry.obligation;
const skippedOwner: 'process-exit' | 'successor-recovery' | null = skippedEntry.owner;
void skippedOwner;
// @ts-expect-error skipped persisted labels are absent from the status projection.
void skippedEntry.label;
// @ts-expect-error a skipped entry does not own a record identity.
void skippedEntry.recordInstanceId;

// @ts-expect-error the classification a reader could not decode belongs to the unusable-record report, not to
// one carrying a decoded record.
declare const unusableReason: ShutdownRemainderStatus['reason'];
void unusableReason;

type UnusableShutdownRemainderStatus = Extract<ShutdownRemainderReport, { status: 'shutdown_remainder_unreadable' }>;
const unusableProjectionLeafCoverage: Equal<
  ProjectionLeafPaths<UnusableShutdownRemainderStatus>,
  'status' | 'reason' | 'errno' | 'path'
> = true;
void unusableProjectionLeafCoverage;
// The rendered unusable line carries exactly one broad string, the path this build composed itself. A code
// read off a thrown value reaches the reader only as the closed system-errno vocabulary.
const unusableBroadStringLeafCoverage: Equal<BroadStringLeafPaths<UnusableShutdownRemainderStatus>, 'path'> = true;
void unusableBroadStringLeafCoverage;

type UnreadableShutdownRemainderStatus = Extract<UnusableShutdownRemainderStatus, { reason: 'unreadable' }>;
// @ts-expect-error the projected errno is the closed system vocabulary, not a code read off any thrown value.
const hostileErrno: NonNullable<UnreadableShutdownRemainderStatus['errno']> = 'ERRNO_FROM_SOMEWHERE_ELSE';
void hostileErrno;
type ParseRefusedShutdownRemainderStatus = Exclude<UnusableShutdownRemainderStatus, { reason: 'unreadable' }>;
declare const parseRefusalReason: ParseRefusedShutdownRemainderStatus['reason'];
const namedParseRefusal: 'corrupt' | 'unsupported' = parseRefusalReason;
void namedParseRefusal;
// @ts-expect-error a parse refusal names no system error code, so it carries no errno to be absent.
declare const parseRefusalErrno: ParseRefusedShutdownRemainderStatus['errno'];
void parseRefusalErrno;

declare const unusablePath: string;
void (unusablePath satisfies UnusableShutdownRemainderStatus['path']);
declare const unusableCause: UnusableShutdownRemainderStatus['reason'];
const namedCause: 'unreadable' | 'corrupt' | 'unsupported' = unusableCause;
void namedCause;
// @ts-expect-error an unusable record carries no decoded record to project.
declare const unusableRecord: UnusableShutdownRemainderStatus['record'];
void unusableRecord;

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
