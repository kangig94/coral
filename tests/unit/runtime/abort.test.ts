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
});
