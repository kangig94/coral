import type { RecoverySubject } from '../../../recovery/containment.js';
import type { UnreadableProviderOperationAttribution } from '../../../store/provider-operation-journal.js';

export function unreadableProviderOperationSubject(
  row: Pick<UnreadableProviderOperationAttribution, 'key' | 'revision'>,
): RecoverySubject {
  return {
    key: row.key,
    revision: { kind: 'fingerprint', value: row.revision },
  };
}
