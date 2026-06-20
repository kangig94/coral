import { isRecord } from '../../../infra/json.js';

/**
 * Health metadata exposed by the Coral backend over HTTP.
 *
 * `subsystems` is an array of per-subsystem status entries (4-phase tagged
 * union). `mutationBlocked` and `consumerStuck` live under top-level
 * `diagnostics` and are omitted entirely when healthy.
 *
 * This shape mirrors `HealthSnapshot` in `src/transport/server-ports.ts` —
 * the producer-side type. The two are kept in sync structurally; transport
 * keeps a local copy because layering forbids importing coordinator
 * internals like the branded `SubsystemId`.
 */
export type TransportSubsystemStatus =
  | { id: string; phase: 'initializing'; attempt: number }
  | { id: string; phase: 'online' }
  | {
      id: string;
      phase: 'degraded';
      reason: { kind: 'curate-publish'; consecutiveFailures: number; lastError: string };
    }
  | { id: string; phase: 'offline'; reason: string; lastLogLine?: string };

export type TextProjectionHealthState = 'idle' | 'fetching' | 'reindexing';

export interface BackendHealth {
  /**
   * Legacy strict-enum status field kept so older CLIs that validate
   * `'starting' | 'ok' | 'draining'` keep working. New consumers read
   * `kernel.phase` for the full 5-state lifecycle.
   */
  status: 'starting' | 'ok' | 'draining';
  kernel: {
    phase: 'starting' | 'kernel-ready' | 'running' | 'draining' | 'stopped';
    readyAt: number | null;
  };
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  instanceId: string;
  namespace: string;
  uptimeMs: number;
  active: number;
  activeJobs: number;
  inflightRequests: number;
  queueDepth: number;
  textProjectionState: TextProjectionHealthState;
  subsystems: TransportSubsystemStatus[];
  diagnostics?: {
    mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
    consumerStuck?: Array<{ id: string; elapsedSinceStopMs: number }>;
  };
}

function isMutationBlocked(value: unknown): value is { owner: string; ageMs: number; signaledAtMs: number } {
  return (
    isRecord(value) &&
    typeof value.owner === 'string' &&
    Number.isFinite(value.ageMs) &&
    Number.isFinite(value.signaledAtMs)
  );
}

function isConsumerStuck(value: unknown): value is Array<{ id: string; elapsedSinceStopMs: number }> {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (entry) => isRecord(entry) && typeof entry.id === 'string' && Number.isFinite(entry.elapsedSinceStopMs),
  );
}

function isDegradedReason(
  value: unknown,
): value is { kind: 'curate-publish'; consecutiveFailures: number; lastError: string } {
  return (
    isRecord(value) &&
    value.kind === 'curate-publish' &&
    Number.isFinite(value.consecutiveFailures) &&
    typeof value.lastError === 'string'
  );
}

function isSubsystemStatus(value: unknown): value is TransportSubsystemStatus {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return false;
  }
  switch (value.phase) {
    case 'initializing':
      return Number.isFinite(value.attempt);
    case 'online':
      return true;
    case 'degraded':
      return isDegradedReason(value.reason);
    case 'offline':
      return (
        typeof value.reason === 'string' && (value.lastLogLine === undefined || typeof value.lastLogLine === 'string')
      );
    default:
      return false;
  }
}

function isTextProjectionState(value: unknown): value is TextProjectionHealthState {
  return value === 'idle' || value === 'fetching' || value === 'reindexing';
}

function isKernel(value: unknown): value is BackendHealth['kernel'] {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.phase !== 'starting' &&
    value.phase !== 'kernel-ready' &&
    value.phase !== 'running' &&
    value.phase !== 'draining' &&
    value.phase !== 'stopped'
  ) {
    return false;
  }
  return value.readyAt === null || Number.isFinite(value.readyAt);
}

function isDiagnostics(value: unknown): value is NonNullable<BackendHealth['diagnostics']> {
  if (!isRecord(value)) {
    return false;
  }
  if (value.mutationBlocked !== undefined && !isMutationBlocked(value.mutationBlocked)) {
    return false;
  }
  if (value.consumerStuck !== undefined && !isConsumerStuck(value.consumerStuck)) {
    return false;
  }
  return true;
}

export function isBackendHealth(value: unknown): value is BackendHealth {
  return (
    isRecord(value) &&
    (value.status === 'starting' || value.status === 'ok' || value.status === 'draining') &&
    isKernel(value.kernel) &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.instanceId === 'string' &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0 &&
    Number.isFinite(value.uptimeMs) &&
    Number.isInteger(value.active) &&
    Number.isInteger(value.activeJobs) &&
    Number.isInteger(value.inflightRequests) &&
    Number.isInteger(value.queueDepth) &&
    isTextProjectionState(value.textProjectionState) &&
    Array.isArray(value.subsystems) &&
    value.subsystems.every(isSubsystemStatus) &&
    (value.diagnostics === undefined || isDiagnostics(value.diagnostics))
  );
}
