import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type * as FollowModule from '#src/cli/follow.js';
import type * as HandoffNoticeModule from '#src/cli/handoff-notice.js';
import type * as HandoffRunnerModule from '#src/coordinator/handoff-routing/runner.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import {
  isWaitCursor,
  parseSerializedWaitCursor,
  serializeWaitCursor,
  type WaitCursor,
  type WaitStreamEvent,
} from '#src/jobs/wait.js';
import { advanceWaitRenderCursor } from '#src/jobs/wait-stream-event.js';
import { createDeferred } from '#tools/testing/deferred.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  renderHandoffNotice: vi.fn(),
  runHandoff: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerModule>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

vi.mock('#src/cli/handoff-notice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffNoticeModule>();
  return { ...actual, renderHandoffNotice: mockState.renderHandoffNotice };
});

const launchResult = {
  kind: 'provider-session',
  launchState: 'running',
  jobId: 'job-1',
  sessionId: 'session-1',
} satisfies AcceptedLaunchResponse;

const waitTiming = {
  origin: 'runtime',
  originAt: '2026-08-04T08:00:00.000Z',
  emittedAt: '2026-08-04T08:00:01.000Z',
  elapsedMs: 1_000,
} as const;

type FollowOptions = Parameters<typeof FollowModule.launchAndFollow>[0];

function recorded(
  continuation: HandoffRunnerModule.DelegatingHandoffContinuation,
): HandoffRunnerModule.HandoffRunResult {
  return { kind: 'recorded', continuation, publicationIncidents: [] };
}

function makeOptions(overrides: Partial<FollowOptions> = {}): FollowOptions {
  return {
    launchResult,
    abortJob: vi.fn().mockResolvedValue({ aborted: ['job-1'], notFound: [] }),
    pluginRoot: '/plugin/root',
    projectRoot: '/project/root',
    emitError: vi.fn(),
    isTTY: false,
    columns: 100,
    ...overrides,
  };
}

