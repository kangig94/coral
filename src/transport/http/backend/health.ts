import { isProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import { isRecord } from '../../../infra/json.js';
import { isSerializedCoralSetupError, type SerializedCoralSetupError } from '../../../runtime/errors.js';
import {
  providerProxySetEnforcerObservationsSchema,
  type ProviderProxySetEnforcerObservations,
} from '../../../provider-proxy/containment-proof-contract.js';
import { decodeProviderProxySetAddress } from '../../../provider-proxy/set-address.js';

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
      setToken: string;
      disposition: 'held' | 'awaiting-containment-absence' | 'operator-exit-refused';
      role?: string;
      method?: string;
      cause?: 'closed' | 'invalid-unattributable-frame';
      attempts?: number;
      elapsedMs?: number;
      boundMs?: number;
      liveClaims?: number;
      enforcerObservations?: ProviderProxySetEnforcerObservations;
      incidentReason: string;
      waitingFor:
        | 'heartbeat-evidence-window'
        | 'control-reattachment'
        | 'independent-containment-absence'
        | 'ordinary-drain'
        | 'set-adoption-deadline'
        | 'operator-abandonment'
        | 'store-repair';
    }>;
  };
}

/** A decoded health payload plus any provider-proxy rows omitted because this build cannot interpret them. */
export type BackendHealthParseResult = Readonly<{
  health: BackendHealth;
  skippedProviderProxySetRows: number;
  skippedProviderProxySetTokens: readonly string[];
}>;

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

type ProviderProxySet = NonNullable<NonNullable<BackendHealth['diagnostics']>['providerProxySets']>[number];

type ProviderProxySetsParseResult = Readonly<{
  understoodRows: ProviderProxySet[];
  skippedRows: number;
  skippedSetTokens: string[];
}>;

function parseProviderProxySets(value: unknown): ProviderProxySetsParseResult | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const understoodRows: ProviderProxySet[] = [];
  let skippedRows = 0;
  const skippedSetTokens: string[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.setIdentity) ||
      typeof entry.setIdentity.buildSetId !== 'string' ||
      typeof entry.setIdentity.hostFingerprint !== 'string' ||
      typeof entry.setIdentity.proxyInstanceId !== 'string' ||
      typeof entry.setToken !== 'string'
    ) {
      skippedRows += 1;
      continue;
    }

    let tokenAddress: ReturnType<typeof decodeProviderProxySetAddress>;
    try {
      tokenAddress = decodeProviderProxySetAddress(entry.setToken);
    } catch {
      skippedRows += 1;
      continue;
    }
    if (
      tokenAddress.buildSetId !== entry.setIdentity.buildSetId ||
      tokenAddress.hostFingerprint !== entry.setIdentity.hostFingerprint ||
      tokenAddress.proxyInstanceId !== entry.setIdentity.proxyInstanceId
    ) {
      skippedRows += 1;
      continue;
    }

    if (
      typeof entry.disposition !== 'string' ||
      (entry.cause !== undefined && typeof entry.cause !== 'string') ||
      typeof entry.incidentReason !== 'string' ||
      typeof entry.waitingFor !== 'string'
    ) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }

    const understandsEnums =
      (entry.disposition === 'held' ||
        entry.disposition === 'awaiting-containment-absence' ||
        entry.disposition === 'operator-exit-refused') &&
      (entry.cause === undefined || entry.cause === 'closed' || entry.cause === 'invalid-unattributable-frame') &&
      (entry.waitingFor === 'heartbeat-evidence-window' ||
        entry.waitingFor === 'control-reattachment' ||
        entry.waitingFor === 'independent-containment-absence' ||
        entry.waitingFor === 'ordinary-drain' ||
        entry.waitingFor === 'set-adoption-deadline' ||
        entry.waitingFor === 'operator-abandonment' ||
        entry.waitingFor === 'store-repair');
    if (!understandsEnums) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }

    if (
      (entry.role !== undefined && typeof entry.role !== 'string') ||
      (entry.method !== undefined && typeof entry.method !== 'string') ||
      (entry.attempts !== undefined && !isNonNegativeInteger(entry.attempts)) ||
      (entry.elapsedMs !== undefined && !isNonNegativeFiniteNumber(entry.elapsedMs)) ||
      (entry.boundMs !== undefined && !isNonNegativeFiniteNumber(entry.boundMs)) ||
      (entry.liveClaims !== undefined && !isNonNegativeInteger(entry.liveClaims)) ||
      (entry.cause !== undefined &&
        (entry.attempts === undefined ||
          entry.elapsedMs === undefined ||
          entry.boundMs === undefined ||
          entry.liveClaims === undefined))
    ) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }

    const enforcerObservations =
      entry.enforcerObservations === undefined
        ? undefined
        : providerProxySetEnforcerObservationsSchema.safeParse(entry.enforcerObservations);
    if (enforcerObservations !== undefined && !enforcerObservations.success) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }

    understoodRows.push({
      ...entry,
      ...(enforcerObservations === undefined ? {} : { enforcerObservations: enforcerObservations.data }),
    } as ProviderProxySet);
  }

  return { understoodRows, skippedRows, skippedSetTokens };
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

