import { ZodError } from 'zod';
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
 *
 * A `ZodError` reaches here differently: not a rejected subscribe, but a wait-stream event this build
 * could not decode even through the wait-stream schemas' additive-field tolerance — a newer coordinator's
 * event shaped in a way this build genuinely cannot read. Wrapping it as transient buys the follow loop's
 * bounded retry rather than ending the wait on the first such event; the same original decode error still
 * surfaces once retries are exhausted.
 */
export function mapWaitSubscriptionError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return new TransientHttpError(503, error.message);
  }

  if (!(error instanceof Error) || !isRecord(error.cause) || typeof error.cause.message !== 'string') {
    return error;
  }

  if (error.cause.code === 'backend_recovering' || error.cause.code === 'backend_shutting_down') {
    return new TransientHttpError(503, error.cause.message);
  }

  return new BackendToolHttpError(error.cause.message, waitSubscriptionStatusCode(error.cause), error.cause);
}