function makeBackend(subscribe = vi.fn()) {
  return {
    socketPath: '/tmp/coordinator.sock',
    instanceId: 'backend-1',
    bundleHash: 'bundle-hash',
    flavor: 'prod' as const,
    namespace: 'namespace',
    host: '127.0.0.1',
    port: 4100,
    token: 'token',
    version: '1.0.0',
    jobsWaitExtensions: ['supportsInterrupted', 'supportsWaitV2', 'supportsHandover'],
    request: vi.fn(),
    subscribe,
    ping: vi.fn(),
    health: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeSubscription(events: readonly WaitStreamEvent[]) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

describe('cli follow handoff', () => {
  let sigintHandler: (() => void) | null;

  beforeEach(() => {
    sigintHandler = null;
    process.exitCode = undefined;
    mockState.ensure.mockReset();
    mockState.renderHandoffNotice.mockReset();
    mockState.runHandoff.mockReset();
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');

    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') sigintHandler = listener as () => void;
      return process;
    }) as typeof process.on);
    vi.spyOn(process, 'off').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && sigintHandler === listener) sigintHandler = null;
      return process;
    }) as typeof process.off);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('should hand the runner the exact seq cursor while stdout is still buffered', async () => {
    const progressWrite = createDeferred<void>();
    const secondRunStarted = createDeferred<void>();
    let progressAcknowledged = false;
    const progressEvent: WaitStreamEvent = {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint-one',
      timing: waitTiming,
    };
    const waitingEvent: WaitStreamEvent = { type: 'waiting', waitingJobIds: ['job-1'] };
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([progressEvent, waitingEvent]));

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      if (chunk.toString().includes('checkpoint-one')) {
        void progressWrite.promise.then(() => {
          progressAcknowledged = true;
          callback?.();
        });
      } else {
        callback?.();
      }
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValueOnce(makeBackend(subscribe)).mockResolvedValueOnce(makeBackend());
    mockState.runHandoff
      .mockResolvedValueOnce(
        recorded({ kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } }),
      )
      .mockImplementationOnce(async (operation) => {
        secondRunStarted.resolve();
        expect(progressAcknowledged).toBe(false);
        expect(operation).toEqual({
          kind: 'wait-jobs',
          jobId: 'job-1',
          serializedCursor: serializeWaitCursor({ afterSeq: 4 }),
        });
        return recorded({
          kind: 'delegated',
          version: '2.0.0',
          outcome: { kind: 'handoff-success', version: '2.0.0' } as HandoffRunnerModule.HandoffOutcome,
        });
      });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions());
    await secondRunStarted.promise;

    expect(progressAcknowledged).toBe(false);
    progressWrite.resolve();
    await expect(follow).resolves.toBe(0);
    expect(mockState.renderHandoffNotice).toHaveBeenCalledWith({ kind: 'handoff-success', version: '2.0.0' });
  });

  it('should resume a transient retry from afterSeq and suppress replayed journal facts', async () => {
    const output: string[] = [];
    const progressEvent: WaitStreamEvent = {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint-one',
      timing: waitTiming,
    };
    const terminalEvent: WaitStreamEvent = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 5,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
    };
    const firstSubscribe = vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      async *[Symbol.asyncIterator]() {
        yield progressEvent;
        throw new TypeError('terminated');
      },
    });
    const secondSubscribe = vi.fn().mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      expect(params.cursor).toEqual({ afterSeq: 4 });
      return makeSubscription([progressEvent, terminalEvent]);
    });

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk.toString());
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure
      .mockResolvedValueOnce(makeBackend(firstSubscribe))
      .mockResolvedValueOnce(makeBackend(secondSubscribe));
    mockState.runHandoff.mockResolvedValue(
      recorded({
        kind: 'run-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-unresolved', cause: 'health-request-failed' } },
      }),
    );

    const { launchAndFollow } = await import('#src/cli/follow.js');
    await expect(
      launchAndFollow(makeOptions({ backoffScheduler: vi.fn().mockResolvedValue(undefined) })),
    ).resolves.toBe(0);

    expect(output.filter((chunk) => chunk.includes('checkpoint-one'))).toHaveLength(1);
    expect(output.join('')).toContain('Job job-1 completed');
  });

  it('should continue locally when the runner degrades an unavailable handoff', async () => {
    const terminal: WaitStreamEvent = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 1,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
    };
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([terminal]));
    const emitError = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend(subscribe));
    mockState.runHandoff.mockResolvedValue(
      recorded({
        kind: 'run-current',
        reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
      }),
    );

    const { launchAndFollow } = await import('#src/cli/follow.js');
    await expect(launchAndFollow(makeOptions({ emitError }))).resolves.toBe(0);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(emitError).not.toHaveBeenCalled();
  });

  it('sends a coordinator with no wait extensions only what the v0.10.0 strict schema accepts', async () => {
    // Frozen copy of v0.10.0 `jobWaitSchema` (src/transport/rpc/jobs.ts at that tag).
    const shippedJobWaitSchema = z
      .object({
        jobIds: z.array(z.string().min(1)).min(1),
        projectRoot: z.string().min(1),
        timeoutSeconds: z.number().int().min(1).max(1200).optional(),
        cursor: z.custom<WaitCursor>(isWaitCursor, { message: 'cursor must be a valid wait cursor' }).optional(),
      })
      .strict();
    const terminal: WaitStreamEvent = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 1,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
    };
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([terminal]));
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue({ ...makeBackend(subscribe), version: '0.10.0', jobsWaitExtensions: [] });
    mockState.runHandoff.mockResolvedValue(
      recorded({ kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } }),
    );

    const { launchAndFollow } = await import('#src/cli/follow.js');
    await expect(launchAndFollow(makeOptions())).resolves.toBe(0);

    const params: unknown = subscribe.mock.calls[0]?.[1];
    expect(shippedJobWaitSchema.safeParse(params).success).toBe(true);
    expect(params).not.toHaveProperty('supportsInterrupted');
  });

  it('should preserve a delegated bounded-wait exit code of 75', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.runHandoff.mockResolvedValue(
      recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-exit', exitCode: 75 } }),
    );

    const { launchAndFollow } = await import('#src/cli/follow.js');
    await expect(launchAndFollow(makeOptions())).resolves.toBe(75);

    expect(mockState.renderHandoffNotice).not.toHaveBeenCalled();
  });

  it('should preserve double Ctrl-C abort semantics while delegated waits are active', async () => {
    const firstHandoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    const secondHandoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    const secondRunStarted = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue({ aborted: ['job-1'], notFound: [] });
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.runHandoff.mockReturnValueOnce(firstHandoff.promise).mockImplementationOnce(async () => {
      secondRunStarted.resolve();
      return secondHandoff.promise;
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions({ abortJob }));
    await vi.waitFor(() => expect(mockState.runHandoff).toHaveBeenCalledTimes(1));

    sigintHandler?.();
    expect(abortJob).not.toHaveBeenCalled();
    firstHandoff.resolve(
      recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-signal', signal: 'SIGINT' } }),
    );
    await secondRunStarted.promise;

    sigintHandler?.();
    secondHandoff.resolve(
      recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-signal', signal: 'SIGINT' } }),
    );
    await expect(follow).resolves.toBe(1);

    expect(abortJob).toHaveBeenCalledOnce();
    expect(abortJob).toHaveBeenCalledWith('job-1');
    expect(process.stderr.write).toHaveBeenCalledWith('\nPress Ctrl+C again to abort the job.\n');
  });

  it('should use seq alone for journal replay while rendering snapshot status refreshes', () => {
    const progressed = advanceWaitRenderCursor(
      { afterSeq: 3 },
      {
        type: 'progress',
        jobId: 'job-1',
        seq: 4,
        message: 'checkpoint',
        timing: waitTiming,
      },
    );
    const replayed = advanceWaitRenderCursor(progressed.cursor, {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint',
      timing: waitTiming,
    });
    const waiting = advanceWaitRenderCursor(progressed.cursor, { type: 'waiting', waitingJobIds: ['job-1'] });

    expect(progressed).toEqual({ cursor: { afterSeq: 4 }, shouldRender: true });
    expect(replayed).toEqual({ cursor: { afterSeq: 4 }, shouldRender: false });
    expect(waiting).toEqual({ cursor: { afterSeq: 4 }, shouldRender: true });
    expect(parseSerializedWaitCursor(serializeWaitCursor(progressed.cursor))).toEqual({ afterSeq: 4 });
  });
});
