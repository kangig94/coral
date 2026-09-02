import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { readBundleHash } from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { isRecord } from '../infra/json.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import { createRealRuntime } from '../runtime/real.js';
import { isRetryableCoralSetupError, serializeCoralSetupError } from '../runtime/errors.js';

export type BootstrapDiagnosticPhase = 'startup_failed' | 'fatal_shutdown_error' | 'bootstrap_unhandled_rejection';

const MAX_BOOTSTRAP_ERROR_CAUSE_DEPTH = 8;

/**
 * Wall-clock instant this process began, in ms, so it is comparable with the `recordedAt` another process
 * wrote. `performance.timeOrigin` is a wall-clock reading and not a monotonic one, which is what makes that
 * comparison meaningful. `CORAL_STARTUP_STARTED_AT` may not stand in: it names the *attempt's* start, which
 * a delegating ancestor and the build it delegates to share, and which a spawn exporting none leaves absent.
 */
const PROCESS_STARTED_AT_MS = performance.timeOrigin;

function startupStartedAt(): number {
  const startedAt = Number(process.env.CORAL_STARTUP_STARTED_AT);
  return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
}

export function serializeBootstrapError(error: unknown, causeDepth = 0): Record<string, unknown> {
  const nestedCause = error instanceof Error ? error.cause : undefined;
  const setupError = serializeCoralSetupError(error);
  if (setupError) {
    return {
      kind: 'coral_setup_error',
      ...setupError,
      ...(nestedCause === undefined || nestedCause === null || causeDepth >= MAX_BOOTSTRAP_ERROR_CAUSE_DEPTH
        ? {}
        : { cause: serializeBootstrapError(nestedCause, causeDepth + 1) }),
    };
  }
  if (error instanceof Error) {
    return {
      kind: 'error',
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      // Nested causes must remain inspectable in the structured diagnostic; they never enter default public text.
      ...(nestedCause === undefined || nestedCause === null || causeDepth >= MAX_BOOTSTRAP_ERROR_CAUSE_DEPTH
        ? {}
        : { cause: serializeBootstrapError(nestedCause, causeDepth + 1) }),
    };
  }
  return {
    kind: 'unknown',
    message: String(error),
  };
}

/**
 * A documented refusal this process may not overwrite with a generic startup failure of its own.
 *
 * Attribution may not rest on `CORAL_STARTUP_ATTEMPT_ID`: not every spawn path exports one (see
 * `spawnCoordinator` in `src/transport/ipc/ensure.ts`), so a backend started without it has none on either
 * side of a delegation, and comparing two absent ids either skips the guard or matches every record ever
 * written. What holds without it is that the record was written by a *different process* during *this*
 * process's life: a build this process delegated to satisfies both halves, and a record from an attempt that
 * ended before this process started satisfies neither.
 *
 * A record with no readable pid is not preserved. This writer always stamps one, so a `startup_failed` record
 * without one did not come from here and its prose is not this build's.
 */
function isSetupRefusalFromAnotherProcessSinceStartup(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.phase !== 'startup_failed' ||
    !isRecord(value.error) ||
    value.error.kind !== 'coral_setup_error'
  ) {
    return false;
  }
  if (typeof value.pid !== 'number' || value.pid === process.pid) {
    return false;
  }
  const recordedAt = typeof value.recordedAt === 'string' ? Date.parse(value.recordedAt) : Number.NaN;
  return Number.isFinite(recordedAt) && recordedAt >= PROCESS_STARTED_AT_MS;
}

