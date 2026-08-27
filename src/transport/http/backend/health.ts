import { isProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import { isRecord } from '../../../infra/json.js';
import { isSerializedCoralSetupError, type SerializedCoralSetupError } from '../../../runtime/errors.js';

/**
 * Health metadata exposed by the Coral backend over HTTP.
 *
 * Transport keeps a local copy because layering forbids importing coordinator
 * internals like the branded `RuntimeComponentId` — see HealthSnapshot in
 * src/transport/server-ports.ts.
 */
type TransportRuntimeComponentStatus =
  | { id: string; phase: 'initializing'; attempt: number }
  | { id: string; phase: 'online' }
  | {
      id: string;
      phase: 'degraded';
      reason:
        | { kind: 'curate-publish'; consecutiveFailures: number; lastError: string }
        | { kind: 'recovery-quarantine'; count: number; lastError: string };
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

type TextProjectionHealthState = 'idle' | 'fetching' | 'reindexing';

type TransportKbDaemonPhase = 'disabled' | 'starting' | 'online' | 'restarting' | 'stopping' | 'stopped' | 'failed';

type TransportKbDaemonRuntimeHealthPhase = 'not_initialized' | 'ready' | 'failed' | 'disposing' | 'disposed';

type TransportKbDaemonRuntimeHealth = {
  phase: TransportKbDaemonRuntimeHealthPhase;
  initializedAt?: number;
  lastError?: string;
  setupError?: SerializedCoralSetupError;
  curateRunning?: boolean;
  mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
};

type TransportKbDaemonHealthSnapshot = {
  enabled: boolean;
  phase: TransportKbDaemonPhase;
  generation: number;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  entrypoint?: string;
  pendingRequests?: number;
  lastHeartbeatAt?: number;
  lastHeartbeatLatencyMs?: number;
  daemonUptimeMs?: number;
  kbRead?: TransportKbDaemonRuntimeHealth;
  kbWrite?: TransportKbDaemonRuntimeHealth;
  reason?: string;
  lastExit?: {
    code: number | null;
    signal: string | null;
    at: number;
    uptimeMs: number | null;
  };
  lastError?: string;
  setupError?: SerializedCoralSetupError;
};

export interface BackendHealth {
  /**
   * Strict-enum status field for clients that validate
   * `'starting' | 'ok' | 'draining'`. Consumers that need the full lifecycle
   * read `kernel.phase`.
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
  /** Build namespace is provenance, not ownership scope. */
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
  components: TransportRuntimeComponentStatus[];
  /** Redacted daemon-owned provider routing: scope name and provider names only. */
  systemProviderScope?: { name: string; providers: string[] };
  kbDaemon?: TransportKbDaemonHealthSnapshot;
  diagnostics?: {
    carriers?: {
      coverage: 'complete' | 'unknown';
      liveJobs: number;
      unknownJobs: number;
      recoveryDefectJobs: number;
    };
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
    providerProxySets?: Array<{
      setIdentity: { buildSetId: string; hostFingerprint: string; proxyInstanceId: string };
      disposition: 'held' | 'awaiting-containment-absence';
      role?: string;
      method?: string;
      incidentReason: string;
      waitingFor: 'heartbeat-evidence-window' | 'independent-containment-absence';
    }>;
  };
}

export type BackendPing = {
  status: BackendHealth['status'];
  version: string;
  bundleHash: string;
  flavor: 'prod' | 'dev';
  namespace: string;
  instanceId: string;
  pid: number;
  incarnation?: ProcessIncarnation;
};

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

function isProviderProxySets(value: unknown): value is NonNullable<BackendHealth['diagnostics']>['providerProxySets'] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.setIdentity) &&
        typeof entry.setIdentity.buildSetId === 'string' &&
        typeof entry.setIdentity.hostFingerprint === 'string' &&
        typeof entry.setIdentity.proxyInstanceId === 'string' &&
        (entry.disposition === 'held' || entry.disposition === 'awaiting-containment-absence') &&
        (entry.role === undefined || typeof entry.role === 'string') &&
        (entry.method === undefined || typeof entry.method === 'string') &&
        typeof entry.incidentReason === 'string' &&
        (entry.waitingFor === 'heartbeat-evidence-window' || entry.waitingFor === 'independent-containment-absence'),
    )
  );
}