type DiagnosticsParseResult = Readonly<{
  diagnostics: NonNullable<BackendHealth['diagnostics']>;
  skippedProviderProxySetRows: number;
  skippedProviderProxySetTokens: readonly string[];
}>;

function parseDiagnostics(value: unknown): DiagnosticsParseResult | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.mutationBlocked !== undefined && !isMutationBlocked(value.mutationBlocked)) {
    return null;
  }
  if (value.consumerStuck !== undefined && !isConsumerStuck(value.consumerStuck)) {
    return null;
  }
  const providerProxySets =
    value.providerProxySets === undefined ? null : parseProviderProxySets(value.providerProxySets);
  if (value.providerProxySets !== undefined && providerProxySets === null) {
    return null;
  }
  if (
    value.carriers !== undefined &&
    (!isRecord(value.carriers) ||
      (value.carriers.coverage !== 'complete' && value.carriers.coverage !== 'unknown') ||
      !isNonNegativeInteger(value.carriers.liveJobs) ||
      !isNonNegativeInteger(value.carriers.unknownJobs) ||
      !isNonNegativeInteger(value.carriers.recoveryDefectJobs))
  ) {
    return null;
  }
  return {
    diagnostics: {
      ...value,
      ...(providerProxySets === null ? {} : { providerProxySets: providerProxySets.understoodRows }),
    },
    skippedProviderProxySetRows: providerProxySets?.skippedRows ?? 0,
    skippedProviderProxySetTokens: providerProxySets?.skippedSetTokens ?? [],
  } as DiagnosticsParseResult;
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

export function parseBackendHealth(value: unknown): BackendHealthParseResult | null {
  if (
    !isRecord(value) ||
    (value.status !== 'starting' && value.status !== 'ok' && value.status !== 'draining') ||
    !isKernel(value.kernel) ||
    typeof value.version !== 'string' ||
    typeof value.bundleHash !== 'string' ||
    (value.flavor !== 'prod' && value.flavor !== 'dev') ||
    typeof value.instanceId !== 'string' ||
    typeof value.namespace !== 'string' ||
    value.namespace.length === 0 ||
    !Number.isFinite(value.uptimeMs) ||
    !Number.isInteger(value.active) ||
    !Number.isInteger(value.activeJobs) ||
    !Number.isInteger(value.inflightRequests) ||
    !Number.isInteger(value.queueDepth) ||
    !isTextProjectionState(value.textProjectionState) ||
    (value.resources !== undefined && !isResources(value.resources)) ||
    !Array.isArray(value.components) ||
    !value.components.every(isRuntimeComponentStatus) ||
    (value.systemProviderScope !== undefined && !isSystemProviderScope(value.systemProviderScope)) ||
    (value.kbDaemon !== undefined && !isKbDaemonHealth(value.kbDaemon))
  ) {
    return null;
  }

  const diagnostics = value.diagnostics === undefined ? null : parseDiagnostics(value.diagnostics);
  if (value.diagnostics !== undefined && diagnostics === null) {
    return null;
  }

  return {
    health: {
      ...value,
      ...(diagnostics === null ? {} : { diagnostics: diagnostics.diagnostics }),
    } as BackendHealth,
    skippedProviderProxySetRows: diagnostics?.skippedProviderProxySetRows ?? 0,
    skippedProviderProxySetTokens: diagnostics?.skippedProviderProxySetTokens ?? [],
  };
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
