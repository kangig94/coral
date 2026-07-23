import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeJobStream } from '#src/jobs/shell/continuity-consumer.js';
import { backendLog } from '#src/infra/backend-log.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { bindingFailure, bindingSuccess } from '#src/providers/contracts/binding.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { validatedTestContinuityBlob } from '#tests/helpers/session.js';

const decodeContinuity = (rawContinuity: unknown) =>
  bindingSuccess(
    rawContinuity === null ? undefined : validatedTestContinuityBlob(rawContinuity as Record<string, unknown>),
  );

describe('consumeJobStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads session versions through continuity checkpoints and preserves event order', async () => {
    const appendProgress = vi.fn();
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 8 })
      .mockResolvedValueOnce({ ok: true, nextVersion: 9 });
    const recordArtifactHandleAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-1',
      sessionId: 'session-1',
      initialVersion: 7,
      decodeContinuity,
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
            durationMs: 0,
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
    expect(result).toEqual({
      kind: 'terminal',
      claimVersion: 9,
      event: {
        kind: 'terminal',
        terminal: {
          content: 'done',
          outcome: { kind: 'completed' },
          durationMs: 0,
        },
        diagnostics: {
          warnings: ['kept'],
        },
      },
    });
  });

  it('returns only the provider terminal when the stream never emits a continuity body', async () => {
    const appendProgress = vi.fn();
    const checkpointJobContinuityAtomic = vi.fn();
    const recordArtifactHandleAtomic = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-2',
      sessionId: 'session-2',
      initialVersion: 3,
      decodeContinuity,
      stream: (async function* () {
        yield { kind: 'progress', message: 'only-progress' } as const;
        yield {
          kind: 'terminal',
          terminal: {
            content: 'done',
            outcome: { kind: 'completed' },
            durationMs: 0,
          },
          diagnostics: {},
        } as const;
      })(),
      sessionApi: {
        checkpointJobContinuityAtomic,
        recordArtifactHandleAtomic,
      },
      appendProgress,
    });

    expect(checkpointJobContinuityAtomic).not.toHaveBeenCalled();
    expect(recordArtifactHandleAtomic).not.toHaveBeenCalled();
    expect(appendProgress).toHaveBeenCalledWith('only-progress');
    expect(result).toEqual({
      kind: 'terminal',
      claimVersion: 3,
      event: {
        kind: 'terminal',
        terminal: {
          content: 'done',
          outcome: { kind: 'completed' },
          durationMs: 0,
        },
        diagnostics: {},
      },
    });
  });

  it('rejects provider continuity that the bound provider cannot persist', async () => {
    const checkpointJobContinuityAtomic = vi.fn();
    const rejection = vi.fn();

    const result = await consumeJobStream({
      jobId: 'job-invalid-continuity',
      sessionId: 'session-invalid-continuity',
      initialVersion: 1,
      decodeContinuity: () => bindingFailure({ reason: 'invalid-persisted-binding', provider: 'strict-provider' }),
      stream: (async function* () {
        yield attachContinuityCommit(
          {
            kind: 'continuity',
            conversationRef: 'thread-invalid',
            resumable: true,
            providerContinuity: { unknown: true },
          },
          { commit: vi.fn(), reject: rejection },
        );
      })(),
      sessionApi: { checkpointJobContinuityAtomic, recordArtifactHandleAtomic: vi.fn() },
      appendProgress: vi.fn(),
    });

    expect(result).toEqual({ kind: 'suspended', reason: 'durable_state_uncommitted' });
    expect(checkpointJobContinuityAtomic).not.toHaveBeenCalled();
    expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('invalid') }));
  });

  it('fails closed on a stale checkpoint without accepting a later terminal', async () => {
    const appendProgress = vi.fn();
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const checkpointJobContinuityAtomic = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, nextVersion: 11 })
      .mockResolvedValueOnce({ ok: false });
    const recordArtifactHandleAtomic = vi.fn();

    const consumed = consumeJobStream({
      jobId: 'job-3',
      sessionId: 'session-3',
      initialVersion: 10,
      decodeContinuity,
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
            durationMs: 0,
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
    });

    await expect(consumed).resolves.toEqual({ kind: 'suspended', reason: 'durable_state_uncommitted' });

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
    expect(warn).toHaveBeenCalledWith('Continuity checkpoint went stale for claimed job job-3 on session session-3.');
    expect(appendProgress).not.toHaveBeenCalled();
    expect(recordArtifactHandleAtomic).not.toHaveBeenCalled();
  });

  it('records artifact handles before continuity and advances the expected version for the checkpoint', async () => {
    const appendProgress = vi.fn();
    const recordArtifactHandleAtomic = vi.fn().mockResolvedValueOnce({ ok: true, nextVersion: 6 });
    const checkpointJobContinuityAtomic = vi.fn().mockResolvedValueOnce({ ok: true, nextVersion: 7 });

    const result = await consumeJobStream({
      jobId: 'job-4',
      sessionId: 'session-4',
      initialVersion: 5,
      decodeContinuity,
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
            durationMs: 0,
          },
          diagnostics: {},
        } as const;
      })(),
      sessionApi: {
        checkpointJobContinuityAtomic,
        recordArtifactHandleAtomic,
      },
      appendProgress,
    });

    expect(recordArtifactHandleAtomic).toHaveBeenCalledWith('session-4', {
      expectedActiveJobId: 'job-4',
      expectedVersion: 5,
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
    expect(result).not.toHaveProperty('finalContinuity');
  });

  it('commits the provider receipt only after the atomic checkpoint succeeds', async () => {
    const persisted = createDeferred<{ ok: true; nextVersion: number }>();
    const committed = createDeferred<void>();
    let providerSideEffectStarted = false;
    const stream = (async function* () {
      yield attachContinuityCommit(
        {
          kind: 'continuity',
          conversationRef: 'thread-durable',
          resumable: true,
          providerContinuity: { threadId: 'thread-durable' },
        },
        { commit: () => committed.resolve(), reject: (error) => committed.reject(error) },
      );
      await committed.promise;
      providerSideEffectStarted = true;
      yield {
        kind: 'terminal',
        terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
        diagnostics: {},
      } as const;
    })();
    const checkpointJobContinuityAtomic = vi.fn(() => persisted.promise);
    const consumed = consumeJobStream({
      jobId: 'job-durable',
      sessionId: 'session-durable',
      initialVersion: 1,
      decodeContinuity,
      stream,
      sessionApi: { checkpointJobContinuityAtomic, recordArtifactHandleAtomic: vi.fn() },
      appendProgress: vi.fn(),
    });

    await vi.waitFor(() => expect(checkpointJobContinuityAtomic).toHaveBeenCalledTimes(1));
    expect(providerSideEffectStarted).toBe(false);
    persisted.resolve({ ok: true, nextVersion: 2 });
    await consumed;
    expect(providerSideEffectStarted).toBe(true);
  });

  it('rejects the provider receipt on a stale checkpoint so no side effect starts', async () => {
    const committed = createDeferred<void>();
    // Production continuity receipts install a rejection observer before the
    // event is yielded; mirror that contract in this hand-built fixture.
    void committed.promise.catch(() => undefined);
    let providerSideEffectStarted = false;
    const stream = (async function* () {
      yield attachContinuityCommit(
        {
          kind: 'continuity',
          conversationRef: 'thread-stale',
          resumable: true,
          providerContinuity: { threadId: 'thread-stale' },
        },
        { commit: () => committed.resolve(), reject: (error) => committed.reject(error) },
      );
      try {
        await committed.promise;
        providerSideEffectStarted = true;
      } catch {
        // A lost claim is a failed checkpoint barrier, not permission to run.
      }
      yield {
        kind: 'terminal',
        terminal: { content: 'stale', outcome: { kind: 'failed' }, durationMs: 0 },
        diagnostics: {},
        failureCause: {
          type: 'session.provider_failed',
          body: { provider: 'fixture', reason: 'request_failed', message: 'checkpoint rejected' },
        },
      } as const;
    })();

    await expect(
      consumeJobStream({
        jobId: 'job-stale',
        sessionId: 'session-stale',
        initialVersion: 1,
        decodeContinuity,
        stream,
        sessionApi: {
          checkpointJobContinuityAtomic: vi.fn(async () => ({ ok: false as const })),
          recordArtifactHandleAtomic: vi.fn(),
        },
        appendProgress: vi.fn(),
      }),
    ).resolves.toEqual({ kind: 'suspended', reason: 'durable_state_uncommitted' });

    expect(providerSideEffectStarted).toBe(false);
  });

  it('rejects the provider receipt when checkpoint persistence throws', async () => {
    const rejection = vi.fn();
    let providerSideEffectStarted = false;
    const stream = (async function* () {
      yield attachContinuityCommit(
        {
          kind: 'continuity',
          conversationRef: 'thread-write-error',
          resumable: true,
          providerContinuity: { threadId: 'thread-write-error' },
        },
        { commit: vi.fn(), reject: rejection },
      );
      providerSideEffectStarted = true;
    })();
    const failure = new Error('sqlite write failed');

    await expect(
      consumeJobStream({
        jobId: 'job-write-error',
        sessionId: 'session-write-error',
        initialVersion: 1,
        decodeContinuity,
        stream,
        sessionApi: {
          checkpointJobContinuityAtomic: vi.fn(async () => Promise.reject(failure)),
          recordArtifactHandleAtomic: vi.fn(),
        },
        appendProgress: vi.fn(),
      }),
    ).resolves.toEqual({ kind: 'suspended', reason: 'durable_state_uncommitted' });
    expect(rejection).toHaveBeenCalledWith(failure);
    expect(providerSideEffectStarted).toBe(false);
  });
});
