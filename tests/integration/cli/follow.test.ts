import { savedCursor } from '#tests/helpers/wait-session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type * as FollowMod from '#src/cli/follow.js';

type FollowModule = typeof FollowMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

const waitTiming = {
  origin: 'runtime',
  originAt: '2026-07-03T08:00:00.000Z',
  emittedAt: '2026-07-03T08:00:02.000Z',
  elapsedMs: 2_000,
} as const;

function makeProgressEvent(message = 'Still running'): Extract<WaitStreamEvent, { type: 'progress' }> {
  return {
    type: 'progress',
    jobId: 'job-1',
    seq: 1,
    message,
    timing: waitTiming,
  };
}

function makeTerminalEvent(
  result: Record<string, unknown> = {},
  overrides: Partial<Extract<WaitStreamEvent, { type: 'terminal' }>> = {},
): Extract<WaitStreamEvent, { type: 'terminal' }> {
  return {
    type: 'terminal',
    jobId: 'job-1',
    seq: 1,
    remainingJobIds: [],
    resultPath: '/tmp/result.md',
    availability: { kind: 'available', resultPath: '/tmp/result.md' },
    result: {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 0,
      ...result,
    } as Extract<WaitStreamEvent, { type: 'terminal' }>['result'],
    cursor: null,
    exitCode: 0,
    ...overrides,
  };
}

function makeSubscription(generatorFactory: () => AsyncGenerator<WaitStreamEvent>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: generatorFactory,
  };
}

let cachedFollowModule: FollowModule | null = null;
async function loadFollowModule(): Promise<FollowModule> {
  cachedFollowModule ??= await import('#src/cli/follow.js');
  return cachedFollowModule;
}

describe('cli follow', () => {
  let stdout = '';

  beforeEach(() => {
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      stdout += toText(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resubscribes with the current cursor after a handover notice, without spending a retry', async () => {
    const { followJobs } = await loadFollowModule();
    const progressEvent = makeProgressEvent('Before handover');
    const terminalEvent = makeTerminalEvent({}, { seq: 2 });
    const emitError = vi.fn();
    const backoffScheduler = vi.fn(async (_delayMs: number) => undefined);
    const handedOver = {
      close: vi.fn().mockResolvedValue(undefined),
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<unknown> {
        yield { type: 'cursor', cursor: savedCursor(0) };
        yield progressEvent;
        yield { type: 'cursor', cursor: savedCursor(1) };
        yield { type: 'handover' };
      },
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(handedOver)
      .mockResolvedValueOnce(
        makeSubscription(async function* () {
          yield terminalEvent;
        }),
      );

    const exitCode = await followJobs({
      jobIds: ['job-1'],
      projectRoot: '/project/root',
      emitError,
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      connect,
      backoffScheduler,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Before handover');
    expect(emitError).not.toHaveBeenCalled();
    expect(backoffScheduler).not.toHaveBeenCalled();
    expect(handedOver.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[0]).toMatchObject({ jobIds: ['job-1'], cursor: savedCursor(1) });
  });
  it('returns the emitted envelope exit code on non-transient stream failures without retrying', async () => {
    const { followJobs } = await loadFollowModule();
    const failure = new Error('fatal wait failure');
    const emitError = vi.fn(() => {
      process.exitCode = 70;
    });
    const connect = vi.fn().mockResolvedValue(
      makeSubscription(async function* () {
        throw failure;
      }),
    );

    try {
      await expect(
        followJobs({
          jobIds: ['job-1'],
          projectRoot: '/project/root',
          emitError,
          render: { isTTY: false, columns: 80, embed: false, verbose: false },
          connect,
        }),
      ).resolves.toBe(70);
      expect(emitError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      process.exitCode = undefined;
    }
  });
});
