import { dirname } from 'node:path';

import { writeAuditEvent } from '../infra/audit-log.js';
import { backendLog } from '../infra/backend-log.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import {
  BOOTSTRAP_DIAGNOSTIC_SCHEMA_VERSION,
  STARTUP_ERROR_SENTINEL_VERSION,
} from '../infra/bootstrap-diagnostic-contract.js';
import { readBundleHash } from '../infra/bundle-manifest.js';
import { errorMessage } from '../infra/error-format.js';
import { pluginRootNamespace } from '../infra/plugin-identity.js';
import { createRealRuntime } from '../runtime/real.js';
import { serializeCoralSetupError } from '../runtime/errors.js';

export type BootstrapDiagnosticPhase = 'startup_failed' | 'fatal_shutdown_error' | 'bootstrap_unhandled_rejection';

const MAX_BOOTSTRAP_ERROR_CAUSE_DEPTH = 8;

function startupStartedAt(): number {
  const startedAt = Number(process.env.CORAL_STARTUP_STARTED_AT);
  return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
}

export function serializeBootstrapError(error: unknown, causeDepth = 0): Record<string, unknown> {
  const setupError = serializeCoralSetupError(error);
  if (setupError) {
    return { kind: 'coral_setup_error', ...setupError };
  }
  if (error instanceof Error) {
    return {
      kind: 'error',
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      // A wrapper that carries the real reason in `cause` is useless without it: the
      // operator sees a fatal, non-retryable failure and no way to learn why.
      ...(error.cause === undefined || error.cause === null || causeDepth >= MAX_BOOTSTRAP_ERROR_CAUSE_DEPTH
        ? {}
        : { cause: serializeBootstrapError(error.cause, causeDepth + 1) }),
    };
  }
  return {
    kind: 'unknown',
    message: String(error),
  };
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
    const diagnostic = {
      schemaVersion: BOOTSTRAP_DIAGNOSTIC_SCHEMA_VERSION,
      phase,
      state: 'stopped_with_diagnostic',
      retryable: false,
      pid: process.pid,
      recordedAt: new Date().toISOString(),
      attemptId: process.env.CORAL_STARTUP_ATTEMPT_ID,
      startedAt: startupStartedAt(),
      socketPath: runtime.paths.coral.coordinator.socketPath,
      bundleHash: readBundleHash(pluginRoot),
      flavor,
      namespace: pluginRootNamespace(pluginRoot),
      exitCode,
      error: serializeBootstrapError(error),
    };
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
      version: STARTUP_ERROR_SENTINEL_VERSION,
      attemptId,
      pid: process.pid,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
      recordedAt: Date.now(),
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      exitCode: 1,
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
