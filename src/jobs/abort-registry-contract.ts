import type { AbortResult } from './abort-result.js';

export interface JobAbortRegistryPort {
  register(jobId?: string, onAbort?: () => void): string;
  getSignal(jobId: string): AbortSignal | null;
  has(jobId: string): boolean;
  abort(jobIds: string[]): AbortResult;
  remove(jobId: string): void;
}
