import { CommanderError } from 'commander';

import { BackendToolHttpError } from '../transport/http/client-errors.js';
import { BackendUnreachableError, TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliErrorEnvelope {
  error: true;
  code: string;
  message: string;
  detail?: unknown;
}

function withExitCode(
  envelope: CliErrorEnvelope,
  exitCode: number,
): { envelope: CliErrorEnvelope; exitCode: number } {
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
    const detail = body && 'detail' in body ? body.detail : undefined;
    return withExitCode(
      detail === undefined
        ? { error: true, code, message }
        : { error: true, code, message, detail },
      errorCodeToExit(code, error.statusCode),
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

  if (error instanceof Error) {
    return withExitCode({ error: true, code: 'internal', message: error.message }, 70);
  }

  return withExitCode({ error: true, code: 'internal', message: String(error) }, 70);
}
