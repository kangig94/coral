import type {
  SettledUnboundStatusAbsence,
  SettledUnboundStatusSubject,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';
import { SETTLED_UNBOUND_STATUS_BOUNDARY } from '../../../recovery/source-registry.js';
import type { Database } from '../../../store/db.js';
import { matchingSettledUnboundRecordKeys, settledUnboundStatusIdentity } from './settled-unbound-status.js';

export type RawSettledUnboundStatusRecovery =
  | Readonly<{
      kind: 'absent';
      subject: SettledUnboundStatusSubject;
      absence: SettledUnboundStatusAbsence;
    }>
  | Readonly<{
      kind: 'present';
      subject: SettledUnboundStatusSubject;
      recordKeys: readonly string[];
    }>;

function settledUnboundRecoverySubject(subject: RecoverySubject): SettledUnboundStatusSubject {
  if (subject.revision.kind !== 'fingerprint') {
    throw new Error('Settled-unbound status retry requires a fingerprint revision.');
  }
  const statusSubject: SettledUnboundStatusSubject = {
    boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
    key: subject.key,
    revision: subject.revision.value,
    state: 'active',
  };
  if (settledUnboundStatusIdentity(statusSubject) === null) {
    throw new Error('Settled-unbound status retry does not name a valid durable identity.');
  }
  return statusSubject;
}

function scanSettledUnboundStatus(db: Database, subject: RecoverySubject): readonly RawSettledUnboundStatusRecovery[] {
  const statusSubject = settledUnboundRecoverySubject(subject);
  const identity = settledUnboundStatusIdentity(statusSubject);
  if (identity === null) throw new Error('Settled-unbound status retry identity changed during validation.');
  const recordKeys = matchingSettledUnboundRecordKeys(db, identity);
  if (recordKeys.length > 0) return [{ kind: 'present', subject: statusSubject, recordKeys }];
  const absence = Object.freeze({ identity, subject: statusSubject }) as SettledUnboundStatusAbsence;
  return [{ kind: 'absent', subject: statusSubject, absence }];
}

export function settledUnboundStatusRecoverySource(
  db: Database,
  subject: RecoverySubject,
): RecoverySource<RawSettledUnboundStatusRecovery> {
  return defineRecoverySource({
    boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
    scanSubject: subject,
    scan: () => scanSettledUnboundStatus(db, subject),
    subject: (item) => ({
      key: item.subject.key,
      revision: { kind: 'fingerprint', value: item.subject.revision },
    }),
  });
}
