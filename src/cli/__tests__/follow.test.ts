import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LaunchDecision, TerminalResult, WaitStreamEvent } from '../../shared/types.js';
import type * as FollowMod from '../follow.js';

const mockState = vi.hoisted(() => ({
  ensureBackend: vi.fn(),
  streamWait: vi.fn(),
}));

vi.mock('../../client/backend-lifecycle.js', () => ({
  ensureBackend: mockState.ensureBackend,
}));

vi.mock('../../bridge/backend-client.js', () => ({
  streamWait: mockState.streamWait,
}));

type FollowModule = typeof FollowMod;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function toText(chunk: string | Uint8Array): string {
  return typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
}

function makeBackend(instanceId = 'backend-1') {
  return {
    host: '127.0.0.1',
    port: 4100,
    token: 'backend-token',
    instanceId,
  };
}

function makeProgressEvent(message = 'Still running'): Extract<WaitStreamEvent, { type: 'progress' }> {
  return {
    type: 'progress',
    jobId: 'job-1',
    sessionId: 'session-1',
    eventId: 1,
    message,
  };
}

function makeQueuedEvent(): Extract<WaitStreamEvent, { type: 'queued' }> {
  return {
    type: 'queued',
    jobId: 'job-1',
    sessionId: 'session-1',
    queuePosition: 2,
    runningJobIds: ['job-9'],
  };
}

function makeTimeoutEvent(): Extract<WaitStreamEvent, { type: 'timeout' }> {
  return {
    type: 'timeout',
    runningJobIds: ['job-1'],
  };
}

function makeTerminalEvent(
  result: Partial<TerminalResult> = {},
  overrides: Partial<Extract<WaitStreamEvent, { type: 'terminal' }>> = {},
): Extract<WaitStreamEvent, { type: 'terminal' }> {
  return {
    type: 'terminal',
    completedJobId: 'job-1',
    sessionId: 'session-1',
    remainingJobIds: [],
    resultPath: '/tmp/result.md',
    result: {
      content: 'done',
      ...result,
    },
    ...overrides,
  };
}

function makeOptions(
  overrides: Partial<{
    launchResult: Extract<LaunchDecision, { status: 'running' | 'queued' }>;
    abortJob: (jobId: string) => Promise<unknown>;
    pluginRoot: string;
    projectRoot: string;
    outputFormat: 'text' | 'json';
    isTTY: boolean;
    columns: number;
  }> = {},
) {
  return {
    launchResult: {
      status: 'running',
      job: 'job-1',
      session: 'session-1',
    } satisfies Extract<LaunchDecision, { status: 'running' | 'queued' }>,
    abortJob: async () => undefined,
    pluginRoot: '/plugin/root',
    projectRoot: '/project/root',
    outputFormat: 'text' as const,
    isTTY: false,
    columns: 80,
    ...overrides,
  };
}

async function loadFollowModule(): Promise<FollowModule> {
  vi.resetModules();
  return import('../follow.js');
}

