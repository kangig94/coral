import { encodeRecoveryQuarantineKey } from './quarantine.js';

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

export function renderRecoveryQuarantineCommand(command: RecoveryQuarantineCommand): string {
  switch (command.kind) {
    case 'list':
      return 'coral-cli backend recovery-quarantine list';
    case 'clear':
      return (
        `coral-cli backend recovery-quarantine clear --boundary ${JSON.stringify(command.boundary)} ` +
        `--key ${encodeRecoveryQuarantineKey(command.key)} --revision ${JSON.stringify(command.revision)}`
      );
    case 'discard-provider-operation':
      return (
        `coral-cli backend recovery-quarantine discard-provider-operation ` +
        `--key ${encodeRecoveryQuarantineKey(command.key)} --revision ${JSON.stringify(command.revision)}` +
        (command.allowReadable ? ' --allow-readable' : '')
      );
  }
}

export function formatProviderOperationRemedy(remedy: ProviderOperationRemedy): string {
  switch (remedy.kind) {
    case 'restart-coordinator':
      return 'Restart or repair the canonical coordinator externally; Coral retries ownership adoption during startup.';
    case 'remote-settlement':
      return 'Coral retries the remote settlement path automatically; re-check the operation after settlement.';
    case 'recovery-quarantine-discard':
      return [
        remedy.command.kind === 'list'
          ? 'Inspect the current quarantine row and use only the complete remedy it prints if losing that row is acceptable.'
          : 'If losing this exact row is acceptable, run the complete discard remedy below.',
        `command=${renderRecoveryQuarantineCommand(remedy.command)}`,
      ].join('\n');
    case 'recovery-quarantine-clear':
      return [
        remedy.command.kind === 'list'
          ? 'Inspect the current quarantine row and use only the complete remedy it prints.'
          : 'Run the complete clear remedy below.',
        `command=${renderRecoveryQuarantineCommand(remedy.command)}`,
      ].join('\n');
    case 'external-repair':
      return 'External repair of the reported provider-operation ownership path is required; no Coral command can repair it. Restart the coordinator after repair.';
  }
}
