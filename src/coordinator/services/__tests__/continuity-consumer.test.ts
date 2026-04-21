import { describe, expect, it, vi } from 'vitest';

import { consumeJobStream } from '../continuity-consumer.js';

describe('consumeJobStream', () => {
  it('threads session versions through continuity checkpoints and preserves event order', async () => {
    const appendProgress = vi.fn();
    const appendTerminal = vi.fn();
    const readClaimVersion = vi.fn(() => 7);
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 8 })
      .mockResolvedValueOnce({ ok: true, nextVersion: 9 });

    const result = await consumeJobStream({
      jobId: 'job-1',
      sessionId: 'session-1',
      stream: (async function* () {
        yield { kind: 'progress', message: 'starting' } as const;
        yield {
          kind: 'continuity',
          conversationRef: 'thread-1',
          resumable: true,
          providerContinuity: { threadId: 'thread-1' },
        } as const;
        yield { kind: 'progress', message: 'streaming' } as const;
        yield {
          kind: 'continuity',
          conversationRef: 'thread-2',
          resumable: false,
          providerContinuity: { threadId: 'thread-2', state: 'closed' },
        } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: 'done',
            outcome: { kind: 'completed' },
          },
          diagnostics: {
            warnings: ['kept'],
          },
        } as const;
      })(),
      sessionApi: {
        readClaimVersion,
        checkpointJobContinuityAtomic,
      },
      appendProgress,
      appendTerminal,
    });

    expect(readClaimVersion).toHaveBeenCalledTimes(1);
    expect(readClaimVersion).toHaveBeenCalledWith('session-1', 'job-1');
    expect(checkpointJobContinuityAtomic).toHaveBeenNthCalledWith(1, 'session-1', {
      expectedActiveJobId: 'job-1',
      expectedVersion: 7,
      snapshot: {
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { threadId: 'thread-1' },
      },
    });
    expect(checkpointJobContinuityAtomic).toHaveBeenNthCalledWith(2, 'session-1', {
      expectedActiveJobId: 'job-1',
      expectedVersion: 8,
      snapshot: {
        conversationRef: 'thread-2',
        resumable: false,
        providerContinuity: { threadId: 'thread-2', state: 'closed' },
      },
    });
    expect(appendProgress.mock.calls).toEqual([['starting'], ['streaming']]);
    expect(appendTerminal).toHaveBeenCalledTimes(1);
    expect(appendTerminal).toHaveBeenCalledWith(
      {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      { warnings: ['kept'] },
    );
    expect(result).toEqual({
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      diagnostics: {
        warnings: ['kept'],
      },
      finalContinuity: {
        conversationRef: 'thread-2',
        resumable: false,
        providerContinuity: { threadId: 'thread-2', state: 'closed' },
      },
    });
  });

  it('returns null continuity when the stream never emits a continuity body', async () => {
    const appendProgress = vi.fn();
    const appendTerminal = vi.fn();
    const readClaimVersion = vi.fn(() => 3);
    const checkpointJobContinuityAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-2',
      sessionId: 'session-2',
      stream: (async function* () {
        yield { kind: 'progress', message: 'only-progress' } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: 'done',
            outcome: { kind: 'completed' },
          },
          diagnostics: {},
        } as const;
      })(),
      sessionApi: {
        readClaimVersion,
        checkpointJobContinuityAtomic,
      },
      appendProgress,
      appendTerminal,
    });

    expect(readClaimVersion).not.toHaveBeenCalled();
    expect(checkpointJobContinuityAtomic).not.toHaveBeenCalled();
    expect(appendProgress).toHaveBeenCalledWith('only-progress');
    expect(result).toEqual({
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      diagnostics: {},
      finalContinuity: null,
    });
  });
});
