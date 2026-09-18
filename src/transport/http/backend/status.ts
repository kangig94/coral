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
import {
  scanShutdownRemainderRecords,
  shutdownRemainderRecordDirectory,
  type DecodedShutdownRemainderRecord,
  type ShutdownRemainderRecord,
  type ShutdownRemainderRecordScan,
} from '../../../infra/shutdown-remainder-record.js';

const RECENT_COORDINATOR_RECORD_MS = 5 * 60_000;
const OPERATOR_FACING_ERROR_IDENTIFIER_MAX_LENGTH = 64;
const OPERATOR_FACING_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const OPERATOR_FACING_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

type PublicDiagnosticPhase = 'startup_failed' | 'fatal_shutdown_error' | 'bootstrap_unhandled_rejection';

type OperatorFacingShutdownSettlement =
  | Readonly<{ cause: 'rejected' | 'aborted'; error: Readonly<{ name: string; code?: string }> }>
  | Readonly<{ cause: 'timed-out'; budgetMs: number }>
  | Readonly<{ cause: 'budget-exhausted' | 'unconfirmed' }>;

const OPERATOR_FACING_SHUTDOWN_LABELS = [
  'app-server handoff quiesce',
  'backend discovery withdrawal',
  'child termination',
  'components disposeAll',
  'crashed job terminalization',
  'discuss store dispose',
  'hooks.onShutdown',
  'inflight drain',
  'kb child shutdown',
  'lifecycle reactor dispose',
  'ownership checker teardown',
  'pending launch settlement',
  'process incarnation probe shutdown',
  'process-exit-remainder-acceptance',
  'provider control and IPC authority release',
  'provider host drain for handoff',
  'provider host shutdown',
  'provider operation mutation drain',
  'recovery coordinator teardown',
  'server close',
  'server connection close',
  'store epoch sweep cancellation',
  'store services availability check',
] as const;
type OperatorFacingShutdownLabel = (typeof OPERATOR_FACING_SHUTDOWN_LABELS)[number];
type OperatorFacingShutdownObligation =
  | Readonly<{ label: OperatorFacingShutdownLabel }>
  | Readonly<{ label: 'stream response close'; ordinal: number }>
  | Readonly<{ label: 'provider proxy lifecycle fatal incident'; occurrence: number }>;

type OperatorFacingShutdownSkippedEntry = Readonly<{
  entryNumber: number;
  obligation: OperatorFacingShutdownObligation | null;
}>;

type OperatorFacingShutdownRemainderRecord = Readonly<{
  instanceId: string;
  recordedAt: string;
  reason: ShutdownRemainderRecord['reason'];
  mode: ShutdownRemainderRecord['mode'];
  entries: readonly Readonly<{
    entryNumber: number;
    obligation: OperatorFacingShutdownObligation | null;
    remainder: ShutdownRemainderRecord['entries'][number]['remainder'];
    settlement: OperatorFacingShutdownSettlement;
  }>[];
}>;

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
      /**
       * Recorded prose crosses this operator-facing boundary only for a code this build proved it wrote, and
       * only inside the charset and length bounds of `canonicalSelfAuthoredProse`; recorded context must
       * never cross it. see `readOperatorFacingCoralSetupError` in src/runtime/errors.ts
       */
      setupError?: OperatorFacingCoralSetupError;
    }
  | {
      status: 'recent_shutdown_remainder';
      record: OperatorFacingShutdownRemainderRecord;
      skippedEntries: readonly OperatorFacingShutdownSkippedEntry[];
      skippedRecordCount: number;
    }
  | {
      status: 'shutdown_remainder_unreadable';
      reason: 'scan-failed';
    }
  | {
      status: 'shutdown_remainder_unreadable';
      reason: 'records-skipped';
      skippedRecordCount: number;
    };

type RecentFailureStatus = Extract<BackendStatusFull, { status: 'recent_failure' }>;
type RecentShutdownRemainderStatus = Extract<BackendStatusFull, { status: 'recent_shutdown_remainder' }>;
type ShutdownRemainderUnreadableStatus = Extract<BackendStatusFull, { status: 'shutdown_remainder_unreadable' }>;
type ShutdownRemainderEvidenceScope =
  | Readonly<{ kind: 'directory' }>
  | Readonly<{ kind: 'coordinator'; instanceId?: string; startedAt: number }>;

