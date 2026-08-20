// The liveness primitive answers three values.
//
// A `boolean` signature hides the third outcome from the compiler. The type says three now, and `tsc`
// does the audit.
//
// `unknown` is not a weaker `absent`. Only `absent` may finalize anything.

import { describe, expect, it, vi } from 'vitest';

import { observeProcessLiveness } from '#src/infra/node-process.js';

function killRejecting(code: string | undefined): void {
  const error = new Error(`kill failed: ${code ?? 'no code'}`) as NodeJS.ErrnoException;
  if (code !== undefined) error.code = code;
  vi.spyOn(process, 'kill').mockImplementationOnce((() => {
    throw error;
  }) as typeof process.kill);
}

describe('process liveness', () => {
  it('reports a signalable process alive', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce((() => true) as typeof process.kill);

    expect(observeProcessLiveness(123)).toBe('alive');
    expect(kill, 'signal 0 asks without delivering anything').toHaveBeenLastCalledWith(123, 0);

    kill.mockRestore();
  });

  it('reports a process it may not signal alive, and only a missing one absent', () => {
    killRejecting('EPERM');
    expect(observeProcessLiveness(124), "EPERM is someone else's process, not no process").toBe('alive');

    killRejecting('ESRCH');
    expect(observeProcessLiveness(125)).toBe('absent');

    vi.restoreAllMocks();
  });

  it('answers unknown for a question it could not ask, never absent', () => {
    killRejecting('EINVAL');
    expect(observeProcessLiveness(126)).toBe('unknown');

    // Including an error carrying no code at all — `process.kill` throws `ERR_INVALID_ARG_TYPE` for a pid
    // outside the range it accepts, and a durable record can hold one. That pid used to end coordinator
    // startup; it is a third answer now, and every caller has to say what it does with it.
    killRejecting(undefined);
    expect(observeProcessLiveness(2_147_483_648)).toBe('unknown');

    vi.restoreAllMocks();
  });
});
