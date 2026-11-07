import type { Database } from '#src/store/db.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { EXECUTION_FINISHING_BOUNDARY } from '#src/jobs/finishing.js';
import { executionAddressKey } from '#src/jobs/execution-address.js';

export const FINISHING_QUARANTINE_STATUS = {
  stage: 'finish',
  kind: 'blocked',
  reason: 'fixture finishing hold',
  successor: 'recovery-quarantine',
} as const;

export function writeFinishingQuarantine(db: Database, jobId: string, execution: number): void {
  new RecoveryQuarantineStore(db, { now: () => Date.parse('2026-10-22T00:00:00.000Z') }).upsert({
    boundary: EXECUTION_FINISHING_BOUNDARY,
    subject: { key: executionAddressKey({ jobId, execution }), revision: { kind: 'until-cleared' } },
    state: 'active',
    stage: 'settle',
    errorMessage: FINISHING_QUARANTINE_STATUS.reason,
    detail: JSON.stringify(FINISHING_QUARANTINE_STATUS),
    remedy: { kind: 'recovery-quarantine-clear', command: { kind: 'list' } },
  });
}

export function breakFinishingRetryAuthority(db: Database, jobId: string, execution: number): void {
  db.prepare(
    "UPDATE recovery_quarantine SET state = 'retrying', retry_owner = NULL, retry_token = NULL WHERE boundary_id = ? AND subject_key = ?",
  ).run(EXECUTION_FINISHING_BOUNDARY, executionAddressKey({ jobId, execution }));
}
