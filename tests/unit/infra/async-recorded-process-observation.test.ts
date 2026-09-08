// Recorded identity observation must remain non-blocking and preserve alive, absent, and unknown distinctly.

import { describe, expect, it, vi } from 'vitest';

import {
  createAsyncRecordedProcessObserver,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RECORDED = testIncarnation('recorded');
const SOMEONE_ELSE = testIncarnation('someone-else');
const PID = 4321;

type Readers = Readonly<{
  readIncarnation: (pid: number, signal?: AbortSignal) => Promise<ProcessIncarnation | null>;
  observeLiveness: (pid: number) => ProcessLiveness;
}>;

function observerWith(readers: Partial<Readers>) {
  const readIncarnation = vi.fn(
    readers.readIncarnation ?? ((): Promise<ProcessIncarnation | null> => Promise.resolve(null)),
  );
  const observeLiveness = vi.fn(readers.observeLiveness ?? ((): ProcessLiveness => 'unknown'));
  return {
    observe: createAsyncRecordedProcessObserver({ readIncarnation, observeLiveness }),
    readIncarnation,
    observeLiveness,
  };
}

describe('async recorded process observation', () => {
  it('decides absent on kill(pid, 0) ESRCH without ever reading the token', async () => {
    const { observe, readIncarnation, observeLiveness } = observerWith({ observeLiveness: () => 'absent' });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('absent');

    expect(observeLiveness).toHaveBeenCalledWith(PID);
    expect(readIncarnation, 'a genuinely absent pid needs no identity read to decide').not.toHaveBeenCalled();
  });

  it('decides alive when the pid exists and the observed incarnation matches', async () => {
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(RECORDED),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('alive');
  });

  it('decides absent on pid reuse — a readable token that disagrees, whatever liveness said', async () => {
    const { observe, observeLiveness } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(SOMEONE_ELSE),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('absent');
    expect(observeLiveness).toHaveBeenCalledWith(PID);
  });

  it('answers unknown, never the sync sibling’s pid-only alive, when the token cannot be read', async () => {
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(null),
    });

    await expect(
      observe({ pid: PID, incarnation: RECORDED }),
      'pid-only life cannot prove the admitted holder still owns the pid',
    ).resolves.toBe('unknown');
  });

  it('decides absent when the pid disappears during the identity read', async () => {
    const observeLiveness = vi.fn<() => ProcessLiveness>().mockReturnValueOnce('alive').mockReturnValue('absent');
    const { observe } = observerWith({
      observeLiveness,
      readIncarnation: () => Promise.resolve(null),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('absent');
    expect(observeLiveness).toHaveBeenCalledTimes(2);
  });

  it('answers unknown on a probe timeout, the same as any other unreadable token', async () => {
    // A timed-out or unreadable identity probe cannot license pid-only life as recorded-holder evidence.
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(null),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('unknown');
  });

  it('answers unknown when the liveness check is itself inconclusive, even though the token matches', async () => {
    // Inconclusive liveness must remain unknown even when the identity token matches.
    const { observe } = observerWith({
      observeLiveness: () => 'unknown',
      readIncarnation: () => Promise.resolve(RECORDED),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('unknown');
  });

  it.each<[string, Partial<Readers>]>([
    ['the identity read rejects', { readIncarnation: () => Promise.reject(new Error('probe failed')) }],
    [
      'the liveness observation throws',
      {
        observeLiveness: () => {
          throw new Error('liveness probe failed');
        },
      },
    ],
  ])('answers unknown, never absent, when %s', async (_label, readers) => {
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(RECORDED),
      ...readers,
    });

    await expect(
      observe({ pid: PID, incarnation: RECORDED }),
      'a question that could not be asked has not been answered, and only absence may finalize anything',
    ).resolves.toBe('unknown');
  });

  it('does not block the event loop while a read is in flight', async () => {
    let settleRead!: (value: ProcessIncarnation | null) => void;
    let readSettled = false;
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () =>
        new Promise((resolve) => {
          settleRead = (value) => {
            readSettled = true;
            resolve(value);
          };
        }),
    });

    const observation = observe({ pid: PID, incarnation: RECORDED });
    const unrelatedWork = vi.fn();
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        unrelatedWork();
        resolve();
      });
    });

    expect(unrelatedWork).toHaveBeenCalledOnce();
    expect(readSettled).toBe(false);

    settleRead(RECORDED);
    await expect(observation).resolves.toBe('alive');
  });

  it('answers unknown immediately when its caller aborts an in-flight read', async () => {
    let settleRead!: (value: ProcessIncarnation | null) => void;
    const { observe, readIncarnation } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () =>
        new Promise((resolve) => {
          settleRead = resolve;
        }),
    });
    const abort = new AbortController();
    const observation = observe({ pid: PID, incarnation: RECORDED }, abort.signal);

    abort.abort(new Error('deadline expired'));

    await expect(observation).resolves.toBe('unknown');
    expect(readIncarnation).toHaveBeenCalledWith(PID, abort.signal);
    settleRead(RECORDED);
  });
});
