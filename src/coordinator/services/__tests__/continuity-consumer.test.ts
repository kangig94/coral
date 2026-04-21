import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeJobStream } from '../continuity-consumer.js';
import { backendLog } from '../../../shared/backend-log.js';

describe('consumeJobStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads session versions through continuity checkpoints and preserves event order', async () => {
    const appendProgress = vi.fn();
    const appendTerminal = vi.fn();
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 8 })
      .mockResolvedValueOnce({ ok: true, nextVersion: 9 });

    const result = await consumeJobStream({
      jobId: 'job-1',
      sessionId: 'session-1',
      initialVersion: 7,
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
        checkpointJobContinuityAtomic,
      },
      appendProgress,
      appendTerminal,
    });

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
    const checkpointJobContinuityAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-2',
      sessionId: 'session-2',
      initialVersion: 3,
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
        checkpointJobContinuityAtomic,
      },
      appendProgress,
      appendTerminal,
    });

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

  it('warns on stale checkpoints, drains the terminal, and preserves the last successful continuity', async () => {
    const appendProgress = vi.fn();
    const appendTerminal = vi.fn();
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 11 })
      .mockResolvedValueOnce({ ok: false });

    const result = await consumeJobStream({
      jobId: 'job-3',
      sessionId: 'session-3',
      initialVersion: 10,
      stream: (async function* () {
        yield {
          kind: 'continuity',
          conversationRef: 'thread-1',
          resumable: true,
          providerContinuity: { threadId: 'thread-1' },
        } as const;
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
            warnings: ['terminal-kept'],
          },
        } as const;
      })(),
      sessionApi: {
        checkpointJobContinuityAtomic,
      },
      appendProgress,
      appendTerminal,
    });

    expect(checkpointJobContinuityAtomic).toHaveBeenNthCalledWith(1, 'session-3', {
      expectedActiveJobId: 'job-3',
      expectedVersion: 10,
      snapshot: {
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { threadId: 'thread-1' },
      },
    });
    expect(checkpointJobContinuityAtomic).toHaveBeenNthCalledWith(2, 'session-3', {
      expectedActiveJobId: 'job-3',
      expectedVersion: 11,
      snapshot: {
        conversationRef: 'thread-2',
        resumable: false,
        providerContinuity: { threadId: 'thread-2', state: 'closed' },
      },
    });
    expect(warn).toHaveBeenCalledWith(
      'Continuity checkpoint went stale for claimed job job-3 on session session-3; draining terminal.',
    );
    expect(appendProgress).not.toHaveBeenCalled();
    expect(appendTerminal).toHaveBeenCalledWith(
      {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      { warnings: ['terminal-kept'] },
    );
    expect(result).toEqual({
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      diagnostics: {
        warnings: ['terminal-kept'],
      },
      finalContinuity: {
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { threadId: 'thread-1' },
      },
    });
  });
});
