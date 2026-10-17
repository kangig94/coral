// Single-home abort vocabulary. All callers in src/ that need to construct,
// detect, or throw an aborted-operation error use these three exports. Local
// `isAbortError` / `createAbortError` helpers are forbidden by an invariant in
// tests/invariants/architecture-boundary.test.ts so the vocabulary stays one
// canonical home — see design-philosophy.md "No Ambiguity".
//
// AbortError must preserve signal.reason: callers must be able to distinguish
// user aborts from non-user reasons such as mutation-lock deadlines.

export class AbortError extends Error {
  readonly code = 'aborted';
  readonly stage: string;
  readonly reason: unknown;

  constructor(opts: { stage: string; reason?: unknown }) {
    super(`Operation aborted at stage '${opts.stage}'.`, opts.reason === undefined ? {} : { cause: opts.reason });
    this.name = 'AbortError';
    this.stage = opts.stage;
    this.reason = opts.reason;
    Object.setPrototypeOf(this, AbortError.prototype);
  }
}

export function isAbortError(err: unknown): err is AbortError {
  return err instanceof AbortError || (err instanceof Error && err.name === 'AbortError');
}

export function throwIfAborted(signal: AbortSignal, stage: string): void {
  if (signal.aborted) {
    throw new AbortError({ stage, reason: signal.reason });
  }
}

/**
 * Narrow predicate for the `aborted/user_abort` terminal-outcome mapping
 * (spec §6.4). Only `AbortError` whose `reason === 'user_abort'` routes to
 * the user-abort terminal; mutation-lock deadline aborts surface as
 * `AbortError` with `reason = { kind: 'mutation_deadline', timeoutMs }`
 * and intentionally fall through to failed-terminal recording.
 */
export function isUserAbort(err: unknown): err is AbortError & { reason: 'user_abort' } {
  return isAbortError(err) && err.reason === 'user_abort';
}
