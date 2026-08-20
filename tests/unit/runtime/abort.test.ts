import { describe, it, expect } from 'vitest';
import { AbortError, isAbortError, isUserAbort, throwIfAborted } from '#src/runtime/abort.js';

describe('AbortError', () => {
  it('constructs with stage and preserves reason via cause + reason field', () => {
    const reason = { kind: 'mutation_deadline', timeoutMs: 5_000 };
    const err = new AbortError({ stage: 'mutation_lock', reason });

    expect(err.name).toBe('AbortError');
    expect(err.code).toBe('aborted');
    expect(err.stage).toBe('mutation_lock');
    expect(err.reason).toBe(reason);
    expect(err.cause).toBe(reason);
    expect(err.message).toBe("Operation aborted at stage 'mutation_lock'.");
  });

  it('omits cause when reason is undefined', () => {
    const err = new AbortError({ stage: 'finalize' });

    expect(err.stage).toBe('finalize');
    expect(err.reason).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('satisfies instanceof AbortError and Error', () => {
    const err = new AbortError({ stage: 'finalize' });

    expect(err).toBeInstanceOf(AbortError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isAbortError', () => {
  it('returns true for AbortError instances', () => {
    expect(isAbortError(new AbortError({ stage: 'finalize' }))).toBe(true);
  });

  it('returns true for cross-realm Error-like values whose name is "AbortError"', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(new TypeError('nope'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
  });
});

describe('throwIfAborted', () => {
  it('does nothing when the signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal, 'finalize')).not.toThrow();
  });

  it('throws an AbortError that preserves signal.reason', () => {
    const controller = new AbortController();
    const reason = 'user_abort';
    controller.abort(reason);

    let caught: unknown;
    try {
      throwIfAborted(controller.signal, 'finalize');
    } catch (err) {
      caught = err;
    }

    expect(isAbortError(caught)).toBe(true);
    const abortErr = caught as AbortError;
    expect(abortErr.stage).toBe('finalize');
    expect(abortErr.reason).toBe(reason);
    expect(abortErr.cause).toBe(reason);
  });

  it('preserves structured deadline reasons distinctly from user-string reasons', () => {
    const controller = new AbortController();
    const deadlineReason = { kind: 'mutation_deadline', timeoutMs: 5_000 };
    controller.abort(deadlineReason);

    let caught: unknown;
    try {
      throwIfAborted(controller.signal, 'mutation_lock');
    } catch (err) {
      caught = err;
    }

    expect(isAbortError(caught)).toBe(true);
    const abortErr = caught as AbortError;
    expect(abortErr.stage).toBe('mutation_lock');
    expect(abortErr.reason).toEqual(deadlineReason);
    expect(abortErr.reason).not.toBe('user_abort');
  });
});

// AbortError reason mapping. The KB services key the
// `aborted/user_abort` terminal outcome on the centralized `isUserAbort`
// predicate from `src/runtime/abort.ts`. This decision predicate is
// exercised end-to-end through the real services in
// `tests/integration/kb-daemon/services/kb-pipeline-checkpoint-honor.test.ts`.
// These tests pin the same predicate at the unit level so the mapping
// contract is visible alongside the abort vocabulary itself: user aborts
// route to `aborted/user_abort`; deadline / cooperative / unknown reasons
// never do.
describe('isUserAbort (user_abort vs mutation_deadline vs unrelated)', () => {
  it("'user_abort' reason maps to user-abort outcome", () => {
    const err = new AbortError({ stage: 'readiness', reason: 'user_abort' });
    expect(isUserAbort(err)).toBe(true);
  });

  it('mutation_deadline reason NEVER maps to user-abort outcome', () => {
    const err = new AbortError({
      stage: 'mutation_lock',
      reason: { kind: 'mutation_deadline', timeoutMs: 30_000 },
    });
    expect(isUserAbort(err)).toBe(false);
  });

  it('`shutdown` and other non-user reasons NEVER map to user-abort outcome', () => {
    expect(isUserAbort(new AbortError({ stage: 'apply', reason: 'shutdown' }))).toBe(false);
    expect(isUserAbort(new AbortError({ stage: 'finalize' }))).toBe(false);
    expect(isUserAbort(new AbortError({ stage: 'apply' }))).toBe(false);
  });

  it('non-AbortError values NEVER map to user-abort outcome', () => {
    expect(isUserAbort(new Error('boom'))).toBe(false);
    expect(isUserAbort(undefined)).toBe(false);
    expect(isUserAbort(null)).toBe(false);
    expect(isUserAbort('user_abort')).toBe(false);
    expect(isUserAbort({ reason: 'user_abort' })).toBe(false);
  });

  it('user_abort reason flowing through throwIfAborted preserves the mapping', () => {
    const controller = new AbortController();
    controller.abort('user_abort');

    let caught: unknown;
    try {
      throwIfAborted(controller.signal, 'readiness');
    } catch (err) {
      caught = err;
    }
    expect(isUserAbort(caught)).toBe(true);
  });

  it('narrows to AbortError so callers can read .message on the narrowed value', () => {
    const err: unknown = new AbortError({ stage: 'readiness', reason: 'user_abort' });
    if (isUserAbort(err)) {
      // `err` is narrowed to AbortError & { reason: 'user_abort' }.
      expect(typeof err.message).toBe('string');
      expect(err.reason).toBe('user_abort');
    }
  });
});
