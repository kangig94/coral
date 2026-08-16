// The liveness primitive, which had three divergent copies and now has one.
//
// The copies did not merely duplicate — they disagreed, and each disagreement was a bug pointed a different
// way. The KB daemon's read any unexpected error as "parent dead" and shut its watchdog down on it; the IPC
// one read even `EPERM` as dead, so a live coordinator's startup-error sentinel could be cleared out from
// under it; the runtime port's collapsed everything unexpected to `false`, which is how "could not tell"
// became "gone" on paths whose whole job is proving absence.
//
// So the three cases below are not symmetric. `ESRCH` is the only one that proves absence. `EPERM` is a
// process this caller may not signal, which is still a process. And anything else is a question that could not
// be asked, which must reach the caller as a throw rather than as an answer — every caller that concludes
// absence has to distinguish those, and one that cannot afford a throw must say so where it catches it.

import { describe, expect, it, vi } from 'vitest';

import { isProcessAlive } from '#src/infra/node-process.js';

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

    expect(isProcessAlive(123)).toBe(true);
    expect(kill, 'signal 0 asks without delivering anything').toHaveBeenLastCalledWith(123, 0);

    kill.mockRestore();
  });

  it('reports a process it may not signal alive, and only a missing one absent', () => {
    killRejecting('EPERM');
    expect(isProcessAlive(124), "EPERM is someone else's process, not no process").toBe(true);

    killRejecting('ESRCH');
    expect(isProcessAlive(125)).toBe(false);

    vi.restoreAllMocks();
  });

  it('rethrows a question it could not ask rather than answering it', () => {
    killRejecting('EINVAL');
    expect(() => isProcessAlive(126)).toThrow(/EINVAL/u);

    // Including an error carrying no code at all — `process.kill` throws `ERR_INVALID_ARG_TYPE` for a pid
    // outside the range it accepts, and a durable record can hold one.
    killRejecting(undefined);
    expect(() => isProcessAlive(2_147_483_648)).toThrow(/no code/u);

    vi.restoreAllMocks();
  });
});
