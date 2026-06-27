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
  | {
      id: string;
      phase: 'offline';
      reason: string;
      lastLogLine?: string;
      diagnostic?: {
        attempts?: number;
        failedStep?: string;
        retry?: 'restart-daemon' | 'none';
        lastErrorStack?: string;
      };
    };

export type TextProjectionHealthState = 'idle' | 'fetching' | 'reindexing';

export type TransportKbChildPhase =
  | 'disabled'
  | 'starting'
  | 'online'
  | 'restarting'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type TransportKbChildRuntimeHealthPhase = 'not_initialized' | 'ready' | 'failed' | 'disposing' | 'disposed';

export type TransportKbChildRuntimeHealth = {
  phase: TransportKbChildRuntimeHealthPhase;
  initializedAt?: number;
  lastError?: string;
  curateRunning?: boolean;
};

export type TransportKbChildHealthSnapshot = {
  enabled: boolean;
  phase: TransportKbChildPhase;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  entrypoint?: string;
  pendingRequests?: number;
  lastHeartbeatAt?: number;
  lastHeartbeatLatencyMs?: number;
  childUptimeMs?: number;
  kbRead?: TransportKbChildRuntimeHealth;
  kbWrite?: TransportKbChildRuntimeHealth;
  reason?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: number;
    uptimeMs: number | null;
  };
  lastError?: string;
};

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
  resources?: {
    rssBytes: number;
    heapUsedBytes: number;
    eventLoopLagMs: number;
    ipcOpenSockets: number;
    eventStreamResponses: number;
    fdCount?: number;
  };
  subsystems: TransportSubsystemStatus[];
  kbChild?: TransportKbChildHealthSnapshot;
  diagnostics?: {
    mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
    consumerStuck?: Array<{
      id: string;
      elapsedSinceStopMs: number;
      authority?: 'journal' | 'corpus';
      cursor?: number;
      snapshotId?: string | null;
      contentSeq?: number;
      metadataSeq?: number;
    }>;
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

function isConsumerStuck(value: unknown): value is NonNullable<BackendHealth['diagnostics']>['consumerStuck'] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !Number.isFinite(entry.elapsedSinceStopMs)) {
      return false;
    }
    if (entry.authority !== undefined && entry.authority !== 'journal' && entry.authority !== 'corpus') {
      return false;
    }
    if (entry.cursor !== undefined && !Number.isFinite(entry.cursor)) {
      return false;
    }
    if (entry.snapshotId !== undefined && entry.snapshotId !== null && typeof entry.snapshotId !== 'string') {
      return false;
    }
    if (entry.contentSeq !== undefined && !Number.isFinite(entry.contentSeq)) {
      return false;
    }
    return entry.metadataSeq === undefined || Number.isFinite(entry.metadataSeq);
  });
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

function isOfflineDiagnostic(
  value: unknown,
): value is Extract<TransportSubsystemStatus, { phase: 'offline' }>['diagnostic'] {
  if (!isRecord(value)) {
    return false;
  }
  if (value.attempts !== undefined) {
    const attempts = value.attempts;
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) {
      return false;
    }
  }
  if (value.failedStep !== undefined && typeof value.failedStep !== 'string') {
    return false;
  }
  if (value.retry !== undefined && value.retry !== 'restart-daemon' && value.retry !== 'none') {
    return false;
  }
  return value.lastErrorStack === undefined || typeof value.lastErrorStack === 'string';
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
        typeof value.reason === 'string' &&
        (value.lastLogLine === undefined || typeof value.lastLogLine === 'string') &&
        (value.diagnostic === undefined || isOfflineDiagnostic(value.diagnostic))
      );
    default:
      return false;
  }
}

function isTextProjectionState(value: unknown): value is TextProjectionHealthState {
  return value === 'idle' || value === 'fetching' || value === 'reindexing';
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isKbChildPhase(value: unknown): value is TransportKbChildPhase {
  return (
    value === 'disabled' ||
    value === 'starting' ||
    value === 'online' ||
    value === 'restarting' ||
    value === 'stopping' ||
    value === 'stopped' ||
    value === 'failed'
  );
}

function isKbChildExit(value: unknown): value is NonNullable<TransportKbChildHealthSnapshot['lastExit']> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.code === null || Number.isInteger(value.code)) &&
    (value.signal === null || typeof value.signal === 'string') &&
    Number.isFinite(value.at) &&
    (value.uptimeMs === null || Number.isFinite(value.uptimeMs))
  );
}

function isKbChildRuntimeHealth(value: unknown): value is TransportKbChildRuntimeHealth {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.phase === 'not_initialized' ||
      value.phase === 'ready' ||
      value.phase === 'failed' ||
      value.phase === 'disposing' ||
      value.phase === 'disposed') &&
    (value.initializedAt === undefined || isNonNegativeFiniteNumber(value.initializedAt)) &&
    (value.lastError === undefined || typeof value.lastError === 'string') &&
    (value.curateRunning === undefined || typeof value.curateRunning === 'boolean')
  );
}

function isKbChildHealth(value: unknown): value is TransportKbChildHealthSnapshot {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isKbChildPhase(value.phase) &&
    Number.isInteger(value.generation) &&
    (value.pid === null || Number.isInteger(value.pid)) &&
    (value.startedAt === null || Number.isFinite(value.startedAt)) &&
    (value.readyAt === null || Number.isFinite(value.readyAt)) &&
    (value.entrypoint === undefined || typeof value.entrypoint === 'string') &&
    (value.pendingRequests === undefined || isNonNegativeInteger(value.pendingRequests)) &&
    (value.lastHeartbeatAt === undefined || isNonNegativeFiniteNumber(value.lastHeartbeatAt)) &&
    (value.lastHeartbeatLatencyMs === undefined || isNonNegativeFiniteNumber(value.lastHeartbeatLatencyMs)) &&
    (value.childUptimeMs === undefined || isNonNegativeFiniteNumber(value.childUptimeMs)) &&
    (value.kbRead === undefined || isKbChildRuntimeHealth(value.kbRead)) &&
    (value.kbWrite === undefined || isKbChildRuntimeHealth(value.kbWrite)) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.lastExit === undefined || isKbChildExit(value.lastExit)) &&
    (value.lastError === undefined || typeof value.lastError === 'string')
  );
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

function isResources(value: unknown): value is NonNullable<BackendHealth['resources']> {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !Number.isFinite(value.rssBytes) ||
    !Number.isFinite(value.heapUsedBytes) ||
    !Number.isFinite(value.eventLoopLagMs) ||
    !Number.isInteger(value.ipcOpenSockets) ||
    !Number.isInteger(value.eventStreamResponses)
  ) {
    return false;
  }
  return value.fdCount === undefined || Number.isInteger(value.fdCount);
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
    (value.resources === undefined || isResources(value.resources)) &&
    Array.isArray(value.subsystems) &&
    value.subsystems.every(isSubsystemStatus) &&
    (value.kbChild === undefined || isKbChildHealth(value.kbChild)) &&
    (value.diagnostics === undefined || isDiagnostics(value.diagnostics))
  );
}
