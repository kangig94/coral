import { describe, it, expect } from 'vitest';
import { AbortError, isAbortError, throwIfAborted } from '#src/runtime/abort.js';

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