function isPublicDiagnosticPhase(value: unknown): value is PublicDiagnosticPhase {
  return value === 'startup_failed' || value === 'fatal_shutdown_error' || value === 'bootstrap_unhandled_rejection';
}

const operatorFacingShutdownLabels = new Set<string>(OPERATOR_FACING_SHUTDOWN_LABELS);

function positiveSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function operatorFacingShutdownObligation(label: string): OperatorFacingShutdownObligation | null {
  if (operatorFacingShutdownLabels.has(label)) return { label: label as OperatorFacingShutdownLabel };

  const stream = /^stream response close ([1-9][0-9]*)$/u.exec(label);
  if (stream !== null) {
    const ordinal = positiveSafeInteger(stream[1] ?? '');
    if (ordinal !== null) return { label: 'stream response close', ordinal };
  }

  if (label === 'provider proxy lifecycle fatal incident') {
    return { label, occurrence: 1 };
  }
  const incident = /^provider proxy lifecycle fatal incident ([2-9][0-9]*)$/u.exec(label);
  if (incident !== null) {
    const occurrence = positiveSafeInteger(incident[1] ?? '');
    if (occurrence !== null) return { label: 'provider proxy lifecycle fatal incident', occurrence };
  }

  return null;
}

function operatorFacingErrorName(name: string): string {
  return name.length <= OPERATOR_FACING_ERROR_IDENTIFIER_MAX_LENGTH && OPERATOR_FACING_ERROR_NAME_PATTERN.test(name)
    ? name
    : 'Error';
}

function operatorFacingErrorCode(code: string | undefined): string | undefined {
  return code !== undefined &&
    code.length <= OPERATOR_FACING_ERROR_IDENTIFIER_MAX_LENGTH &&
    OPERATOR_FACING_ERROR_CODE_PATTERN.test(code)
    ? code
    : undefined;
}

function operatorFacingShutdownSettlement(
  settlement: ShutdownRemainderRecord['entries'][number]['settlement'],
): OperatorFacingShutdownSettlement {
  switch (settlement.cause) {
    case 'rejected':
    case 'aborted': {
      const nestedCause = settlement.error.kind === 'error' ? settlement.error.cause : undefined;
      const error =
        nestedCause !== undefined && operatorFacingErrorCode(nestedCause.code) !== undefined
          ? nestedCause
          : settlement.error;
      const code = operatorFacingErrorCode(error.code);
      return {
        cause: settlement.cause,
        error: {
          name: error.kind === 'error' ? operatorFacingErrorName(error.name) : 'UnknownThrown',
          ...(code === undefined ? {} : { code }),
        },
      };
    }
    case 'timed-out':
      return { cause: settlement.cause, budgetMs: settlement.budgetMs };
    case 'budget-exhausted':
    case 'unconfirmed':
      return { cause: settlement.cause };
  }
}

function operatorFacingShutdownRemainderOwner(
  remainder: ShutdownRemainderRecord['entries'][number]['remainder'],
): ShutdownRemainderRecord['entries'][number]['remainder'] {
  if (remainder.owner === 'process-exit') return { owner: 'process-exit' };
  switch (remainder.evidence.kind) {
    case 'startup-adoption':
      return {
        owner: 'successor-recovery',
        evidence: {
          kind: 'startup-adoption',
          processes: remainder.evidence.processes.map((process) => ({
            kind: 'durable-cli-runtime',
            jobId: process.jobId,
            pid: process.pid,
            leaderIncarnation: process.leaderIncarnation,
          })),
        },
      };
    case 'startup-store-recovery':
      return { owner: 'successor-recovery', evidence: { kind: 'startup-store-recovery' } };
    case 'startup-liveness-recovery':
      return { owner: 'successor-recovery', evidence: { kind: 'startup-liveness-recovery' } };
  }
}

