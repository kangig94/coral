// The non-blocking, stricter sibling of `recorded-process-observation.test.ts`: the same three-answer
// question, but answered without ever calling `execFileSync`/`readFileSync`, and with no pid-only `alive`
// fallback when the incarnation cannot be read — pid-only life cannot prove the admitted holder still owns
// the pid, which is why AC2 requires this sibling to be stricter rather than merely non-blocking.

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
  readIncarnation: (pid: number) => Promise<ProcessIncarnation | null>;
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

  it('answers unknown on a probe timeout, the same as any other unreadable token', async () => {
    // The reader contract is: a timed-out platform probe resolves null exactly like any other unreadable
    // read (see linux/mac-process-incarnation-async.test.ts for the bound that produces this null). This
    // combinator does not and cannot distinguish "timed out" from "unreadable for another reason" — both
    // answer unknown, never absent and never alive.
    const { observe } = observerWith({
      observeLiveness: () => 'alive',
      readIncarnation: () => Promise.resolve(null),
    });

    await expect(observe({ pid: PID, incarnation: RECORDED })).resolves.toBe('unknown');
  });

  it('answers unknown when the liveness check is itself inconclusive, even though the token matches', async () => {
    // "liveness ... cannot be observed" is its own trigger for unknown (AC2), independent of whether identity
    // could be — a matching, readable token does not override an inconclusive liveness answer.
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
    let ticked = 0;
    const interval = setInterval(() => {
      ticked += 1;
    }, 1);
    try {
      const { observe } = observerWith({
        observeLiveness: () => 'alive',
        readIncarnation: () => new Promise((resolve) => setTimeout(() => resolve(RECORDED), 30)),
      });

      await observe({ pid: PID, incarnation: RECORDED });

      expect(ticked, 'a synchronous probe would have starved every other timer for its whole duration').toBeGreaterThan(
        0,
      );
    } finally {
      clearInterval(interval);
    }
  });
});
