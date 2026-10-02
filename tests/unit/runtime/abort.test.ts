import { describe, it, expect } from 'vitest';
import { type AbortError, isAbortError, isUserAbort, throwIfAborted } from '#src/runtime/abort.js';

describe('throwIfAborted', () => {
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
    expect(isUserAbort(caught)).toBe(false);
  });
});
