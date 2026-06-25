export type SubsystemId = string & { readonly __brand: 'SubsystemId' };
export const KB_ID = 'kb' as SubsystemId;

export type DegradedReason = {
  kind: 'curate-publish';
  consecutiveFailures: number;
  lastError: string;
};

export type OfflineDiagnostic = {
  attempts?: number;
  failedStep?: string;
  retry?: 'restart-daemon' | 'none';
  lastErrorStack?: string;
};

export type SubsystemStatus =
  | { id: SubsystemId; phase: 'initializing'; attempt: number }
  | { id: SubsystemId; phase: 'online' }
  | { id: SubsystemId; phase: 'degraded'; reason: DegradedReason }
  | { id: SubsystemId; phase: 'offline'; reason: string; lastLogLine?: string; diagnostic?: OfflineDiagnostic };

export interface Subsystem<R = unknown> {
  readonly id: SubsystemId;
  init(signal: AbortSignal): Promise<void>;
  dispose(signal: AbortSignal): Promise<void>;
  readonly status: SubsystemStatus;
  resource(): R;
  onStatusChange(listener: (s: SubsystemStatus) => void): () => void;
}

export class SubsystemUnavailableError extends Error {
  public readonly id: SubsystemId;
  public readonly phase: 'initializing' | 'offline';
  constructor(id: SubsystemId, phase: 'initializing' | 'offline') {
    super(`Subsystem ${id} ${phase}`);
    this.id = id;
    this.phase = phase;
    this.name = 'SubsystemUnavailableError';
  }
}
