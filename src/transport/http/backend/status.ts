import { observeCoordinator } from './coordinator-observation.js';
import { readBuildFlavor, resolveStrictBundleIdentity } from '../../../infra/bundle-manifest.js';
import { pluginRootNamespace } from '../../../infra/plugin-identity.js';
import { errorMessage, thrownErrnoCode } from '../../../infra/error-format.js';
import { isRecord } from '../../../infra/json.js';
import type { StoragePort } from '../../../infra/port-types.js';
import { parseIsoTimestamp } from '../../../infra/time.js';
import {
  readOperatorFacingCoralSetupError,
  resolveSetupErrorAuthorship,
  type OperatorFacingCoralSetupError,
  type SetupErrorAuthorIdentity,
} from '../../../runtime/errors.js';
import { createRealRuntime } from '../../../runtime/real.js';
import { HEALTH_TIMEOUT_MS, parseJsonResponse } from '../sse.js';
import { isBackendPing, parseBackendHealth, type BackendHealth } from './health.js';
import { TransientHttpError } from '../../../infra/http-errors.js';

const RECENT_STARTUP_DIAGNOSTIC_MS = 5 * 60_000;

type PublicDiagnosticPhase = 'startup_failed' | 'fatal_shutdown_error' | 'bootstrap_unhandled_rejection';

type BackendStatus =
  | {
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
      skippedProviderProxySetRows: number;
      skippedProviderProxySetTokens: readonly string[];
    }
  | {
      status: 'shutting_down';
    };

export type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' }
  | { status: 'no_record_no_socket' }
  | { status: 'recorded_process_absent'; pid: number }
  /**
   * An unreadable discovery record must not imply whether a coordinator is running: a truncated write or a
   * record shaped by a build this one rejects can both exist while a coordinator is serving.
   */
  | { status: 'undecodable_record'; reason: 'corrupt-json' | 'shape-rejected'; path: string }
  /**
   * The recorded address did not yield this coordinator's state — a non-2xx that is not a drain, a request that
   * never completed, a 200 whose body this build cannot decode (shape rejection), or a coordinator that
   * decoded and is not this one. A shape rejection proves neither absence nor a foreign identity; only a
   * decoded namespace/flavor mismatch may produce `'foreign_peer'`.
   *
   * `cause` is the one thing that decides what may be claimed about the address: `'responded'` is an actual
   * HTTP response (any status, any body) — the one thing that proves something is listening. `'refused'` is a
   * TCP-level refusal at the moment of the attempt — it proves nothing was listening on that exact socket at
   * that moment, but not that the coordinator process itself is gone, so it carries `pidLiveness`, the prior
   * observation of that specific question, plus the `pid` and `recordPath` a reader needs to settle it — a
   * refusal that keeps refusing is a record naming a pid something else now holds, and neither checking that
   * pid nor clearing that record is possible from a status that names neither. `'no_response'` is everything else that keeps a
   * request from completing (timeout, DNS failure, ...), which proves neither way.
   *
   * `'foreign_peer'` is a Coral coordinator that answered and named a namespace or flavor the discovery record
   * did not. The comparison is against that record's own identity, and the recorded HTTP port is ephemeral —
   * the coordinator binds port 0 — so the evidence supports one claim and no more: the recorded port is now
   * answered by a coordinator that did not write the record. It is not an ownership conflict over startup,
   * because this installation's coordinator is addressed by its own scoped IPC socket rather than by that
   * port, so it carries the same `pid`/`recordPath` as `'refused'` — the evidence a reader needs to settle a
   * record whose address something else now holds.
   */
  | { status: 'unreachable'; detail: string; cause: 'responded' }
  | {
      status: 'unreachable';
      detail: string;
      cause: 'refused';
      pidLiveness: 'alive' | 'unknown';
      pid: number;
      recordPath: string;
    }
  | { status: 'unreachable'; detail: string; cause: 'no_response' }
  | {
      status: 'unreachable';
      cause: 'foreign_peer';
      observed: { namespace: string; flavor: 'prod' | 'dev' };
      pid: number;
      recordPath: string;
    }
  /**
   * A surviving coordinator socket must not become an absence result: it may belong to a boot in progress or
   * be a stale leftover.
   */
  | { status: 'no_record_socket_present'; socketPath: string }
  | {
      status: 'recent_failure';
      phase: PublicDiagnosticPhase;
      retryable: boolean;
      /** Persisted diagnostic text and context must not cross this operator-facing boundary. */
      setupError?: OperatorFacingCoralSetupError;
    };

