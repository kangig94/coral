import { DEFAULT_DISCOVERY_HOST, readDiscoveryRecordDisposition } from '../../../infra/backend-discovery.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { errorMessage } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
import { observeProcessLiveness } from '../../../infra/node-process.js';
import type { StoragePort } from '../../../infra/port-types.js';
import { parseIsoTimestamp } from '../../../infra/time.js';
import { isSerializedCoralSetupError } from '../../../runtime/errors.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { isBackendHealth, isBackendPing, type BackendHealth } from './health.js';
import { TransientHttpError } from '../../../infra/http-errors.js';

const RECENT_STARTUP_DIAGNOSTIC_MS = 5 * 60_000;

type PublicDiagnosticPhase = 'startup_failed' | 'fatal_shutdown_error' | 'bootstrap_unhandled_rejection';

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
      /** Jobs in a live phase; build namespace is provenance and does not scope job ownership. */
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

/**
 * The user-facing half of a documented setup failure. Two things make it safe to
 * print, and neither is "it contains no interpolated values" — the authored
 * templates do interpolate Coral's own identifiers (a legacy path, a lease
 * holder, a base dir, a stored version). What holds the boundary is that the
 * sentences are authored per code rather than assembled from an exception, and
 * that `context` is dropped here: `serializeBootstrapError` persists it, and at
 * least one site deliberately stashes a raw `error.message` in it. An arbitrary
 * bootstrap exception's `message` and `stack` therefore stay in the coordinator
 * log. Widening this projection past these three fields reopens that path.
 */
export type PublicSetupErrorSummary = {
  readonly code: string;
  readonly userMessage: string;
  readonly remediation: string;
};

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' }
  /**
   * The discovery record exists and could not be read, so whether a coordinator is running is unknown. Kept
   * distinct from `not_running` because that is a claim, and this reader has not earned it: a truncated write
   * or a record shaped by a build this one rejects both produce it while a coordinator may be serving.
   */
  | { status: 'undecodable_record'; reason: 'corrupt-json' | 'shape-rejected' }
  /**
   * Something answers at the recorded address and did not give a usable answer — a non-2xx that is not a
   * drain, or a request that never completed. Distinct from `not_running`, which is reserved for an observed
   * absence and for a peer whose namespace or flavor says it is somebody else's coordinator, not ours.
   */
  | { status: 'unreachable'; detail: string }
  | { status: 'recent_failure'; phase: PublicDiagnosticPhase; setupError?: PublicSetupErrorSummary };

type RecentFailureStatus = Extract<BackendStatusFull, { status: 'recent_failure' }>;

function isPublicDiagnosticPhase(value: unknown): value is PublicDiagnosticPhase {
  return value === 'startup_failed' || value === 'fatal_shutdown_error' || value === 'bootstrap_unhandled_rejection';
}

export function statusFromStartupDiagnostic(
  value: unknown,
  now: number,
  earliestRecordedAt = Number.NEGATIVE_INFINITY,
  expectedPid?: number,
): RecentFailureStatus | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.state !== 'stopped_with_diagnostic' ||
    value.retryable !== false ||
    !isPublicDiagnosticPhase(value.phase) ||
    typeof value.recordedAt !== 'string' ||
    !isRecord(value.error)
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
    now - recordedAt > RECENT_STARTUP_DIAGNOSTIC_MS ||
    (expectedPid !== undefined && value.pid !== expectedPid)
  ) {
    return null;
  }

  const error = value.error;
  const setupError: PublicSetupErrorSummary | null =
    error.kind === 'coral_setup_error' && isSerializedCoralSetupError(error)
      ? { code: error.code, userMessage: error.userMessage, remediation: error.remediation }
      : null;

  return {
    status: 'recent_failure',
    phase: value.phase,
    ...(setupError === null ? {} : { setupError }),
  };
}

