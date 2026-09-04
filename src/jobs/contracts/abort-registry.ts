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

export type AbortResult = {
  aborted: string[];
  notFound: string[];
  refused?: AbortRefusal[];
};
