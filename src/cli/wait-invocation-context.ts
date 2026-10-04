export const WAIT_INVOCATION_CONTEXT_ENV = 'CORAL_WAIT_INVOCATION_CONTEXT';
export const WAIT_INVOCATION_CONTRACT_ARGUMENT = '--print-wait-invocation-contract';

export class WaitInvocationReadinessError extends Error {
  readonly code = 'transient';
  readonly exitCode = 75;
  readonly remediation: string;

  constructor(originalCommand: string) {
    super('The selected CLI cannot preserve this monitor invocation budget. Wait admission did not complete.');
    this.remediation = `Run ${originalCommand}`;
  }
}

export type WaitInvocationMode = 'bounded' | 'snapshot';

export interface WaitInvocationHandoff {
  readonly mode: WaitInvocationMode;
  readonly signal: AbortSignal;
  readonly originalCommand: string;
  remainingMs(): number;
  cleanupRemainingMs(): number;
  saveContinuation(text: string, complete?: boolean): void;
}
