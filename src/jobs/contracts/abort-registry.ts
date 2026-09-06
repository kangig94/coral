export interface JobAbortRegistryPort {
  register(jobId?: string, onAbort?: () => void): string;
  getSignal(jobId: string): AbortSignal | null;
  has(jobId: string): boolean;
  listActive(): string[];
  abort(jobIds: string[]): AbortResult;
  remove(jobId: string): void;
}

export type AbortRefusal = Readonly<{
  jobId: string;
  reason: string;
  nextStep: string;
}>;

export type AbortHold = Readonly<{
  jobId: string;
  reason: string;
  nextStep: string;
}>;

export type AbortAbandonment = Readonly<{
  jobId: string;
  reason: string;
  nextStep: string;
}>;

export type AbortHoldDisposition =
  | Readonly<{
      kind: 'abandoned';
      reason: string;
      nextStep: string;
    }>
  | Readonly<{
      kind: 'retained';
      reason: string;
      nextStep: string;
    }>;

export type AbortResult = {
  aborted: string[];
  notFound: string[];
  refused?: AbortRefusal[];
  held?: AbortHold[];
  abandoned?: AbortAbandonment[];
};
