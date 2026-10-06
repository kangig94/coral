import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FollowModule from '#src/cli/follow.js';
import type * as HandoffNoticeModule from '#src/cli/handoff-notice.js';
import type * as HandoffRunnerModule from '#src/coordinator/handoff-routing/runner.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import { type WaitStreamEvent } from '#src/jobs/wait/contract.js';
import { serializeWaitCursor, waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { createDeferred } from '#tools/testing/deferred.js';

const entry = (seq: number) => ({
  hash: waitJobHash('job-1'),
  epoch: waitEpochToken('epoch-E'),
  seq,
  lineOffset: 0,
  flags: 0,
});
const frame: WaitStreamEvent = { type: 'cursor', cursor: { jobs: [entry(3)] } };

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
      entry: entry(4),
    };
    const waitingEvent: WaitStreamEvent = {
      type: 'waiting',
      waitingJobIds: ['job-1'],
      cursor: { jobs: [entry(4)] },
      exitCode: 75,
    };
    const subscribe = vi.fn().mockResolvedValue(makeSubscription([frame, progressEvent, waitingEvent]));

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
          kind: 'follow-job',
          jobId: 'job-1',
          serializedCursor: serializeWaitCursor({ jobs: [entry(4)] }),
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

  it('reports a buffered stdout failure during handoff with the original command', async () => {
    const secondRunStarted = createDeferred<void>();
    const handoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    let failWrite!: (error: Error) => void;
    const subscribe = vi.fn().mockResolvedValue(
      makeSubscription([
        frame,
        {
          type: 'progress',
          jobId: 'job-1',
          seq: 4,
          message: 'buffered-progress',
          timing: waitTiming,
          entry: entry(4),
        },
        { type: 'waiting', waitingJobIds: ['job-1'], cursor: { jobs: [entry(4)] }, exitCode: 75 },
      ]),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      if (chunk.toString().includes('buffered-progress')) failWrite = (error) => callback?.(error);
      else callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValueOnce(makeBackend(subscribe)).mockResolvedValueOnce(makeBackend());
    mockState.runHandoff
      .mockResolvedValueOnce(
        recorded({ kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } }),
      )
      .mockImplementationOnce(() => {
        secondRunStarted.resolve();
        return handoff.promise;
      });
    const options = makeOptions();
    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(options);
    await secondRunStarted.promise;
    failWrite(new Error('stdout unavailable'));
    handoff.resolve(
      recorded({
        kind: 'delegated',
        version: '2.0.0',
        outcome: { kind: 'handoff-success', version: '2.0.0' } as HandoffRunnerModule.HandoffOutcome,
      }),
    );
    await expect(follow).resolves.toBe(75);
    expect(options.emitError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'transient',
        remediation: 'Run coral-cli wait jobs job-1',
      }),
    );
  });

  it('should resume a transient retry from the folded cursor so no line repeats', async () => {
    const output: string[] = [];
    const progressEvent: WaitStreamEvent = {
      type: 'progress',
      jobId: 'job-1',
      seq: 4,
      message: 'checkpoint-one',
      timing: waitTiming,
      entry: entry(4),
    };
    const terminalEvent: WaitStreamEvent = {
      type: 'terminal',
      jobId: 'job-1',
      seq: 5,
      remainingJobIds: [],
      resultPath: '/tmp/result.md',
      availability: { kind: 'available', resultPath: '/tmp/result.md' },
      result: { content: 'done', durationMs: 1_000, outcome: { kind: 'completed' } },
      cursor: { jobs: [] },
      exitCode: 0,
    };
    const firstSubscribe = vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      async *[Symbol.asyncIterator]() {
        yield frame;
        yield progressEvent;
        throw new TypeError('terminated');
      },
    });
    const secondSubscribe = vi.fn().mockImplementation(async (_method: string, params: Record<string, unknown>) => {
      expect(params.cursor).toEqual({ jobs: [entry(4)] });
      return makeSubscription([{ type: 'cursor', cursor: { jobs: [entry(4)] } }, terminalEvent]);
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

  it.each(['aborted', 'stopRequested'] as const)(
    'preserves double Ctrl-C %s evidence while delegated waits are active',
    async (outcome) => {
      const firstHandoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
      const secondHandoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
      const firstRunStarted = createDeferred<void>();
      const secondRunStarted = createDeferred<void>();
      const abortJob = vi.fn().mockResolvedValue({
        aborted: outcome === 'aborted' ? ['job-1'] : [],
        ...(outcome === 'stopRequested'
          ? {
              stopRequested: ['job-1'],
              held: [{ jobId: 'job-2', reason: 'provider_stop_pending', nextStep: 'Waiting for terminal evidence.' }],
            }
          : {}),
        notFound: [],
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        _chunk: string | Uint8Array,
        callback?: (error?: Error | null) => void,
      ) => {
        callback?.();
        return true;
      }) as typeof process.stdout.write);
      mockState.ensure.mockResolvedValue(makeBackend());
      mockState.runHandoff
        .mockImplementationOnce(async () => {
          firstRunStarted.resolve();
          return firstHandoff.promise;
        })
        .mockImplementationOnce(async () => {
          secondRunStarted.resolve();
          return secondHandoff.promise;
        });

      const { launchAndFollow } = await import('#src/cli/follow.js');
      const follow = launchAndFollow(makeOptions({ abortJob }));
      await firstRunStarted.promise;

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
      await expect(follow).resolves.toBe(outcome === 'aborted' ? 1 : 3);

      expect(abortJob).toHaveBeenCalledOnce();
      expect(abortJob).toHaveBeenCalledWith('job-1');
      expect(process.stderr.write).toHaveBeenCalledWith('\nPress Ctrl+C again to abort the job.\n');
      if (outcome === 'stopRequested') {
        expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('Stop requested for jobs: job-1'));
      }
    },
  );

  it('reports stop-requested evidence when a double Ctrl+C ends a locally folded follow', async () => {
    const output: string[] = [];
    const progressApplied = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue({
      aborted: ['job-1'],
      stopRequested: ['job-1'],
      stopDiagnostics: [{ jobId: 'job-1', lastError: 'provider_unreachable: control socket closed' }],
      notFound: [],
      held: [{ jobId: 'job-2', reason: 'provider_stop_pending', nextStep: 'Waiting for terminal evidence.' }],
    });
    const subscribe = vi
      .fn()
      .mockImplementation(async (_method: string, _params: unknown, options: { signal: AbortSignal }) => ({
        close: vi.fn().mockResolvedValue(undefined),
        async *[Symbol.asyncIterator]() {
          yield frame;
          yield {
            type: 'progress',
            jobId: 'job-1',
            seq: 4,
            message: 'checkpoint-one',
            timing: waitTiming,
            entry: entry(4),
          } satisfies WaitStreamEvent;
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
    const follow = launchAndFollow(makeOptions({ abortJob }));
    await progressApplied.promise;
    sigintHandler?.();
    sigintHandler?.();

    await expect(follow).resolves.toBe(3);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(abortJob).toHaveBeenCalledExactlyOnceWith('job-1');
    const text = output.join('');
    expect(text.match(/checkpoint-one/g)).toHaveLength(1);
    expect(text).toContain('Stop requested for jobs: job-1');
    expect(text).toContain('Stop diagnostic for job-1: provider_unreachable: control socket closed');
    expect(text).not.toContain('Aborted jobs: job-1');
  });

  it('mirrors a delegated follow ending 75 after a Ctrl+C without retrying, since a terminal may carry 75', async () => {
    const handoff = createDeferred<HandoffRunnerModule.HandoffRunResult>();
    const runStarted = createDeferred<void>();
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.runHandoff.mockImplementationOnce(async () => {
      runStarted.resolve();
      return handoff.promise;
    });

    const { launchAndFollow } = await import('#src/cli/follow.js');
    const follow = launchAndFollow(makeOptions());
    await runStarted.promise;
    expect(mockState.runHandoff.mock.calls[0][0]).toEqual({ kind: 'follow-job', jobId: 'job-1' });

    sigintHandler?.();
    handoff.resolve(recorded({ kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-exit', exitCode: 75 } }));
    await expect(follow).resolves.toBe(75);
    expect(mockState.runHandoff).toHaveBeenCalledTimes(1);
  });
});
