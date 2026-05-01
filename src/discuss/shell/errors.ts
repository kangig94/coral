import type { Result } from '../session-types.js';

export const ABORT_REASON = 'abort';

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