type RecentFailureStatus = Extract<BackendStatusFull, { status: 'recent_failure' }>;

function isPublicDiagnosticPhase(value: unknown): value is PublicDiagnosticPhase {
  return value === 'startup_failed' || value === 'fatal_shutdown_error' || value === 'bootstrap_unhandled_rejection';
}

function recordedAuthorIdentity(value: Record<string, unknown>): SetupErrorAuthorIdentity | null {
  return typeof value.bundleHash === 'string' && typeof value.namespace === 'string'
    ? { bundleHash: value.bundleHash, namespace: value.namespace }
    : null;
}

/**
 * `provenSelfIdentity` is deferred because proving this build's own identity hashes bundle artifacts; a status
 * probe that finds no setup-error diagnostic must not pay for an attribution it never makes.
 */
export function statusFromStartupDiagnostic(
  value: unknown,
  now: number,
  provenSelfIdentity: () => SetupErrorAuthorIdentity | null,
  earliestRecordedAt = Number.NEGATIVE_INFINITY,
  expectedPid?: number,
): RecentFailureStatus | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.state !== 'stopped_with_diagnostic' ||
    typeof value.retryable !== 'boolean' ||
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
  const setupError: OperatorFacingCoralSetupError | null =
    error.kind === 'coral_setup_error'
      ? readOperatorFacingCoralSetupError(
          error,
          resolveSetupErrorAuthorship({ recorded: recordedAuthorIdentity(value), self: provenSelfIdentity() }),
        )
      : null;

  return {
    status: 'recent_failure',
    phase: value.phase,
    retryable: value.retryable,
    ...(setupError === null ? {} : { setupError }),
  };
}

function readRecentFailureDiagnostic(
  storage: Pick<StoragePort, 'readFileSync'>,
  diagnosticFile: string,
  now: number,
  provenSelfIdentity: () => SetupErrorAuthorIdentity | null,
  earliestRecordedAt?: number,
  expectedPid?: number,
): RecentFailureStatus | null {
  try {
    const value: unknown = JSON.parse(storage.readFileSync(diagnosticFile, 'utf-8'));
    return statusFromStartupDiagnostic(value, now, provenSelfIdentity, earliestRecordedAt, expectedPid);
  } catch {
    return null;
  }
}

