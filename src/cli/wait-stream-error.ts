import { ZodError } from 'zod';
import { BackendToolHttpError } from '../transport/http/errors.js';
import { TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';
import { WaitBuildMismatchError } from './errors.js';
import { WAIT_BUILD_MISMATCH } from '../transport/rpc/jobs.js';
import { IpcRpcError } from '../transport/ipc/client.js';
import type { WaitCursorError } from '../jobs/contracts/addressing.js';

const JSON_RPC_INVALID_PARAMS = -32602;

/** The coordinator's soft cursor refusals: the CLI drops its cursor and starts a fresh collection. */
export const SOFT_CURSOR_REFUSALS: readonly string[] = [
  'wait_cursor_malformed',
  'wait_cursor_mismatch',
] satisfies readonly WaitCursorError['code'][];

function waitSubscriptionStatusCode(body: Record<string, unknown>): number {
  switch (body.code) {
    case 'scope_mismatch':
      return 403;
    case 'jobs_not_found':
    case 'job_pre_epoch_history':
      return 404;
    case 'job_outcome_unrecoverable':
      return 409;
    case 'backend_recovering':
    case 'backend_shutting_down':
      return 503;
    default:
      return 400;
  }
}

/**
 * The IPC subscribe layer surfaces a backend rejection as an `Error` whose
 * `cause` carries the structured `{ code, message }` body. Without this
 * mapping the error falls through to the generic `internal` envelope, so a
 * `jobs_not_found` (404) would be mislabeled as an internal failure (exit 70).
 *
 * 503-family codes are wrapped as `TransientHttpError` so the follow-loop
 * retry guard (`isTransientStreamError`) recognizes them as retryable.
 *
 * A same-build coordinator accepts every wait request this CLI forms and emits only events it reads, so a rejected
 * request shape or an unreadable event means the coordinator is another build; retrying cannot change that.
 */
export function mapWaitSubscriptionError(error: unknown): unknown {
  if (error instanceof ZodError) return new WaitBuildMismatchError();
  if (
    error instanceof IpcRpcError &&
    (error.rpcCode === JSON_RPC_INVALID_PARAMS || error.code === WAIT_BUILD_MISMATCH.code)
  )
    return new WaitBuildMismatchError();

  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(error.cause.message, waitSubscriptionStatusCode(error.cause), error.cause);
}
