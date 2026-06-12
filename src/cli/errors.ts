import { CommanderError } from 'commander';
import { ZodError } from 'zod';

import { BackendToolHttpError } from '../transport/http/errors.js';
import { BackendUnreachableError, TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';
import { DiscussWatchReadError } from '../discuss/watch.js';
import { serializeCoralSetupError } from '../runtime/errors.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
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
  if (code === 'internal' || code === 'internal_error' || httpStatus === 500) {
    return 70;
  }
  return 1;
}

export function buildErrorEnvelope(error: unknown): { envelope: CliErrorEnvelope; exitCode: number } {
  if (error instanceof BackendToolHttpError) {
    const body = isRecord(error.body) ? error.body : null;
    const code = body && typeof body.code === 'string' ? body.code : 'backend_error';
    const message = body && typeof body.message === 'string' ? body.message : error.message;
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
      errorCodeToExit(code, error.statusCode),
    );
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

  if (error instanceof TransientHttpError) {
    return withExitCode({ error: true, code: 'transient', message: error.message }, 75);
  }

  if (error instanceof BackendUnreachableError) {
    return withExitCode({ error: true, code: 'backend_unreachable', message: error.message }, 69);
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
