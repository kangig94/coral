import { BackendToolHttpError } from '../transport/http/errors.js';
import { TransientHttpError } from '../infra/http-errors.js';
import { isRecord } from '../infra/json.js';

function waitSubscriptionStatusCode(body: Record<string, unknown>): number {
  switch (body.code) {
    case 'scope_mismatch':
      return 403;
    case 'jobs_not_found':
      return 404;
    case 'backend_recovering':
    case 'backend_shutting_down':
      return 503;
    default:
      return 400;
  }
}

/**
 * Translate a `jobs.wait` subscription error into a renderable CLI error.
 *
 * The IPC subscribe layer surfaces a backend rejection as an `Error` whose
 * `cause` carries the structured `{ code, message }` body. Without this
 * mapping the error falls through to the generic `internal` envelope, so a
 * `jobs_not_found` (404) would be mislabeled as an internal failure (exit 70).
 * Both the `wait` command and the launch-and-follow loop subscribe to
 * `jobs.wait`, so the mapping lives here rather than in either consumer.
 *
 * 503-family codes are wrapped as `TransientHttpError` so the follow-loop
 * retry guard (`isTransientStreamError`) recognizes them as retryable.
 */
export function mapWaitSubscriptionError(error: unknown): unknown {
  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(error.cause.message, waitSubscriptionStatusCode(error.cause), error.cause);
}
