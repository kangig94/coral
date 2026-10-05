export const CLI_HANDOFF_GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
export const WAIT_INVOCATION_CONTEXT_ENV = 'CORAL_WAIT_INVOCATION_CONTEXT';
export const WAIT_INVOCATION_CONTRACT_ARGUMENT = '--print-wait-invocation-contract';

export class WaitInvocationReadinessError extends Error {
  readonly code = 'transient';
  readonly exitCode = 75;
  readonly remediation: string;

  constructor(originalCommand: string) {
    super(
      'The selected CLI wait contract could not be observed within the invocation budget. Wait admission did not complete.',
    );
    this.remediation = `Run ${originalCommand}`;
  }
}

export type WaitInvocationMode = 'bounded' | 'snapshot';

export interface WaitInvocationHandoff {
  readonly mode: WaitInvocationMode;
  readonly signal: AbortSignal;
  readonly originalCommand: string;
  monitorEnding?: Promise<unknown>;
  remainingMs(): number;
  cleanupRemainingMs(): number;
  saveContinuation(text: string, complete?: boolean, delivered?: boolean): void;
}