function noDaemonStatus(
  storage: Pick<StoragePort, 'readFileSync'>,
  diagnosticFile: string,
  now: number,
  provenSelfIdentity: () => SetupErrorAuthorIdentity | null,
  fallback: Extract<
    BackendStatusFull,
    { status: 'no_record_no_socket' | 'recorded_process_absent' } | { cause: 'foreign_peer' }
  >,
  earliestRecordedAt?: number,
  expectedPid?: number,
): BackendStatusFull {
  return (
    readRecentFailureDiagnostic(storage, diagnosticFile, now, provenSelfIdentity, earliestRecordedAt, expectedPid) ??
    fallback
  );
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
  notOurCoordinator: (observed: { namespace: string; flavor: 'prod' | 'dev' }) => BackendStatusFull,
  unreachable: (detail: string) => BackendStatusFull,
): Promise<BackendStatusFull | null> {
  const response = await fetch(`http://${info.host}:${info.port}/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (response.status === 200) {
    // A body this build cannot decode names no peer, so it may only be classified unreachable — never as
    // another coordinator's, and never as a coordinator that answered.
    if (!isBackendPing(body)) {
      return unreachable('health responded 200 with a body this build could not decode');
    }
    if (body.namespace !== info.namespace || body.flavor !== info.flavor) {
      return notOurCoordinator({ namespace: body.namespace, flavor: body.flavor });
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
  notOurCoordinator: (observed: { namespace: string; flavor: 'prod' | 'dev' }) => BackendStatusFull,
  unreachable: (detail: string) => BackendStatusFull,
): Promise<BackendStatusFull> {
  const response = await fetch(`http://${info.host}:${info.port}/health?detailed=1`, {
    method: 'GET',
    headers: { 'X-Coral-Boot-Token': info.bootToken },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const body = await parseJsonResponse(response);
  if (response.status === 200) {
    // Same split as the unauthenticated ping: a shape rejection says nothing about whose coordinator this is.
    const parsed = parseBackendHealth(body);
    if (parsed === null) {
      return unreachable('detailed health responded 200 with a body this build could not decode');
    }
    const { health, skippedProviderProxySetRows, skippedProviderProxySetTokens } = parsed;
    if (health.namespace !== info.namespace || health.flavor !== info.flavor) {
      return notOurCoordinator({ namespace: health.namespace, flavor: health.flavor });
    }
    if (health.status === 'draining') {
      return { status: 'shutting_down' };
    }
    const { namespace: _namespace, status: _status, ...rest } = health;
    return {
      status: 'ok',
      health: { ...rest, status: 'ok' as const, skippedProviderProxySetRows, skippedProviderProxySetTokens },
    };
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
  // Only a strictly proven bundle identity may claim authorship of a diagnostic: a hash read back without that
  // proof is not evidence, because a build that wrote nothing can read the same unproven value.
  const provenSelfIdentity = (): SetupErrorAuthorIdentity | null => {
    const strict = resolveStrictBundleIdentity();
    return strict.ok ? { bundleHash: strict.manifest.bundleHash, namespace: pluginRootNamespace(pluginRoot) } : null;
  };

  switch (observed.kind) {
    case 'unreadable-record':
      return { status: 'undecodable_record', reason: observed.reason, path: observed.path };
    case 'no-record':
      return noDaemonStatus(
        runtime.storage,
        runtime.paths.coral.coordinator.startupDiagnosticFile,
        runtime.time.now(),
        provenSelfIdentity,
        { status: 'no_record_no_socket' },
      );
    case 'no-record-socket-present':
      return (
        readRecentFailureDiagnostic(
          runtime.storage,
          runtime.paths.coral.coordinator.startupDiagnosticFile,
          runtime.time.now(),
          provenSelfIdentity,
        ) ?? { status: 'no_record_socket_present', socketPath: observed.socketPath }
      );
    case 'process-absent':
      // Diagnostic precedence must be scoped by both startedAt and pid; either alone can match another run.
      return noDaemonStatus(
        runtime.storage,
        runtime.paths.coral.coordinator.startupDiagnosticFile,
        runtime.time.now(),
        provenSelfIdentity,
        { status: 'recorded_process_absent', pid: observed.pid },
        observed.startedAt,
        observed.pid,
      );
    case 'addressed':
      break;
  }
  const info = observed.coordinator;

  // A decoded peer mismatch must retain the peer identity, regardless of the recorded pid's liveness.
  const notOurCoordinator = (observedIdentity: { namespace: string; flavor: 'prod' | 'dev' }): BackendStatusFull =>
    noDaemonStatus(
      runtime.storage,
      runtime.paths.coral.coordinator.startupDiagnosticFile,
      runtime.time.now(),
      provenSelfIdentity,
      {
        status: 'unreachable',
        cause: 'foreign_peer',
        observed: observedIdentity,
        pid: info.pid,
        recordPath: runtime.paths.coral.coordinator.infoFile,
      },
      info.startedAt,
      info.pid,
    );
  // Both probes only ever call this after `fetch` resolved a response, so `cause` is unconditionally
  // `'responded'` here; the `catch` below is the one place a request never completed, and builds its own
  // `'refused'`/`'no_response'` cause instead.
  const unreachable = (detail: string): BackendStatusFull => ({ status: 'unreachable', detail, cause: 'responded' });

  try {
    const ping = await probeUnauthenticatedPing(info, notOurCoordinator, unreachable);
    if (ping !== null) return ping;
    return await probeDetailedHealth(info, notOurCoordinator, unreachable);
  } catch (error: unknown) {
    // Same measurement as `shutdownBackend`'s catch (`shutdown.ts`): Node's `fetch` rejects a refused
    // connection with a `TypeError` whose own `.message` is the generic "fetch failed", while the errno travels
    // on `.cause`. A refusal proves nothing was listening on the exact socket at that moment without proving
    // the coordinator process is gone, so it carries the prior `pidLiveness` observation rather than a fresh
    // claim.
    const code = thrownErrnoCode(error);
    if (code === 'ECONNREFUSED') {
      return {
        status: 'unreachable',
        detail: code,
        cause: 'refused',
        pidLiveness: observed.pidLiveness,
        pid: info.pid,
        recordPath: runtime.paths.coral.coordinator.infoFile,
      };
    }
    return { status: 'unreachable', detail: code ?? errorMessage(error), cause: 'no_response' };
  }
}
