// Single-home abort vocabulary. All callers in src/ that need to construct,
// detect, or throw an aborted-operation error use these three exports. Local
// `isAbortError` / `createAbortError` helpers are forbidden by an invariant in
// tests/invariants/architecture-boundary.test.ts so the vocabulary stays one
// canonical home — see design-philosophy.md "No Ambiguity".
//
// `AbortError.reason` preserves `signal.reason` so callers can distinguish
// user aborts (e.g. `coral-cli abort`) from non-user reasons (e.g. mutation-
// lock deadline) downstream — both arrive as `AbortError` but with different
// `reason` values.

export class AbortError extends Error {
  readonly code = 'aborted';
  readonly stage: string;
  readonly reason: unknown;

  constructor(opts: { stage: string; reason?: unknown }) {
    super(
      `Operation aborted at stage '${opts.stage}'.`,
      opts.reason === undefined ? {} : { cause: opts.reason },
    );
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
