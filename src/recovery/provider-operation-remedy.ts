import type { JobOperatorRemedy } from '../jobs/contracts/operator-remedy.js';

export type RecoveryQuarantineCommand =
  | Readonly<{ kind: 'list' }>
  | Readonly<{ kind: 'clear'; boundary: string; key: string; revision: string }>
  | Readonly<{
      kind: 'discard-provider-operation';
      key: string;
      revision: string;
      allowReadable: boolean;
    }>;

export type ProviderOperationRemedy =
  | Readonly<{ kind: 'restart-coordinator' }>
  | Readonly<{ kind: 'remote-settlement' }>
  | Readonly<{
      kind: 'recovery-quarantine-discard';
      command: Extract<RecoveryQuarantineCommand, { kind: 'list' | 'discard-provider-operation' }>;
    }>
  | Readonly<{
      kind: 'recovery-quarantine-clear';
      command: Extract<RecoveryQuarantineCommand, { kind: 'list' | 'clear' }>;
    }>
  | Readonly<{ kind: 'external-repair' }>;

export type RecoveryRecordRemedy = ProviderOperationRemedy | JobOperatorRemedy;
