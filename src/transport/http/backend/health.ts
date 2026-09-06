import { isProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import { isRecord } from '../../../infra/json.js';
import { isSerializedCoralSetupError, type SerializedCoralSetupError } from '../../../runtime/errors.js';
import { providerProxySetEnforcerObservationsSchema } from '../../../provider-proxy/containment-proof-contract.js';
import { decodeProviderProxySetAddress } from '../../../provider-proxy/set-address.js';
import {
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS,
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES,
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR,
  type ProviderProxySetOperatorDisposition,
  type ProviderProxySetDurableDispositionSkipStatus,
  type ProviderProxySetOperatorExit,
  type ProviderProxySetOperatorStatus,
} from '../../../provider-proxy/operator-disposition-vocabulary.js';

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
    providerProxySets?: ProviderProxySetOperatorStatus[];
    providerProxyDispositionSkips?: ProviderProxySetDurableDispositionSkipStatus[];
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

function isBackendNamespaceToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
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

type ProviderProxySet = NonNullable<NonNullable<BackendHealth['diagnostics']>['providerProxySets']>[number];

type ProviderProxySetsParseResult = Readonly<{
  understoodRows: ProviderProxySet[];
  skippedRows: number;
  skippedSetTokens: string[];
}>;

const PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS = [
  'enforcer-alive',
  'enforcer-unobservable',
  'recorded-group-unattributable',
  'signal-authorization-refused',
  'identity-unobservable',
  'store-unreadable',
  'representation-release-fatal',
] as const;

function parseProviderProxySetOperatorExit(value: unknown): ProviderProxySetOperatorExit | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'none':
    case 'contain':
    case 'abandon':
      return { kind: value.kind };
    case 'gated':
      return isNonNegativeFiniteNumber(value.remainingMs) ? { kind: 'gated', remainingMs: value.remainingMs } : null;
    case 'refused':
      return (PROVIDER_PROXY_SET_OPERATOR_EXIT_REFUSAL_GROUNDS as readonly unknown[]).includes(value.ground)
        ? {
            kind: 'refused',
            ground: value.ground as Extract<ProviderProxySetOperatorExit, { kind: 'refused' }>['ground'],
          }
        : null;
    default:
      return null;
  }
}

