// The liveness primitive, which had four divergent copies, then one that threw, and now answers three values.
//
// The copies did not merely duplicate — they disagreed, and each disagreement was a bug pointed a different
// way. The KB daemon's read any unexpected error as "parent dead"; the IPC one read even `EPERM` as dead, so a
// live coordinator's startup sentinel could be cleared out from under it; the runtime port's collapsed
// everything unexpected to `false`, which is how "could not tell" became "gone" on paths whose whole job is
// proving absence.
//
// Making the merged primitive *throw* on the third outcome fixed the reading and broke the callers: a
// `boolean` signature hides that outcome from the compiler, so four successive hand audits of the same
// eighteen call sites each missed different ones — including a coordinator that exits from a timer callback
// and a job terminalized as failed because its probe could not answer. The type says three now, and `tsc`
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

    expect(observeProcessLiveness(123) !== 'absent').toBe(true);
    expect(kill, 'signal 0 asks without delivering anything').toHaveBeenLastCalledWith(123, 0);

    kill.mockRestore();
  });

  it('reports a process it may not signal alive, and only a missing one absent', () => {
    killRejecting('EPERM');
    expect(observeProcessLiveness(124) !== 'absent', "EPERM is someone else's process, not no process").toBe(true);

    killRejecting('ESRCH');
    expect(observeProcessLiveness(125) !== 'absent').toBe(false);

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
