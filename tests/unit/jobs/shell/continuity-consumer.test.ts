import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeJobStream } from '#src/jobs/shell/continuity-consumer.js';
import { backendLog } from '#src/infra/backend-log.js';

describe('consumeJobStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads session versions through continuity checkpoints and preserves event order', async () => {
    const appendProgress = vi.fn();
    const recordTerminal = vi.fn();
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 8 })
      .mockResolvedValueOnce({ ok: true, nextVersion: 9 });
    const recordArtifactHandleAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-1',
      providerName: 'codex',
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
        recordArtifactHandleAtomic,
      },
      appendProgress,
      recordTerminal,
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
    expect(recordArtifactHandleAtomic).not.toHaveBeenCalled();
    expect(recordTerminal).toHaveBeenCalledTimes(1);
    expect(recordTerminal).toHaveBeenCalledWith({
      kind: 'terminal',
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      diagnostics: { warnings: ['kept'] },
    });
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
    const recordTerminal = vi.fn();
    const checkpointJobContinuityAtomic = vi.fn();
    const recordArtifactHandleAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-2',
      providerName: 'codex',
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
        recordArtifactHandleAtomic,
      },
      appendProgress,
      recordTerminal,
    });

    expect(checkpointJobContinuityAtomic).not.toHaveBeenCalled();
    expect(recordArtifactHandleAtomic).not.toHaveBeenCalled();
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
    const recordTerminal = vi.fn();
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 11 })
      .mockResolvedValueOnce({ ok: false });
    const recordArtifactHandleAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-3',
      providerName: 'codex',
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
        recordArtifactHandleAtomic,
      },
      appendProgress,
      recordTerminal,
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
    expect(recordArtifactHandleAtomic).not.toHaveBeenCalled();
    expect(recordTerminal).toHaveBeenCalledWith({
      kind: 'terminal',
      terminal: {
        content: 'done',
        outcome: { kind: 'completed' },
      },
      diagnostics: { warnings: ['terminal-kept'] },
    });
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

  it('records artifact handles before continuity and advances the expected version for the checkpoint', async () => {
    const appendProgress = vi.fn();
    const recordTerminal = vi.fn();
    const recordArtifactHandleAtomic = vi.fn().mockResolvedValueOnce({ ok: true, nextVersion: 6 });
    const checkpointJobContinuityAtomic = vi.fn().mockResolvedValueOnce({ ok: true, nextVersion: 7 });

    const result = await consumeJobStream({
      jobId: 'job-4',
      providerName: 'codex',
      sessionId: 'session-4',
      initialVersion: 5,
      stream: (async function* () {
        yield {
          kind: 'artifact_handle',
          handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
          identity: { kind: 'test-artifact', threadId: 'thread-1' },
        } as const;
        yield {
          kind: 'continuity',
          conversationRef: 'thread-1',
          resumable: true,
          providerContinuity: { threadId: 'thread-1' },
        } as const;
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
        recordArtifactHandleAtomic,
      },
      appendProgress,
      recordTerminal,
    });

    expect(recordArtifactHandleAtomic).toHaveBeenCalledWith('session-4', {
      expectedActiveJobId: 'job-4',
      expectedVersion: 5,
      provider: 'codex',
      handle: '/home/user/.codex/sessions/2026/05/04/rollout-a-thread-1.jsonl',
      identity: { kind: 'test-artifact', threadId: 'thread-1' },
      sourceJobId: 'job-4',
    });
    expect(checkpointJobContinuityAtomic).toHaveBeenCalledWith('session-4', {
      expectedActiveJobId: 'job-4',
      expectedVersion: 6,
      snapshot: {
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { threadId: 'thread-1' },
      },
    });
    expect(result.finalContinuity).toEqual({
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: { threadId: 'thread-1' },
    });
  });
});
