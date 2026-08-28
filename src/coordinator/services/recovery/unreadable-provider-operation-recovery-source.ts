import type { Database } from '../../../store/db.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '../../../store/provider-operation-journal.js';
import { defineRecoverySource, type RecoverySource, type RecoverySubject } from '../../../recovery/containment.js';

export type RawUnreadableProviderOperationRecoveryRow = Readonly<{
  key: string;
  currentRevision: string;
}>;

function scanUnreadableProviderOperationRows(
  db: Database,
  subjectKey: string,
): readonly RawUnreadableProviderOperationRecoveryRow[] {
  const unreadableKeys = readProviderOperations(db).unreadableKeys;
  if (!unreadableKeys.includes(subjectKey)) return [];
  const current = attributeUnreadableProviderOperations(db, [subjectKey])[0];
  return current === undefined ? [] : [{ key: current.key, currentRevision: current.revision }];
}

export function unreadableProviderOperationRecoverySource(
  db: Database,
  subject: RecoverySubject,
): RecoverySource<RawUnreadableProviderOperationRecoveryRow> {
  return defineRecoverySource({
    boundary: 'provider-operation-unreadable',
    scanSubject: subject,
    scan: () => scanUnreadableProviderOperationRows(db, subject.key),
    subject: () => subject,
  });
}