function isDegradedReason(
  value: unknown,
): value is Extract<TransportRuntimeComponentStatus, { phase: 'degraded' }>['reason'] {
  if (!isRecord(value) || typeof value.lastError !== 'string') {
    return false;
  }
  switch (value.kind) {
    case 'curate-publish':
      return Number.isFinite(value.consecutiveFailures);
    case 'recovery-quarantine':
      return isNonNegativeInteger(value.count);
    default:
      return false;
  }
}

function isOfflineDiagnostic(
  value: unknown,
): value is Extract<TransportRuntimeComponentStatus, { phase: 'offline' }>['diagnostic'] {
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

function isRuntimeComponentStatus(value: unknown): value is TransportRuntimeComponentStatus {
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

function isKbDaemonPhase(value: unknown): value is TransportKbDaemonPhase {
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

function isKbDaemonExit(value: unknown): value is NonNullable<TransportKbDaemonHealthSnapshot['lastExit']> {
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

function isKbDaemonRuntimeHealth(value: unknown): value is TransportKbDaemonRuntimeHealth {
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
    (value.setupError === undefined || isSerializedCoralSetupError(value.setupError)) &&
    (value.curateRunning === undefined || typeof value.curateRunning === 'boolean') &&
    (value.mutationBlocked === undefined || isMutationBlocked(value.mutationBlocked))
  );
}

function isKbDaemonHealth(value: unknown): value is TransportKbDaemonHealthSnapshot {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    isKbDaemonPhase(value.phase) &&
    Number.isInteger(value.generation) &&
    (value.pid === null || Number.isInteger(value.pid)) &&
    (value.startedAt === null || Number.isFinite(value.startedAt)) &&
    (value.readyAt === null || Number.isFinite(value.readyAt)) &&
    (value.entrypoint === undefined || typeof value.entrypoint === 'string') &&
    (value.pendingRequests === undefined || isNonNegativeInteger(value.pendingRequests)) &&
    (value.lastHeartbeatAt === undefined || isNonNegativeFiniteNumber(value.lastHeartbeatAt)) &&
    (value.lastHeartbeatLatencyMs === undefined || isNonNegativeFiniteNumber(value.lastHeartbeatLatencyMs)) &&
    (value.daemonUptimeMs === undefined || isNonNegativeFiniteNumber(value.daemonUptimeMs)) &&
    (value.kbRead === undefined || isKbDaemonRuntimeHealth(value.kbRead)) &&
    (value.kbWrite === undefined || isKbDaemonRuntimeHealth(value.kbWrite)) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.lastExit === undefined || isKbDaemonExit(value.lastExit)) &&
    (value.lastError === undefined || typeof value.lastError === 'string') &&
    (value.setupError === undefined || isSerializedCoralSetupError(value.setupError))
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
  if (value.providerProxySets !== undefined && !isProviderProxySets(value.providerProxySets)) {
    return false;
  }
  if (
    value.carriers !== undefined &&
    (!isRecord(value.carriers) ||
      (value.carriers.coverage !== 'complete' && value.carriers.coverage !== 'unknown') ||
      !isNonNegativeInteger(value.carriers.liveJobs) ||
      !isNonNegativeInteger(value.carriers.unknownJobs) ||
      !isNonNegativeInteger(value.carriers.recoveryDefectJobs))
  ) {
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

function isSystemProviderScope(value: unknown): value is NonNullable<BackendHealth['systemProviderScope']> {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    Array.isArray(value.providers) &&
    value.providers.every((provider) => typeof provider === 'string' && provider.length > 0)
  );
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
    Array.isArray(value.components) &&
    value.components.every(isRuntimeComponentStatus) &&
    (value.systemProviderScope === undefined || isSystemProviderScope(value.systemProviderScope)) &&
    (value.kbDaemon === undefined || isKbDaemonHealth(value.kbDaemon)) &&
    (value.diagnostics === undefined || isDiagnostics(value.diagnostics))
  );
}

export function isBackendPing(value: unknown): value is BackendPing {
  return (
    isRecord(value) &&
    (value.status === 'starting' || value.status === 'ok' || value.status === 'draining') &&
    typeof value.version === 'string' &&
    typeof value.bundleHash === 'string' &&
    (value.flavor === 'prod' || value.flavor === 'dev') &&
    typeof value.instanceId === 'string' &&
    typeof value.namespace === 'string' &&
    value.namespace.length > 0 &&
    Number.isInteger(value.pid) &&
    (value.incarnation === undefined || isProcessIncarnation(value.incarnation))
  );
}
