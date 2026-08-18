import { observeCoordinator } from './coordinator-observation.js';
import { readBuildFlavor } from '../../../infra/bundle-manifest.js';
import { errorMessage } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
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
  | { status: 'undecodable_record'; reason: 'corrupt-json' | 'shape-rejected'; path: string }
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

/**
 * The unauthenticated `/health` ping. Returns a terminal status, or `null` to mean "this said nothing that
 * ends the question — go on to the detailed probe".
 *
 * Split out because the two probes are structurally the same shape (fetch, parse, check identity, check drain)
 * and reading them inline meant holding both in view at once to see that only one of them can return `ok`.
 */
async function probeUnauthenticatedPing(
  info: Readonly<{ host: string; port: number; namespace: string; flavor: string }>,
  notOurCoordinator: () => BackendStatusFull,
  unreachable: (detail: string) => BackendStatusFull,
): Promise<BackendStatusFull | null> {
  const response = await fetch(`http://${info.host}:${info.port}/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (response.status === 200) {
    if (!isBackendPing(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
      return notOurCoordinator();
    }
    return body.status === 'draining' ? { status: 'shutting_down' } : null;
  }
  if (response.status === 503 || TransientHttpError.isTransientStatus(response.status)) {
    return { status: 'shutting_down' };
  }
  return unreachable(`health responded ${response.status}`);
}

/** The authenticated `/health?detailed=1` probe. Always terminal: it is the last thing asked. */
async function probeDetailedHealth(
  info: Readonly<{ host: string; port: number; namespace: string; flavor: string; bootToken: string }>,
  notOurCoordinator: () => BackendStatusFull,
  unreachable: (detail: string) => BackendStatusFull,
): Promise<BackendStatusFull> {
  const response = await fetch(`http://${info.host}:${info.port}/health?detailed=1`, {
    method: 'GET',
    headers: { 'X-Coral-Boot-Token': info.bootToken },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (response.status === 200) {
    if (!isBackendHealth(body) || body.namespace !== info.namespace || body.flavor !== info.flavor) {
      return notOurCoordinator();
    }
    if (body.status === 'draining') {
      return { status: 'shutting_down' };
    }
    const { namespace: _namespace, status: _status, ...rest } = body;
    return { status: 'ok', health: { ...rest, status: 'ok' as const } };
  }
  if (response.status === 503 || TransientHttpError.isTransientStatus(response.status)) {
    return { status: 'shutting_down' };
  }
  if (response.status === 401) return { status: 'unauthorized' };
  return unreachable(`detailed health responded ${response.status}`);
}

export async function getBackendStatusFull(pluginRoot: string): Promise<BackendStatusFull> {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  const observed = observeCoordinator({
    storage: runtime.storage,
    env: runtime.env,
    paths: runtime.paths,
  });

  switch (observed.kind) {
    case 'unreadable-record':
      return { status: 'undecodable_record', reason: observed.reason, path: observed.path };
    case 'no-record':
      return noDaemonStatus(runtime.storage, runtime.paths.coral.coordinator.startupDiagnosticFile, runtime.time.now());
    case 'process-absent':
      // Absence is established, so the startup diagnostic may explain it — scoped to both halves of the dead
      // coordinator's identity, because either alone admits a diagnostic that is not this run's. A pid is
      // reused, so an old diagnostic naming the same number passes a pid-only check; a `startedAt` floor alone
      // admits any later run's. `notOurCoordinator` below passes the same pair for the same reason.
      return noDaemonStatus(
        runtime.storage,
        runtime.paths.coral.coordinator.startupDiagnosticFile,
        runtime.time.now(),
        observed.startedAt,
        observed.pid,
      );
    case 'addressed':
      break;
  }
  const info = observed.coordinator;

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
    const ping = await probeUnauthenticatedPing(info, notOurCoordinator, unreachable);
    if (ping !== null) return ping;
    return await probeDetailedHealth(info, notOurCoordinator, unreachable);
  } catch (error: unknown) {
    return unreachable(errorMessage(error));
  }
}
