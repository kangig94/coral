import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { createRealTimePort } from '#src/infra/time.js';
import { jobsWaitRequest, jobWaitSchema } from '#src/transport/rpc/jobs.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import { type WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type * as FollowMod from '#src/cli/follow.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-routing/runner.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  runHandoff: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

type FollowModule = typeof FollowMod;

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

function makeBackend(instanceId = 'backend-1') {
  return {
    socketPath: '/tmp/coordinator.sock',
    instanceId,
    bundleHash: 'test-hash',
    flavor: 'prod' as const,
    namespace: 'test-namespace',
    host: '127.0.0.1',
    port: 4100,
    token: 'backend-token',
    version: '0.5.2',
    request: vi.fn(),
    subscribe: mockState.subscribe,
    health: vi.fn(),
    shutdown: vi.fn(),
  };
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

type TestLaunchAndFollowOptions = {
  launchResult: AcceptedLaunchResponse;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
  backoffScheduler?: (delayMs: number) => Promise<void>;
};

function makeOptions(overrides: Partial<TestLaunchAndFollowOptions> = {}): TestLaunchAndFollowOptions {
  return {
    launchResult: {
      kind: 'provider-session',
      launchState: 'running',
      jobId: 'job-1',
      sessionId: 'session-1',
    } satisfies AcceptedLaunchResponse,
    pluginRoot: '/plugin/root',
    projectRoot: '/project/root',
    emitError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(message + '\n');
      process.exitCode = 70;
    },
    isTTY: false,
    columns: 80,
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
  let stderr = '';
  let sigintHandler: (() => void) | null = null;

  beforeEach(() => {
    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');
    stdout = '';
    stderr = '';
    sigintHandler = null;
    process.exitCode = undefined;
    mockState.ensure.mockReset();
    mockState.runHandoff.mockReset().mockResolvedValue({
      kind: 'recorded',
      continuation: { kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } },
      publicationIncidents: [],
    });
    mockState.subscribe.mockReset();

    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      stdout += toText(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += toText(chunk);
      return true;
    }) as typeof process.stderr.write);

    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT') {
        sigintHandler = listener as () => void;
      }
      return process;
    }) as typeof process.on);

    vi.spyOn(process, 'off').mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && sigintHandler === listener) {
        sigintHandler = null;
      }
      return process;
    }) as typeof process.off);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
      .mockResolvedValueOnce({ kind: 'subscription', subscription: handedOver })
      .mockResolvedValueOnce({
        kind: 'subscription',
        subscription: makeSubscription(async function* () {
          yield terminalEvent;
        }),
      });

    const exitCode = await followJobs({
      start: { kind: 'jobs', jobIds: ['job-1'] },
      reconnectPolicy: 'bounded',
      projectRoot: '/project/root',
      emitError,
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      connect,
      backoffScheduler,
    });

    expect(exitCode).toBe(0);
    expect(emitError).not.toHaveBeenCalled();
    expect(backoffScheduler).not.toHaveBeenCalled();
    expect(handedOver.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[0]).toMatchObject({ jobIds: ['job-1'], cursor: savedCursor(1) });
  });

  it('returns the emitted envelope exit code on non-transient stream failures without retrying', async () => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        throw new Error('fatal wait failure');
      }),
    );

    await expect(launchAndFollow(makeOptions())).resolves.toBe(70);

    expect(stdout).toBe('Provider job job-1 launch accepted (provider session session-1)\n');
    expect(stderr).toBe('fatal wait failure\n');
    expect(process.exitCode).toBe(70);
    expect(mockState.ensure).toHaveBeenCalledTimes(1);
    expect(mockState.subscribe).toHaveBeenCalledTimes(1);
  });
});

it('launch-and-follow returns a failed terminal code and offers a continuation for its pending artifact', async () => {
  const a = admitted('a', [], true, 'active-epoch', true);
  const owner = new JobAddressing(
    { time: createRealTimePort(), read: () => null, resultPathFor: () => '/r.md', unknownLocationHolds: () => [] },
    {
      visitProgress: progressVisitFromDetails(() => a.detail),
      epochKey: () => 'active-epoch',
      detail: () => a.detail,
      abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
    },
    () => false,
    () => 'decided',
    undefined,
    () => ({ kind: 'pending' }),
  );
  let stdout = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: () => void,
  ) => {
    stdout += toText(chunk);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    const { followJobs } = await loadFollowModule();
    const code = await followJobs({
      start: {
        kind: 'launch',
        launchResult: { kind: 'provider-session', jobId: 'a', sessionId: 's', launchState: 'running' },
      },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/tmp',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (error) => {
        throw error;
      },
      connect: async ({ jobIds, cursor, signal, drainProgress }) => {
        const { cursor: wireCursor, ...fields } = jobWaitSchema.parse(
          jobsWaitRequest({ jobIds, projectRoot: '/tmp', timeoutSeconds: 1, cursor, drainProgress }),
        );
        const stream = owner.waitStream({
          ...fields,
          ...(typeof wireCursor === 'string' ? { cursor: wireCursor } : {}),
          abortSignal: signal,
        });
        return {
          kind: 'subscription',
          subscription: {
            close: async () => {
              await stream.return(undefined);
            },
            [Symbol.asyncIterator]: () => stream,
          },
        };
      },
    });
    // Following a launch exits with the outcome; a pending artifact is offered as a continuation, not awaited.
    expect(code).toBe(42);
    expect(stdout).toContain('Run coral-cli wait jobs a --cursor ');
  } finally {
    write.mockRestore();
  }
});
