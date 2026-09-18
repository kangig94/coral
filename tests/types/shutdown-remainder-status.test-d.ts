import type { BackendStatusFull } from '../../src/transport/http/backend/status.js';

type ShutdownRemainderStatus = Extract<BackendStatusFull, { status: 'recent_shutdown_remainder' }>;
type OperatorFacingSettlement = ShutdownRemainderStatus['record']['entries'][number]['settlement'];

declare const entry: ShutdownRemainderStatus['record']['entries'][number];
void entry.entryNumber;
void entry.obligation;
// @ts-expect-error persisted prose is absent from the status projection.
void entry.label;
// @ts-expect-error private record subjects are absent from the status projection.
void entry.subject;

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
