import { CommanderError } from 'commander';
import { ZodError } from 'zod';

import { BackendToolHttpError } from '../transport/http/errors.js';
import { BackendUnreachableError, TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';
import { DiscussWatchReadError } from '../discuss/watch.js';
import { serializeCoralSetupError } from '../runtime/errors.js';
import { ChildPrincipalBindingError } from '../transport/ipc/child-principal-auth.js';
import { IpcRpcError } from '../transport/ipc/client.js';

export type StoreResetCliErrorCode =
  | 'invalid_store_reset_incident_id'
  | 'store_reset_incident_not_found'
  | 'store_reset_incident_limit_exceeded'
  | 'store_reset_build_mismatch'
  | 'store_reset_incident_build_mismatch'
  | 'store_reset_reporting_failed';

const STORE_RESET_ERRORS = {
  invalid_store_reset_incident_id: {
    message: 'Incident ID must be a canonical lowercase UUID.',
    remediation: 'Run `coral-cli backend store-reset list` and use the ID of an incident in the `ready` state.',
    exitCode: 2,
  },
  store_reset_incident_not_found: {
    message: 'Store-reset incident not found.',
    remediation:
      'Run `coral-cli backend store-reset list`. If no incident is retained, file a Store-reset incident issue with this complete fixed error output; do not attach DB, WAL, SHM, or raw logs.',
    exitCode: 1,
  },
  store_reset_incident_limit_exceeded: {
    message: 'Too many retained store-reset entries to list safely; report a known incident ID directly.',
    remediation:
      'Use an incident ID from the reset warning. If none is available, file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
    exitCode: 1,
  },
  store_reset_build_mismatch: {
    message: 'Store-reset reporting is unavailable because the installed build artifacts do not match.',
    remediation:
      'Reinstall or update Coral through the same install method without deleting Coral data, then retry. If it persists, file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
    exitCode: 70,
  },
  store_reset_incident_build_mismatch: {
    message: 'The retained incident belongs to a different Coral build set and cannot be reported by this build.',
    remediation:
      'Keep the incident in place and file a Store-reset incident issue with this fixed error output; do not attach DB, WAL, SHM, or raw logs.',
    exitCode: 70,
  },
  store_reset_reporting_failed: {
    message: 'Store-reset reporting failed.',
    remediation:
      'Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.',
    exitCode: 70,
  },
} as const satisfies Readonly<
  Record<StoreResetCliErrorCode, { readonly message: string; readonly remediation: string; readonly exitCode: number }>
>;

export class StoreResetCliError extends Error {
  readonly code: StoreResetCliErrorCode;
  readonly exitCode: number;
  readonly remediation: string;

  constructor(code: StoreResetCliErrorCode) {
    const definition = STORE_RESET_ERRORS[code];
    super(definition.message);
    this.name = 'StoreResetCliError';
    this.code = code;
    this.exitCode = definition.exitCode;
    this.remediation = definition.remediation;
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class ProviderSelectionError extends Error {
  readonly code: string;
  readonly remediation: string;

  constructor(code: string, message: string, remediation: string) {
    super(message);
    this.name = 'ProviderSelectionError';
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Collapses a ZodError from CLI argument validation into a UsageError whose
 * message reads as flag guidance (issue messages already phrased as `--flag ...`
 * pass through; others get their field path prefixed). Non-Zod errors pass
 * through untouched.
 */
export function normalizeUsageError(error: unknown): unknown {
  if (!(error instanceof ZodError)) {
    return error;
  }

  const message = error.issues
    .map((issue) => {
      if (issue.message.startsWith('--')) {
        return issue.message;
      }
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
  return new UsageError(message);
}

export interface CliErrorEnvelope {
  error: true;
  code: string;
  message: string;
  remediation?: string;
  detail?: unknown;
}

function withExitCode(envelope: CliErrorEnvelope, exitCode: number): { envelope: CliErrorEnvelope; exitCode: number } {
  return { envelope, exitCode };
}

type CliErrorResult = ReturnType<typeof withExitCode>;

export function errorCodeToExit(code: string, httpStatus?: number): number {
  if (code === 'invalid_usage') {
    return 2;
  }
  if (code === 'transient' || code === 'backend_shutting_down' || httpStatus === 503) {
    return 75;
  }
  if (code === 'backend_unreachable') {
    return 69;
  }
  if (code === 'missing_capability' || code === 'child_credentials_incomplete') {
    return 77;
  }
  if (code === 'internal' || code === 'internal_error' || httpStatus === 500) {
    return 70;
  }
  return 1;
}

function remediatedError(error: {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly exitCode: number;
}): CliErrorResult {
  return withExitCode(
    { error: true, code: error.code, message: error.message, remediation: error.remediation },
    error.exitCode,
  );
}

function structuredBodyError(
  value: unknown,
  fallback: { readonly code: string; readonly message: string; readonly httpStatus?: number },
): CliErrorResult {
  const setupError = serializeCoralSetupError(value);
  if (setupError !== null) {
    return withExitCode(
      {
        error: true,
        code: setupError.code,
        message: setupError.userMessage,
        remediation: setupError.remediation,
        ...(setupError.context === undefined ? {} : { detail: setupError.context }),
      },
      errorCodeToExit(setupError.code, fallback.httpStatus),
    );
  }

  const body = isRecord(value) ? value : null;
  const code = body && typeof body.code === 'string' ? body.code : fallback.code;
  const message = body && typeof body.message === 'string' ? body.message : fallback.message;
  const remediation = body && typeof body.remediation === 'string' ? body.remediation : undefined;
  const detail = body && 'detail' in body ? body.detail : undefined;
  return withExitCode(
    {
      error: true,
      code,
      message,
      ...(remediation === undefined ? {} : { remediation }),
      ...(detail === undefined ? {} : { detail }),
    },
    errorCodeToExit(code, fallback.httpStatus),
  );
}

function directErrorEnvelope(error: unknown): CliErrorResult | null {
  if (error instanceof StoreResetCliError || error instanceof ChildPrincipalBindingError) {
    return remediatedError(error);
  }

  if (error instanceof DiscussWatchReadError) {
    const message = error.code.replaceAll('_', ' ');
    return withExitCode(
      error.detail === undefined
        ? { error: true, code: error.code, message }
        : { error: true, code: error.code, message, detail: error.detail },
      errorCodeToExit(error.code),
    );
  }

  if (error instanceof UsageError || error instanceof CommanderError) {
    return withExitCode({ error: true, code: 'invalid_usage', message: error.message }, 2);
  }

  if (error instanceof ProviderSelectionError) {
    return withExitCode({ error: true, code: error.code, message: error.message, remediation: error.remediation }, 2);
  }

  return null;
}

function transportErrorEnvelope(error: unknown): CliErrorResult | null {
  if (error instanceof BackendToolHttpError) {
    return structuredBodyError(error.body, {
      code: 'backend_error',
      message: error.message,
      httpStatus: error.statusCode,
    });
  }
  if (error instanceof IpcRpcError) {
    return structuredBodyError(error.data, { code: 'ipc_rpc_error', message: error.message });
  }
  if (error instanceof TransientHttpError) {
    return withExitCode({ error: true, code: 'transient', message: error.message }, 75);
  }
  if (error instanceof BackendUnreachableError) {
    return withExitCode({ error: true, code: 'backend_unreachable', message: error.message }, 69);
  }

  return null;
}

export function buildErrorEnvelope(error: unknown): CliErrorResult {
  const direct = directErrorEnvelope(error);
  if (direct !== null) {
    return direct;
  }
  const transport = transportErrorEnvelope(error);
  if (transport !== null) {
    return transport;
  }

  const setupError = serializeCoralSetupError(error);
  if (setupError) {
    return withExitCode(
      {
        error: true,
        code: setupError.code,
        message: setupError.userMessage,
        remediation: setupError.remediation,
        ...(setupError.context === undefined ? {} : { detail: setupError.context }),
      },
      errorCodeToExit(setupError.code),
    );
  }

  if (error instanceof Error) {
    return withExitCode({ error: true, code: 'internal', message: error.message }, 70);
  }

  return withExitCode({ error: true, code: 'internal', message: String(error) }, 70);
}