export function writeBootstrapDiagnostic(
  pluginRoot: string,
  phase: BootstrapDiagnosticPhase,
  error: unknown,
  exitCode: number,
): string | undefined {
  try {
    const flavor = resolveBuildFlavor(process.env);
    const runtime = createRealRuntime(flavor);
    const diagnosticFile = runtime.paths.coral.coordinator.startupDiagnosticFile;
    const attemptId = process.env.CORAL_STARTUP_ATTEMPT_ID;
    const serializedError = serializeBootstrapError(error);
    const diagnostic = {
      schemaVersion: 1,
      phase,
      state: 'stopped_with_diagnostic',
      retryable: isRetryableCoralSetupError(error),
      pid: process.pid,
      recordedAt: new Date().toISOString(),
      attemptId,
      startedAt: startupStartedAt(),
      socketPath: runtime.paths.coral.coordinator.socketPath,
      bundleHash: readBundleHash(pluginRoot),
      flavor,
      namespace: pluginRootNamespace(pluginRoot),
      exitCode,
      error: serializedError,
    };
    if (phase === 'startup_failed' && serializedError.kind !== 'coral_setup_error') {
      try {
        const existing: unknown = JSON.parse(runtime.storage.readFileSync(diagnosticFile, 'utf-8'));
        if (isSetupRefusalFromAnotherProcessSinceStartup(existing)) {
          return diagnosticFile;
        }
      } catch (readError: unknown) {
        if (!(isNoEntryError(readError) || readError instanceof SyntaxError)) {
          throw readError;
        }
      }
    }
    const tmp = `${diagnosticFile}.tmp-${process.pid}-${phase}`;
    runtime.storage.mkdirSync(dirname(diagnosticFile), { recursive: true });
    runtime.storage.writeFileSync(tmp, JSON.stringify(diagnostic, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    runtime.storage.renameSync(tmp, diagnosticFile);
    return diagnosticFile;
  } catch (diagnosticError: unknown) {
    backendLog.error('Failed to write bootstrap diagnostic', diagnosticError);
    return undefined;
  }
}

export function auditBootstrapFailure(
  event: string,
  pluginRoot: string,
  phase: BootstrapDiagnosticPhase,
  error: unknown,
  exitCode: number,
  diagnosticFile: string | undefined,
): void {
  const setupError = serializeCoralSetupError(error);
  try {
    const flavor = resolveBuildFlavor(process.env);
    const runtime = createRealRuntime(flavor);
    writeAuditEvent(
      event,
      {
        phase,
        state: 'stopped_with_diagnostic',
        exitCode,
        pid: process.pid,
        attemptId: process.env.CORAL_STARTUP_ATTEMPT_ID,
        socketPath: runtime.paths.coral.coordinator.socketPath,
        diagnosticFile,
        bundleHash: readBundleHash(pluginRoot),
        flavor,
        namespace: pluginRootNamespace(pluginRoot),
        setupErrorCode: setupError?.code,
        error: errorMessage(error),
      },
      'error',
    );
  } catch (auditError: unknown) {
    backendLog.error('Failed to write bootstrap audit event', auditError);
  }
}

/**
 * A startup exit code has one home, and it is the diagnostic named by `diagnosticFile`. A second copy in
 * the sentinel is not redundancy — it is a record that can disagree with the code the process exits with.
 */
export function writeStartupErrorSentinel(
  pluginRoot: string,
  error: unknown,
  diagnosticFile: string | undefined,
): void {
  const setupError = serializeCoralSetupError(error);
  if (!setupError) return;

  const attemptId = process.env.CORAL_STARTUP_ATTEMPT_ID;
  if (!attemptId) return;

  try {
    const flavor = resolveBuildFlavor(process.env);
    const runtime = createRealRuntime(flavor);
    const startupErrorFile = runtime.paths.coral.coordinator.startupErrorFile;
    const startedAt = Number(process.env.CORAL_STARTUP_STARTED_AT);
    const sentinel = {
      version: 1,
      attemptId,
      pid: process.pid,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
      recordedAt: Date.now(),
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      diagnosticFile,
      socketPath: runtime.paths.coral.coordinator.socketPath,
      bundleHash: readBundleHash(pluginRoot),
      flavor,
      namespace: pluginRootNamespace(pluginRoot),
      error: setupError,
    };
    const tmp = `${startupErrorFile}.tmp-${process.pid}-${attemptId}`;
    runtime.storage.mkdirSync(dirname(startupErrorFile), { recursive: true });
    runtime.storage.writeFileSync(tmp, JSON.stringify(sentinel) + '\n');
    runtime.storage.renameSync(tmp, startupErrorFile);
  } catch (sentinelError: unknown) {
    backendLog.error('Failed to write startup setup-error sentinel', sentinelError);
  }
}