function operatorFacingShutdownRemainder(
  record: DecodedShutdownRemainderRecord,
): OperatorFacingShutdownRemainderRecord {
  return {
    instanceId: record.instanceId,
    recordedAt: record.recordedAt,
    reason: record.reason,
    mode: record.mode,
    entries: record.entries.map((entry) => ({
      entryNumber: entry.entryNumber,
      obligation: operatorFacingShutdownObligation(entry.label),
      remainder: operatorFacingShutdownRemainderOwner(entry.remainder),
      settlement: operatorFacingShutdownSettlement(entry.settlement),
    })),
  };
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
    now - recordedAt > RECENT_COORDINATOR_RECORD_MS ||
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

function readRecentShutdownRemainder(
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>,
  runDir: string,
  now: number,
  scope: ShutdownRemainderEvidenceScope,
): RecentShutdownRemainderStatus | ShutdownRemainderUnreadableStatus | null {
  const directory = shutdownRemainderRecordDirectory(runDir);
  if (!storage.existsSync(directory)) return null;
  let scan: ShutdownRemainderRecordScan;
  try {
    scan = scanShutdownRemainderRecords(storage, directory);
  } catch {
    return scope.kind === 'directory' || scope.instanceId !== undefined
      ? { status: 'shutdown_remainder_unreadable', reason: 'scan-failed' }
      : null;
  }
  const scopedSkippedRecords =
    scope.kind === 'directory'
      ? scan.skippedRecords
      : scope.instanceId === undefined
        ? []
        : scan.skippedRecords.filter((name) => name === `${scope.instanceId}.json`);
  const record = scan.records
    .flatMap((candidate) => {
      const recordedAt = parseIsoTimestamp(candidate.recordedAt);
      return Number.isFinite(recordedAt) &&
        (scope.kind === 'directory' ||
          (scope.instanceId !== undefined &&
            candidate.instanceId === scope.instanceId &&
            recordedAt >= scope.startedAt)) &&
        recordedAt <= now &&
        now - recordedAt <= RECENT_COORDINATOR_RECORD_MS
        ? [{ candidate, recordedAt }]
        : [];
    })
    .sort(
      (left, right) =>
        left.recordedAt - right.recordedAt || left.candidate.instanceId.localeCompare(right.candidate.instanceId),
    )
    .at(-1)?.candidate;
  if (record === undefined) {
    return scopedSkippedRecords.length > 0
      ? {
          status: 'shutdown_remainder_unreadable',
          reason: 'records-skipped',
          skippedRecordCount: scopedSkippedRecords.length,
        }
      : null;
  }
  return {
    status: 'recent_shutdown_remainder',
    record: operatorFacingShutdownRemainder(record),
    skippedEntries: scan.skippedEntries
      .filter((entry) => entry.recordInstanceId === record.instanceId)
      .map((entry) => ({
        entryNumber: entry.entryNumber,
        obligation: entry.label === null ? null : operatorFacingShutdownObligation(entry.label),
      })),
    skippedRecordCount: scopedSkippedRecords.length,
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
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'>,
  diagnosticFile: string,
  runDir: string,
  now: number,
  provenSelfIdentity: () => SetupErrorAuthorIdentity | null,
  fallback: Extract<
    BackendStatusFull,
    { status: 'no_record_no_socket' | 'recorded_process_absent' } | { cause: 'foreign_peer' }
  >,
  coordinator?: Readonly<{ instanceId?: string; startedAt: number; pid: number }>,
): BackendStatusFull {
  const diagnostic = readRecentFailureDiagnostic(
    storage,
    diagnosticFile,
    now,
    provenSelfIdentity,
    coordinator?.startedAt,
    coordinator?.pid,
  );
  if (diagnostic !== null) return diagnostic;
  const remainder = readRecentShutdownRemainder(
    storage,
    runDir,
    now,
    coordinator === undefined ? { kind: 'directory' } : { kind: 'coordinator', ...coordinator },
  );
  if (remainder?.status === 'recent_shutdown_remainder') return remainder;
  return (fallback.status === 'no_record_no_socket' || fallback.status === 'recorded_process_absent') &&
    remainder !== null
    ? remainder
    : fallback;
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
        runtime.paths.coral.coordinator.runDir,
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
      // Startup diagnostics require both `startedAt` and `pid`; shutdown remainders require the recorded
      // `instanceId`. Missing identity must never widen either lookup to directory-wide evidence.
      return noDaemonStatus(
        runtime.storage,
        runtime.paths.coral.coordinator.startupDiagnosticFile,
        runtime.paths.coral.coordinator.runDir,
        runtime.time.now(),
        provenSelfIdentity,
        { status: 'recorded_process_absent', pid: observed.pid },
        observed,
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
      runtime.paths.coral.coordinator.runDir,
      runtime.time.now(),
      provenSelfIdentity,
      {
        status: 'unreachable',
        cause: 'foreign_peer',
        observed: observedIdentity,
        pid: info.pid,
        recordPath: runtime.paths.coral.coordinator.infoFile,
      },
      info,
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
