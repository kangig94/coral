export type RuntimeComponentId = string & { readonly __brand: 'RuntimeComponentId' };
export const KB_COMPONENT_ID = 'kb' as RuntimeComponentId;

export type DegradedReason = {
  kind: 'curate-publish';
  consecutiveFailures: number;
  lastError: string;
};

type OfflineDiagnostic = {
  attempts?: number;
  failedStep?: string;
  retry?: 'restart-daemon' | 'none';
  lastErrorStack?: string;
};

export type RuntimeComponentStatus =
  | { id: RuntimeComponentId; phase: 'initializing'; attempt: number }
  | { id: RuntimeComponentId; phase: 'online' }
  | { id: RuntimeComponentId; phase: 'degraded'; reason: DegradedReason }
  | { id: RuntimeComponentId; phase: 'offline'; reason: string; lastLogLine?: string; diagnostic?: OfflineDiagnostic };

export interface RuntimeComponent {
  readonly id: RuntimeComponentId;
  init(signal: AbortSignal): Promise<void>;
  dispose(signal: AbortSignal): Promise<void>;
  readonly status: RuntimeComponentStatus;
}