describe('cli follow', () => {
  let stdout = '';
  let stderr = '';
  let sigintHandler: (() => void) | null = null;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    sigintHandler = null;
    mockState.ensureBackend.mockReset();
    mockState.streamWait.mockReset();

    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += toText(chunk);
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes launch output and a path-first terminal summary in text mode', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const backend = makeBackend();

    mockState.ensureBackend.mockResolvedValueOnce(backend);
    mockState.streamWait.mockImplementationOnce(async function* () {
      yield makeTerminalEvent();
    });

    await expect(launchAndFollow(makeOptions())).resolves.toBe(0);

    expect(stdout).toBe(
      'Job job-1 running (session session-1)\n' +
        '[job-1] completed\n' +
        'Result path: /tmp/result.md\n' +
        'Remaining jobs: 0\n',
    );
    expect(stderr).toBe('');
    expect(mockState.ensureBackend).toHaveBeenCalledWith('/plugin/root');
    expect(mockState.streamWait).toHaveBeenCalledWith(
      ['job-1'],
      600,
      backend,
      undefined,
      expect.any(AbortSignal),
      '/project/root',
      expect.any(Object),
    );
  });

  it('emits launch, timeout, and terminal NDJSON records with cursor resume', async () => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensureBackend
      .mockResolvedValueOnce(makeBackend('backend-1'))
      .mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.streamWait
      .mockImplementationOnce(async function* (
        _jobIds: string[],
        _timeoutSeconds: number,
        _backend: unknown,
        lastEventId: string | undefined,
        _signal: AbortSignal | undefined,
        _projectRoot: string | undefined,
        cursorRef: { lastEventId?: string } | undefined,
      ) {
        expect(lastEventId).toBeUndefined();
        if (cursorRef) {
          cursorRef.lastEventId = 'cursor-queued';
        }
        yield makeQueuedEvent();
        if (cursorRef) {
          cursorRef.lastEventId = 'cursor-timeout';
        }
        yield makeTimeoutEvent();
      })
      .mockImplementationOnce(async function* (
        _jobIds: string[],
        _timeoutSeconds: number,
        _backend: unknown,
        lastEventId: string | undefined,
        _signal: AbortSignal | undefined,
        _projectRoot: string | undefined,
        cursorRef: { lastEventId?: string } | undefined,
      ) {
        expect(lastEventId).toBe('cursor-timeout');
        if (cursorRef) {
          cursorRef.lastEventId = 'cursor-progress';
        }
        yield makeProgressEvent('Halfway there');
        if (cursorRef) {
          cursorRef.lastEventId = 'cursor-terminal';
        }
        yield makeTerminalEvent({
          content: 'secret result body',
          warnings: ['be careful'],
          usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.01 },
          workflow: {
            steps: [
              {
                agent: 'architect',
                step: 1,
                atom: 1,
                provider: 'codex',
                start: 10,
                end: 20,
              },
            ],
          },
        });
      });

    await expect(
      launchAndFollow(
        makeOptions({
          launchResult: {
            status: 'queued',
            job: 'job-1',
            session: 'session-1',
          },
          outputFormat: 'json',
        }),
      ),
    ).resolves.toBe(0);

    const records = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(records).toEqual([
      {
        type: 'launch',
        jobId: 'job-1',
        sessionId: 'session-1',
        status: 'queued',
      },
      {
        type: 'queued',
        jobId: 'job-1',
        sessionId: 'session-1',
        queuePosition: 2,
        runningJobIds: ['job-9'],
      },
      {
        type: 'timeout',
        runningJobIds: ['job-1'],
      },
      {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        message: 'Halfway there',
      },
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        result: {
          path: '/tmp/result.md',
          warnings: ['be careful'],
          usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.01 },
          workflow: {
            steps: [
              {
                agent: 'architect',
                step: 1,
                atom: 1,
                provider: 'codex',
                start: 10,
                end: 20,
              },
            ],
          },
        },
      },
    ]);
    expect(records[4].result).not.toHaveProperty('content');
    expect(mockState.ensureBackend).toHaveBeenCalledTimes(2);
    expect(mockState.streamWait.mock.calls[1]?.[3]).toBe('cursor-timeout');
  });

  it('retries transient stream failures with a 1s backoff and resumes from the current cursor', async () => {
    vi.useFakeTimers();

    const { launchAndFollow } = await loadFollowModule();

    mockState.ensureBackend
      .mockResolvedValueOnce(makeBackend('backend-1'))
      .mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.streamWait
      .mockImplementationOnce(async function* (
        _jobIds: string[],
        _timeoutSeconds: number,
        _backend: unknown,
        _lastEventId: string | undefined,
        _signal: AbortSignal | undefined,
        _projectRoot: string | undefined,
        cursorRef: { lastEventId?: string } | undefined,
      ) {
        if (cursorRef) {
          cursorRef.lastEventId = 'cursor-progress';
        }
        yield makeProgressEvent('Booting');
        throw new TypeError('terminated');
      })
      .mockImplementationOnce(async function* (
        _jobIds: string[],
        _timeoutSeconds: number,
        _backend: unknown,
        lastEventId: string | undefined,
      ) {
        expect(lastEventId).toBe('cursor-progress');
        yield makeTerminalEvent({ exitCode: 7 });
      });

    const followPromise = launchAndFollow(makeOptions({ outputFormat: 'json' }));

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(followPromise).resolves.toBe(7);

    const records = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toEqual([
      {
        type: 'launch',
        jobId: 'job-1',
        sessionId: 'session-1',
        status: 'running',
      },
      {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        message: 'Booting',
      },
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        result: {
          path: '/tmp/result.md',
          exitCode: 7,
        },
      },
    ]);
    expect(stderr).toBe('');
    expect(mockState.ensureBackend).toHaveBeenCalledTimes(2);
    expect(mockState.streamWait).toHaveBeenCalledTimes(2);
  });

  it('returns 1 on non-transient stream failures without retrying', async () => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensureBackend.mockResolvedValueOnce(makeBackend());
    mockState.streamWait.mockImplementationOnce(async function* () {
      throw new Error('fatal wait failure');
    });

    await expect(launchAndFollow(makeOptions())).resolves.toBe(1);

    expect(stdout).toBe('Job job-1 running (session session-1)\n');
    expect(stderr).toBe('fatal wait failure\n');
    expect(mockState.ensureBackend).toHaveBeenCalledTimes(1);
    expect(mockState.streamWait).toHaveBeenCalledTimes(1);
  });

  it('warns on first SIGINT, aborts on second SIGINT, and calls abortJob once', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const started = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue(undefined);

    mockState.ensureBackend.mockResolvedValueOnce(makeBackend());
    mockState.streamWait.mockImplementationOnce(
      (
        _jobIds: string[],
        _timeoutSeconds: number,
        _backend: unknown,
        _lastEventId: string | undefined,
        signal: AbortSignal | undefined,
      ) =>
        (async function* () {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true });
          });
        })(),
    );

    const followPromise = launchAndFollow(makeOptions({ abortJob }));
    await started.promise;

    expect(sigintHandler).not.toBeNull();
    sigintHandler?.();
    sigintHandler?.();

    await expect(followPromise).resolves.toBe(1);

    expect(stdout).toBe('Job job-1 running (session session-1)\n');
    expect(stderr).toBe('\nPress Ctrl+C again to abort the job.\n');
    expect(abortJob).toHaveBeenCalledTimes(1);
    expect(abortJob).toHaveBeenCalledWith('job-1');
    expect(mockState.ensureBackend).toHaveBeenCalledTimes(1);
    expect(mockState.streamWait).toHaveBeenCalledTimes(1);
    expect(process.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it.each([
    [{ exitCode: null }, 1],
    [{ exitCode: 256 }, 1],
    [{ exitCode: 1.5 }, 1],
    [{ aborted: true, exitCode: 0 }, 1],
  ])('maps terminal result %j to exit code %i', async (result, expected) => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensureBackend.mockResolvedValueOnce(makeBackend());
    mockState.streamWait.mockImplementationOnce(async function* () {
      yield makeTerminalEvent(result);
    });

    await expect(launchAndFollow(makeOptions({ outputFormat: 'json' }))).resolves.toBe(expected);
  });
});
