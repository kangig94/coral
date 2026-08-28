import type { Database } from '../../../store/db.js';
import { observeProviderOperationRecord } from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';

export type RawUnreadableProviderOperationRecoveryRow =
  | Readonly<{
      kind: 'unreadable';
      key: string;
      currentRevision: string;
    }>
  | Readonly<{
      kind: 'readable';
      key: string;
      record: ProviderOperationRecord;
    }>;

function scanUnreadableProviderOperationRows(
  db: Database,
  subjectKey: string,
): readonly RawUnreadableProviderOperationRecoveryRow[] {
  const observation = observeProviderOperationRecord(db, subjectKey);
  if (observation.kind === 'absent') return [];
  if (observation.kind === 'readable') {
    return [{ kind: 'readable', key: subjectKey, record: observation.record }];
  }
  return [
    {
      kind: 'unreadable',
      key: observation.attribution.key,
      currentRevision: observation.attribution.revision,
    },
  ];
}

export function unreadableProviderOperationRecoverySource(
  db: Database,
  subject: RecoverySubject,
): RecoverySource<RawUnreadableProviderOperationRecoveryRow> {
  return defineRecoverySource({
    boundary: 'provider-operation-unreadable',
    scanSubject: subject,
    scan: () => scanUnreadableProviderOperationRows(db, subject.key),
    subject: (row) =>
      row.kind === 'unreadable'
        ? { key: row.key, revision: { kind: 'fingerprint', value: row.currentRevision } }
        : subject,
    retryRevision: 'same-key-current-fingerprint',
  });
}
