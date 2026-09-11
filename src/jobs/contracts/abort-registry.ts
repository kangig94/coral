export type AbortSettledCallback = () => void;

export interface JobAbortRegistryPort {
  register(jobId?: string, onAbort?: () => void, onAbortSettled?: AbortSettledCallback): string;
  getSignal(jobId: string): AbortSignal | null;
  has(jobId: string): boolean;
  listActive(): string[];
  abort(jobIds: string[]): AbortResult;
  remove(jobId: string): void;
}

export interface AbortHoldOwner {
  hold(jobId: string, reason: string, nextStep: AbortNextStep, abandon: () => AbortHoldDisposition): void;
  releaseHold(jobId: string): void;
}

export type AbortRefusal = Readonly<{
  jobId: string;
  reason: string;
  nextStep: AbortNextStep;
}>;

export type AbortHold = Readonly<{
  jobId: string;
  reason: string;
  nextStep: AbortNextStep;
}>;

export type AbortAbandonment = Readonly<{
  jobId: string;
  reason: string;
  nextStep: AbortNextStep;
}>;

export type AbortHoldDisposition =
  | Readonly<{
      kind: 'abandoned';
      reason: string;
      nextStep: AbortNextStep;
    }>
  | Readonly<{
      kind: 'retained';
      reason: string;
      nextStep: AbortNextStep;
    }>;

export type AbortResult = {
  aborted: string[];
  notFound: string[];
  refused?: AbortRefusal[];
  held?: AbortHold[];
  abandoned?: AbortAbandonment[];
};
import type { JobOperatorRemedy } from './operator-remedy.js';

export type AbortNextStep = string | Readonly<{ detail: string; remedy: JobOperatorRemedy }>;
