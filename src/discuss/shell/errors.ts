import type { Result } from '../session-types.js';

export const ABORT_REASON = 'abort';

// commitDecision's controller.signal.aborted guard produces this, never `session_not_found`,
// exactly when the session's durable record still exists but its live controller was aborted
// (clearAllDiscuss's abort-first pass runs before removing anything from ctx.sessions).
// isSilentCommitRefusal folds both into the same internal no-op today; a caller that inspects
// `error` directly instead must not treat this value as evidence the store no longer holds
// the session.
export const SESSION_SHUTTING_DOWN = 'session_shutting_down';

export class DiscussManagerError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: string, detail?: Record<string, unknown>) {
    super(code);
    this.name = 'DiscussManagerError';
    this.code = code;
    this.detail = detail;
  }
}

export function unwrapResult<T>(result: Result<T>): T {
  if (result.ok) {
    return result.value;
  }
  throw new DiscussManagerError(result.error, result.detail);
}
