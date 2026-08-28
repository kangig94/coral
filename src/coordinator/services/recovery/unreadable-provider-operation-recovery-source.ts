import type { Database } from '../../../store/db.js';
import { observeProviderOperationRecord } from '../../../store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '../../../recovery/source-registry.js';
import { unreadableProviderOperationSubject } from '../../../recovery/unreadable-provider-operation.js';

/**
 * The exact current row state presented to retry policy. An unreadable row advances the retry coordinate with
 * its current durable fingerprint; a readable row carries the decoded record and retains the requested key.
 */
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

/**
 * Scans one requested key and advances retries only to that same key's validated current fingerprint; it never
 * follows a decoded or malformed row to a different coordinate.
 */
export function unreadableProviderOperationRecoverySource(
  db: Database,
  subject: RecoverySubject,
): RecoverySource<RawUnreadableProviderOperationRecoveryRow> {
  return defineRecoverySource({
    boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
    scanSubject: subject,
    scan: () => scanUnreadableProviderOperationRows(db, subject.key),
    subject: (row) =>
      row.kind === 'unreadable' ? unreadableProviderOperationSubject(row.key, row.currentRevision) : subject,
    retryRevision: 'same-key-current-fingerprint',
  });
}
