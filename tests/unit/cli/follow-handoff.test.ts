import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FollowModule from '#src/cli/follow.js';
import type * as HandoffNoticeModule from '#src/cli/handoff-notice.js';
import type * as HandoffRunnerModule from '#src/coordinator/handoff-routing/runner.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import { type WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { createDeferred } from '#tools/testing/deferred.js';

const frame = (seq: number): WaitStreamEvent => ({ type: 'cursor', cursor: savedCursor(seq) });

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

beforeAll(async () => {
  await import('#src/cli/follow.js');
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
    const waitingEvent: WaitStreamEvent = {
      type: 'waiting',
      waitingJobIds: ['job-1'],
      cursor: savedCursor(4),
      exitCode: 75,
    };
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([frame(3), progressEvent, waitingEvent]));

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
        expect(operation).toEqual({ kind: 'wait-jobs', jobId: 'job-1', serializedCursor: savedCursor(4) });
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

  it('should resume a transient retry from the last cursor frame so no framed line repeats', async () => {
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
      availability: { kind: 'available', resultPath: '/tmp/result.md' },
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
      cursor: null,
      exitCode: 0,
    };
    const firstSubscribe = vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      async *[Symbol.asyncIterator]() {
        yield frame(3);
        yield progressEvent;
        yield frame(4);
        throw new TypeError('terminated');
      },
    });
    const secondSubscribe = vi.fn().mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      expect(params.cursor).toEqual(savedCursor(4));
      return makeSubscription([terminalEvent]);
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

  it('stops a locally folded follow on Ctrl+C with a continuation at the folded cursor', async () => {
    const output: string[] = [];
    const progressApplied = createDeferred<void>();
    const subscribe = vi
      .fn()
      .mockImplementation(async (_method: string, _params: unknown, options: { signal: AbortSignal }) => ({
        close: vi.fn().mockResolvedValue(undefined),
        async *[Symbol.asyncIterator]() {
          yield frame(3);
          yield {
            type: 'progress',
            jobId: 'job-1',
            seq: 4,
            message: 'checkpoint-one',
            timing: waitTiming,
          } satisfies WaitStreamEvent;
          yield frame(4);
          progressApplied.resolve();
          await new Promise<void>((resolve) =>
            options.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          throw options.signal.reason;
        },
      }));
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk.toString());
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend(subscribe));
    mockState.runHandoff.mockResolvedValue(
      recorded({ kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } }),
    );

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const options = makeOptions();
    const follow = launchAndFollow(options);
    await progressApplied.promise;
    sigintHandler?.();

    await expect(follow).resolves.toBe(75);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(options.emitError).not.toHaveBeenCalled();
    const text = output.join('');
    expect(text.match(/checkpoint-one/g)).toHaveLength(1);
    expect(text).toContain(`Run coral-cli wait jobs job-1 --cursor ${savedCursor(4)} to continue waiting.`);
    expect(text.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  });

  it('mirrors a delegated wait ending 75 after a Ctrl+C without retrying, since a terminal may carry 75', async () => {
    const output: string[] = [];
    const handoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    const runStarted = createDeferred<void>();
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk.toString());
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.runHandoff.mockImplementationOnce(async () => {
      runStarted.resolve();
      return handoff.promise;
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const options = makeOptions();
    const follow = launchAndFollow(options);
    await runStarted.promise;
    expect(mockState.runHandoff.mock.calls[0][0]).toEqual({ kind: 'wait-jobs', jobId: 'job-1' });

    sigintHandler?.();
    handoff.resolve(recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-exit', exitCode: 75 } }));
    await expect(follow).resolves.toBe(75);
    expect(mockState.runHandoff).toHaveBeenCalledTimes(1);
    expect(options.emitError).not.toHaveBeenCalled();
    // The child printed its own continuation; the parent must not add a second one.
    expect(output.join('')).not.toContain('Run coral-cli wait jobs');
  });
  it('forwards a SIGINT sent only to this process to the delegated child, which prints the one continuation', async () => {
    const output: string[] = [];
    const handoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    const child = { kill: vi.fn() };
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk.toString());
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mockState.ensure.mockResolvedValue(makeBackend());
    const delegated = createDeferred<void>();
    mockState.runHandoff.mockImplementationOnce(async (_operation, options: HandoffRunnerModule.RunHandoffOptions) => {
      options.onDelegatedChild?.(child as never);
      delegated.resolve();
      return handoff.promise;
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const options = makeOptions();
    const follow = launchAndFollow(options);
    await delegated.promise;
    sigintHandler?.();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGINT');
    sigintHandler?.();
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    handoff.resolve(recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-exit', exitCode: 75 } }));
    await expect(follow).resolves.toBe(75);
    expect(output.join('')).not.toContain('Run coral-cli wait jobs');
  });

  it('answers a Ctrl+C before admission at once, without waiting for the coordinator to be ensured', async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      output.push(chunk.toString());
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    const ensuring = createDeferred<void>();
    mockState.ensure.mockImplementation(() => {
      ensuring.resolve();
      return new Promise(() => {});
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const options = makeOptions();
    const follow = launchAndFollow(options);
    await ensuring.promise;
    sigintHandler?.();
    await expect(follow).resolves.toBe(75);
    expect(output.join('')).toContain('Run coral-cli wait jobs job-1 to continue waiting.');
    expect(options.emitError).not.toHaveBeenCalled();
  });
});
