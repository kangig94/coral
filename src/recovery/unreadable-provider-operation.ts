import type { RecoverySubject } from './containment.js';

export type UnreadableProviderOperationRecoveryCoordinate = Readonly<{
  key: string;
  revision: string;
}>;

export function unreadableProviderOperationSubject(
  coordinate: UnreadableProviderOperationRecoveryCoordinate,
): RecoverySubject {
  return {
    key: coordinate.key,
    revision: { kind: 'fingerprint', value: coordinate.revision },
  };
}