function parseProviderProxySetHold(value: unknown): ProviderProxySet['holds'][number] | null {
  if (
    !isRecord(value) ||
    typeof value.disposition !== 'string' ||
    (value.cause !== undefined && typeof value.cause !== 'string') ||
    typeof value.incidentReason !== 'string' ||
    typeof value.waitingFor !== 'string' ||
    !(PROVIDER_PROXY_SET_OPERATOR_DISPOSITIONS as readonly string[]).includes(value.disposition) ||
    (value.cause !== undefined &&
      !(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_CAUSES as readonly string[]).includes(value.cause)) ||
    !(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_WAITING_FOR as readonly string[]).includes(value.waitingFor) ||
    (value.role !== undefined && typeof value.role !== 'string') ||
    (value.method !== undefined && typeof value.method !== 'string') ||
    (value.attempts !== undefined && !isNonNegativeInteger(value.attempts)) ||
    (value.elapsedMs !== undefined && !isNonNegativeFiniteNumber(value.elapsedMs)) ||
    (value.boundMs !== undefined && !isNonNegativeFiniteNumber(value.boundMs)) ||
    (value.cause !== undefined &&
      (value.attempts === undefined || value.elapsedMs === undefined || value.boundMs === undefined))
  ) {
    return null;
  }
  const observations =
    value.enforcerObservations === undefined
      ? undefined
      : providerProxySetEnforcerObservationsSchema.safeParse(value.enforcerObservations);
  if (observations !== undefined && !observations.success) return null;
  let durableObservation: ProviderProxySetOperatorDisposition['durableObservation'];
  if (value.durableObservation !== undefined) {
    if (!isRecord(value.durableObservation) || typeof value.durableObservation.writerIncarnation !== 'string') {
      return null;
    }
    switch (value.durableObservation.kind) {
      case 'stale':
        if (
          value.durableObservation.reobserveAction !== 'automatic-exact-set-containment-observation' &&
          value.durableObservation.reobserveAction !== 'automatic-exact-acquisition-containment-observation'
        ) {
          return null;
        }
        durableObservation = {
          kind: 'stale',
          writerIncarnation: value.durableObservation.writerIncarnation,
          reobserveAction: value.durableObservation.reobserveAction,
        };
        break;
      case 'current-writer':
        durableObservation = {
          kind: 'current-writer',
          writerIncarnation: value.durableObservation.writerIncarnation,
        };
        break;
      case 'successor-observed':
        if (typeof value.durableObservation.observedByIncarnation !== 'string') return null;
        durableObservation = {
          kind: 'successor-observed',
          writerIncarnation: value.durableObservation.writerIncarnation,
          observedByIncarnation: value.durableObservation.observedByIncarnation,
        };
        break;
      default:
        return null;
    }
  }
  return {
    disposition: value.disposition as ProviderProxySetOperatorDisposition['disposition'],
    ...(value.role === undefined ? {} : { role: value.role }),
    ...(value.method === undefined ? {} : { method: value.method }),
    ...(value.cause === undefined
      ? {}
      : {
          cause: value.cause as ProviderProxySetOperatorDisposition['cause'],
          attempts: value.attempts as number,
          elapsedMs: value.elapsedMs as number,
          boundMs: value.boundMs as number,
        }),
    ...(observations === undefined ? {} : { enforcerObservations: observations.data }),
    incidentReason: value.incidentReason,
    waitingFor: value.waitingFor as ProviderProxySetOperatorDisposition['waitingFor'],
    ...(durableObservation === undefined ? {} : { durableObservation }),
  };
}

function parseProviderProxyDispositionSkips(value: unknown): ProviderProxySetDurableDispositionSkipStatus[] | null {
  if (!Array.isArray(value)) return null;
  const records: ProviderProxySetDurableDispositionSkipStatus[] = [];
  for (const record of value) {
    if (
      !isRecord(record) ||
      typeof record.key !== 'string' ||
      (record.setToken !== null && typeof record.setToken !== 'string') ||
      record.unavailableAction !== 'reconciliation-and-retirement'
    ) {
      return null;
    }
    records.push({
      key: record.key,
      setToken: record.setToken,
      unavailableAction: 'reconciliation-and-retirement',
    });
  }
  return records;
}

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

    if (!isNonNegativeInteger(entry.liveClaims) || !Array.isArray(entry.holds)) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }
    const operatorExit = parseProviderProxySetOperatorExit(entry.operatorExit);
    const holds = entry.holds.map(parseProviderProxySetHold);
    if (operatorExit === null || holds.some((hold) => hold === null)) {
      skippedRows += 1;
      skippedSetTokens.push(entry.setToken);
      continue;
    }
    understoodRows.push({
      setIdentity: {
        buildSetId: entry.setIdentity.buildSetId,
        hostFingerprint: entry.setIdentity.hostFingerprint,
        proxyInstanceId: entry.setIdentity.proxyInstanceId,
      },
      setToken: entry.setToken,
      liveClaims: entry.liveClaims,
      operatorExit,
      holds: holds as ProviderProxySet['holds'],
    });
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
  const providerProxyDispositionSkips =
    value.providerProxyDispositionSkips === undefined
      ? null
      : parseProviderProxyDispositionSkips(value.providerProxyDispositionSkips);
  if (value.providerProxyDispositionSkips !== undefined && providerProxyDispositionSkips === null) return null;
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
      ...(providerProxyDispositionSkips === null ? {} : { providerProxyDispositionSkips }),
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
    !isBackendNamespaceToken(value.namespace) ||
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
    isBackendNamespaceToken(value.namespace) &&
    Number.isInteger(value.pid) &&
    (value.incarnation === undefined || isProcessIncarnation(value.incarnation))
  );
}
