import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeJobStream } from '#src/jobs/shell/continuity-consumer.js';
import { backendLog } from '#src/infra/backend-log.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { bindingSuccess } from '#src/providers/contracts/binding.js';
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
