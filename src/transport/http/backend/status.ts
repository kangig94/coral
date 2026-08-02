import { readBackendInfo } from '../../../infra/backend-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { isRecord } from '../../../infra/json.js';
import { isProcessAlive } from '../../../infra/node-process.js';
import type { StoragePort } from '../../../infra/port-types.js';
import { parseIsoTimestamp } from '../../../infra/time.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { isBackendHealth, isBackendPing, type BackendHealth } from './health.js';
import { TransientHttpError } from '../../../infra/http-errors.js';

const RECENT_STARTUP_DIAGNOSTIC_MS = 5 * 60_000;

type BackendStatus =
  | {
      // CLI-level verdict. The daemon-side coarse lifecycle field
      // (`'starting' | 'ok' | 'draining'`) is preserved as `health.status`
      // inside the nested `BackendHealth` payload via `BackendStatusFull`.
      status: 'ok';
      version: string;
      bundleHash: string;
      instanceId: string;
      uptimeMs: number;
      active: number;
      activeJobs: number;
      inflightRequests: number;
      queueDepth?: number;
      kernel: BackendHealth['kernel'];
      textProjectionState: BackendHealth['textProjectionState'];
      components: BackendHealth['components'];
      systemProviderScope?: BackendHealth['systemProviderScope'];
      diagnostics?: BackendHealth['diagnostics'];
    }
  | {
      status: 'shutting_down';
    };

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' }
  | { status: 'recent_failure'; phase: string; reason: string };

type RecentFailureStatus = Extract<BackendStatusFull, { status: 'recent_failure' }>;

export function statusFromStartupDiagnostic(
  value: unknown,
  now: number,
  earliestRecordedAt = Number.NEGATIVE_INFINITY,
): RecentFailureStatus | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.state !== 'stopped_with_diagnostic' ||
    value.retryable !== false ||
    typeof value.phase !== 'string' ||
    value.phase.length === 0 ||
    typeof value.recordedAt !== 'string'
  ) {
    return null;
  }

  const recordedAt = parseIsoTimestamp(value.recordedAt);
  // A status probe has no spawn-attempt ID to compare. Five minutes covers the
  // 5s bind and 15s readiness budgets plus operator handoff, while proving only
  // a recent failed attempt, not an ongoing loop. The discovery start time also
  // prevents a prior attempt's diagnostic from describing a newer daemon.
  if (
    !Number.isFinite(recordedAt) ||
    recordedAt < earliestRecordedAt ||
    recordedAt > now ||
    now - recordedAt > RECENT_STARTUP_DIAGNOSTIC_MS
  ) {
    return null;
  }

  const reason = deepestDiagnosticErrorMessage(value.error);
  return reason === null ? null : { status: 'recent_failure', phase: value.phase, reason };
}

function deepestDiagnosticErrorMessage(error: unknown): string | null {
  let current = error;
  let reason: string | null = null;
  while (isRecord(current)) {
    if (typeof current.message === 'string' && current.message.trim().length > 0) {
      reason = current.message.trim().replace(/\s+/g, ' ');
    }
    current = current.cause;
  }
  return reason;
}

function noDaemonStatus(
  storage: Pick<StoragePort, 'readFileSync'>,
  diagnosticFile: string,
  now: number,
  earliestRecordedAt?: number,
): BackendStatusFull {
  try {
    const value: unknown = JSON.parse(storage.readFileSync(diagnosticFile, 'utf-8'));
    return statusFromStartupDiagnostic(value, now, earliestRecordedAt) ?? { status: 'not_running' };
  } catch {
    return { status: 'not_running' };
  }
}

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  const info = readBackendInfo({
    storage: runtime.storage,
    env: runtime.env,
    paths: runtime.paths,
  });
  if (!info || !isProcessAlive(info.pid)) {
    return noDaemonStatus(
      runtime.storage,
      runtime.paths.coral.coordinator.startupDiagnosticFile,
      runtime.time.now(),
      info?.startedAt,
    );
  }

  const unreachableStatus = (): BackendStatusFull =>
    noDaemonStatus(
      runtime.storage,
      runtime.paths.coral.coordinator.startupDiagnosticFile,
      runtime.time.now(),
      info.startedAt,
    );

  try {
    const pingResponse = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const pingBody = await parseJsonResponse(pingResponse);
    if (pingResponse.status === 200) {
      if (!isBackendPing(pingBody) || pingBody.namespace !== info.namespace || pingBody.flavor !== info.flavor) {
        return unreachableStatus();
      }
      if (pingBody.status === 'draining') {
        return { status: 'shutting_down' };
      }
    } else if (pingResponse.status === 503 || TransientHttpError.isTransientStatus(pingResponse.status)) {
      return { status: 'shutting_down' };
    } else {
      return unreachableStatus();
    }

    const healthResponse = await fetch(`http://${info.host}:${info.port}/health?detailed=1`, {
      method: 'GET',
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(healthResponse);
    if (healthResponse.status === 200) {
      if (!isBackendHealth(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
        return unreachableStatus();
      }
      if (body.status === 'draining') {
        return { status: 'shutting_down' };
      }
      const { namespace: _namespace, status: _status, ...rest } = body;
      return { status: 'ok', health: { ...rest, status: 'ok' as const } };
    }
    if (healthResponse.status === 503 || TransientHttpError.isTransientStatus(healthResponse.status)) {
      return { status: 'shutting_down' };
    }
    if (healthResponse.status === 401) return { status: 'unauthorized' };
    return unreachableStatus();
  } catch {
    return unreachableStatus();
  }
}
