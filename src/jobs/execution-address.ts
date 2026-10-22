export interface ExecutionAddress {
  readonly jobId: string;
  readonly execution: number;
}

export function executionKey(jobId: string, execution: number): string {
  return `${jobId}:${execution}`;
}

export function executionAddressKey(address: ExecutionAddress): string {
  return executionKey(address.jobId, address.execution);
}

export function retentionActionKey(address: { jobId: string; execution: number; attempt: number }): string {
  return `${executionAddressKey(address)}:${address.attempt}`;
}
