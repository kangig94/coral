// The evidence law for a process someone else recorded: identity first, then liveness, and a third answer
// for the question that could not be asked.
//
// Two call sites read this predicate with opposite polarity — one may act only on a proven `absent`, the
// other may discount only a proven `absent` — so every branch has to be exact in both directions here rather
// than at whichever caller happens to have a test.

import { describe, expect, it, vi } from 'vitest';

import {
  createRecordedProcessObserver,
  type ProcessIncarnation,
  type ProcessLiveness,
} from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const RECORDED = testIncarnation('recorded');
const SOMEONE_ELSE = testIncarnation('someone-else');
const PID = 4321;

type Readers = Readonly<{
  readIncarnation: (pid: number) => ProcessIncarnation | null;
  observeLiveness: (pid: number) => ProcessLiveness;
}>;

function observerWith(readers: Partial<Readers>) {
  const readIncarnation = vi.fn(readers.readIncarnation ?? ((): ProcessIncarnation | null => null));
  const observeLiveness = vi.fn(readers.observeLiveness ?? ((): ProcessLiveness => 'unknown'));
  return {
    observe: createRecordedProcessObserver({ readIncarnation, observeLiveness }),
    readIncarnation,
    observeLiveness,
  };
}

function failing(): never {
  throw new Error('the reader could not answer');
}

describe('recorded process observation', () => {
  it('decides on a readable token and does not give liveness a second vote', () => {
    const wearingThePid = observerWith({ readIncarnation: () => SOMEONE_ELSE, observeLiveness: () => 'alive' });
    expect(
      wearingThePid.observe({ pid: PID, incarnation: RECORDED }),
      'a pid answering with someone else is proof the recorded process is gone, however alive that pid is',
    ).toBe('absent');

    const stillThere = observerWith({ readIncarnation: () => RECORDED, observeLiveness: () => 'absent' });
    expect(stillThere.observe({ pid: PID, incarnation: RECORDED })).toBe('alive');

    expect(wearingThePid.observeLiveness).not.toHaveBeenCalled();
    expect(stillThere.observeLiveness).not.toHaveBeenCalled();
  });

  it.each(['alive', 'absent', 'unknown'] as const)(
    'passes liveness through unchanged (%s) when the token is unreadable',
    (liveness) => {
      const { observe, readIncarnation, observeLiveness } = observerWith({
        readIncarnation: () => null,
        observeLiveness: () => liveness,
      });

      expect(observe({ pid: PID, incarnation: RECORDED })).toBe(liveness);
      expect(readIncarnation).toHaveBeenCalledWith(PID);
      expect(observeLiveness).toHaveBeenCalledWith(PID);
    },
  );

  it.each(['alive', 'absent', 'unknown'] as const)(
    'asks liveness alone (%s) when the record carries no incarnation',
    (liveness) => {
      // The reader here would answer, and answering is the danger: a token compared against a record that has
      // none disagrees with it, which would read as proof of absence for a process nobody looked for.
      const { observe, readIncarnation, observeLiveness } = observerWith({
        readIncarnation: () => RECORDED,
        observeLiveness: () => liveness,
      });

      expect(observe({ pid: PID })).toBe(liveness);
      expect(readIncarnation).not.toHaveBeenCalled();
      expect(observeLiveness).toHaveBeenCalledWith(PID);
    },
  );

  it.each<[string, Partial<Readers>]>([
    ['the identity read throws', { readIncarnation: failing }],
    ['the liveness observation throws', { readIncarnation: () => null, observeLiveness: failing }],
  ])('answers unknown, never absent, when %s', (_label, readers) => {
    const { observe } = observerWith({ observeLiveness: () => 'absent', ...readers });

    expect(
      observe({ pid: PID, incarnation: RECORDED }),
      'a question that could not be asked has not been answered, and only absence may finalize anything',
    ).toBe('unknown');
  });
});