function noDaemonStatus(
  storage: Pick<StoragePort, 'readFileSync'>,
  diagnosticFile: string,
  now: number,
  earliestRecordedAt?: number,
  expectedPid?: number,
): BackendStatusFull {
  try {
    const value: unknown = JSON.parse(storage.readFileSync(diagnosticFile, 'utf-8'));
    return statusFromStartupDiagnostic(value, now, earliestRecordedAt, expectedPid) ?? { status: 'not_running' };
  } catch {
    return { status: 'not_running' };
  }
}

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  const discoveryRuntime = { storage: runtime.storage, env: runtime.env, paths: runtime.paths };

  // Two axes can each fail to answer, and both used to arrive as `not_running`. The process axis was already
  // handled below; the record axis was not — `readBackendInfo` returns `null` for a missing file and for one it
  // could not decode alike, so a truncated `coordinator.json` reported a confident absence while a coordinator
  // was serving. `.passthrough()` on the record schema makes the cross-version case realistic, not theoretical.
  const read = readDiscoveryRecordDisposition(discoveryRuntime);
  if (read.kind === 'undecodable') {
    return { status: 'undecodable_record', reason: read.reason };
  }

  // The decoded record, not `readBackendInfo`. That helper also answers `null` when `version` or `instanceId`
  // is absent, and this function reads neither — everything it uses (`startedAt`, `pid`, `host`, `port`,
  // `namespace`, `flavor`, `bootToken`) is on the record itself, and the version an operator sees comes from
  // the health response, not from the file. Routing through it reported a coordinator old enough to omit two
  // unused fields as not running while it was serving. An earlier revision of this comment defended that as a
  // display question; it was not one, because nothing here displays the record's version.
  const record = read.kind === 'record' ? read.record : null;
  const info = record === null ? null : { ...record, host: record.host ?? DEFAULT_DISCOVERY_HOST };
  // Only an observed absence reports not-running; an unanswerable probe is not that observation.
  if (!info || observeProcessLiveness(info.pid) === 'absent') {
    return noDaemonStatus(
      runtime.storage,
      runtime.paths.coral.coordinator.startupDiagnosticFile,
      runtime.time.now(),
      info?.startedAt,
      info?.pid,
    );
  }

  // Two answers, not one. `notOurCoordinator` is for a peer that identifies as a different namespace or
  // flavor: the thing on that socket is not this backend, so reporting this backend as not running is true,
  // and the startup diagnostic may still explain why ours is gone. `unreachable` is for our own coordinator
  // answering badly or not at all — something is there, addressed by our own record, and calling that "not
  // running" is a claim about a process that just replied.
  const notOurCoordinator = (): BackendStatusFull =>
    noDaemonStatus(
      runtime.storage,
      runtime.paths.coral.coordinator.startupDiagnosticFile,
      runtime.time.now(),
      info.startedAt,
      info.pid,
    );
  const unreachable = (detail: string): BackendStatusFull => ({ status: 'unreachable', detail });

  try {
    const pingResponse = await fetch(`http://${info.host}:${info.port}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const pingBody = await parseJsonResponse(pingResponse);
    if (pingResponse.status === 200) {
      if (!isBackendPing(pingBody) || pingBody.namespace !== info.namespace || pingBody.flavor !== info.flavor) {
        return notOurCoordinator();
      }
      if (pingBody.status === 'draining') {
        return { status: 'shutting_down' };
      }
    } else if (pingResponse.status === 503 || TransientHttpError.isTransientStatus(pingResponse.status)) {
      return { status: 'shutting_down' };
    } else {
      return unreachable(`health responded ${pingResponse.status}`);
    }

    const healthResponse = await fetch(`http://${info.host}:${info.port}/health?detailed=1`, {
      method: 'GET',
      headers: { 'X-Coral-Boot-Token': info.bootToken },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await parseJsonResponse(healthResponse);
    if (healthResponse.status === 200) {
      if (!isBackendHealth(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
        return notOurCoordinator();
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
    return unreachable(`detailed health responded ${healthResponse.status}`);
  } catch (error: unknown) {
    return unreachable(errorMessage(error));
  }
}
