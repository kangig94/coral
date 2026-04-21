import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcceptedLaunchResponse } from '../../client/http-client.js';
import type { WaitStreamEvent } from '../../jobs/wait.js';
import { serializeWaitCursor } from '../../jobs/wait.js';
import { createRealRuntime } from '../../runtime/real.js';
import { createDeferred } from '../../simulation/core/test-deferred.js';
import { openStoreDatabase } from '../../store/index.js';
import { ensureStoreMigrationsDir } from '../../store/migrations.js';
import { storePaths } from '../../store/paths.js';
import type * as FollowMod from '../follow.js';
import { formatLaunch, formatWaitProgress, formatWaitQueued, formatWaitTerminal, formatWaitWaiting } from '../format.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('../../transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

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

function makeProgressEvent(message = 'Still running'): Extract<WaitStreamEvent, { type: 'progress' }> {
  return {
    type: 'progress',
    jobId: 'job-1',
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

function makeRunningEvent(): Extract<WaitStreamEvent, { type: 'waiting' }> {
  return {
    type: 'waiting',
    waitingJobIds: ['job-1'],
  };
}

function makeTerminalEvent(
  result: Record<string, unknown> = {},
  overrides: Partial<Extract<WaitStreamEvent, { type: 'terminal' }>> = {},
): Extract<WaitStreamEvent, { type: 'terminal' }> {
  return {
    type: 'terminal',
    jobId: 'job-1',
    remainingJobIds: [],
    resultPath: '/tmp/result.md',
    result: {
      content: 'done',
      outcome: { kind: 'completed' },
      ...result,
    } as Extract<WaitStreamEvent, { type: 'terminal' }>['result'],
    ...overrides,
  };
}

type TestLaunchAndFollowOptions = {
  launchResult: AcceptedLaunchResponse;
  abortJob: (jobId: string) => Promise<unknown>;
  pluginRoot: string;
  projectRoot: string;
  emitError: (error: unknown) => void;
  isTTY: boolean;
  columns: number;
};

function makeOptions(
  overrides: Partial<TestLaunchAndFollowOptions> = {},
): TestLaunchAndFollowOptions {
  return {
    launchResult: {
      launchState: 'running',
      job: 'job-1',
      session: 'session-1',
    } satisfies AcceptedLaunchResponse,
    abortJob: async () => undefined,
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

function createCauseRenderFixture(): { home: string; pluginRoot: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'coral-follow-home-'));
  const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-follow-plugin-'));

  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }),
    'utf-8',
  );

  const runtime = createRealRuntime();
  const db = openStoreDatabase({
    path: storePaths('prod', { baseDir: join(home, '.coral') }).dbFile,
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });

  try {
    const insertEvent = db.prepare(
      `INSERT INTO events (
        seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body_version, body
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    );
    insertEvent.run(
      1,
      '2026-03-21T00:00:00.000Z',
      'workflow.completed',
      'workflow',
      'workflow-1',
      1,
      Buffer.from(JSON.stringify({ outcome: 'failed' }), 'utf-8'),
    );
  } finally {
    db.close();
  }

  return {
    home,
    pluginRoot,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(pluginRoot, { recursive: true, force: true });
    },
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
    process.exitCode = undefined;
    mockState.ensure.mockReset();
    mockState.subscribe.mockReset();

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
    process.exitCode = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes launch output and a path-first terminal summary in text mode', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const backend = makeBackend();
    const options = makeOptions();
    const terminalEvent = makeTerminalEvent();
    const terminalCursor = serializeWaitCursor({ jobs: {} });

    mockState.ensure.mockResolvedValueOnce(backend);
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        yield terminalEvent;
      }),
    );

    await expect(launchAndFollow(options)).resolves.toBe(0);

    expect(stdout).toBe(
      `${formatLaunch(options.launchResult)}\n${formatWaitTerminal(terminalEvent, terminalCursor, false)}\n`,
    );
    expect(stderr).toBe('');
    expect(mockState.ensure).toHaveBeenCalledWith('/plugin/root');
    expect(mockState.subscribe).toHaveBeenCalledWith(
      'jobs.wait',
      {
        jobIds: ['job-1'],
        timeoutSeconds: 600,
        projectRoot: '/project/root',
      },
      {
        timeoutMs: 3_000,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('emits launch, queued, progress, waiting, and terminal text output with cursor resume', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const launchResult = {
      launchState: 'queued',
      job: 'job-1',
      session: 'session-1',
    } satisfies AcceptedLaunchResponse;
    const queuedEvent = makeQueuedEvent();
    const progressEvent = makeProgressEvent('Halfway there');
    const waitingEvent = makeRunningEvent();
    const terminalEvent = makeTerminalEvent({
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
    const cursorAfterProgress = serializeWaitCursor({ jobs: { 'job-1': 1 } });

    mockState.ensure
      .mockResolvedValueOnce(makeBackend('backend-1'))
      .mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.subscribe
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toBeUndefined();
        return makeSubscription(async function* () {
          yield queuedEvent;
          yield progressEvent;
          yield waitingEvent;
        });
      })
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toEqual({ jobs: { 'job-1': 1 } });
        return makeSubscription(async function* () {
          yield terminalEvent;
        });
      });

    await expect(launchAndFollow(makeOptions({ launchResult }))).resolves.toBe(0);

    expect(stdout).toBe(
      `${formatLaunch(launchResult)}\n` +
        `${formatWaitQueued(queuedEvent)}\n` +
        `${formatWaitProgress(progressEvent)}\n` +
        `${formatWaitWaiting(waitingEvent, cursorAfterProgress)}\n` +
        `${formatWaitTerminal(terminalEvent, cursorAfterProgress, false)}\n`,
    );
    expect(mockState.ensure).toHaveBeenCalledTimes(2);
  });

  it('retries transient stream failures with a 1s backoff and resumes from the current cursor', async () => {
    vi.useFakeTimers();

    const { launchAndFollow } = await loadFollowModule();
    const options = makeOptions();
    const progressEvent = makeProgressEvent('Booting');
    const cursorAfterProgress = serializeWaitCursor({ jobs: { 'job-1': 1 } });

    mockState.ensure
      .mockResolvedValueOnce(makeBackend('backend-1'))
      .mockResolvedValueOnce(makeBackend('backend-2'));
    mockState.subscribe
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toBeUndefined();
        return makeSubscription(async function* () {
          yield progressEvent;
          throw new TypeError('terminated');
        });
      })
      .mockImplementationOnce(async (_method: string, params: Record<string, unknown>) => {
        expect(params.cursor).toEqual({ jobs: { 'job-1': 1 } });
        return makeSubscription(async function* () {
          yield makeTerminalEvent({ exitCode: 7 });
        });
      });

    const followPromise = launchAndFollow(options);

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(followPromise).resolves.toBe(7);

    expect(stdout).toBe(
      `${formatLaunch(options.launchResult)}\n` +
        `${formatWaitProgress(progressEvent)}\n` +
        `${formatWaitTerminal(makeTerminalEvent({ exitCode: 7 }), cursorAfterProgress, false)}\n`,
    );
    expect(stderr).toBe('');
    expect(mockState.ensure).toHaveBeenCalledTimes(2);
    expect(mockState.subscribe).toHaveBeenCalledTimes(2);
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

    expect(stdout).toBe('Job job-1 running (session session-1)\n');
    expect(stderr).toBe('fatal wait failure\n');
    expect(process.exitCode).toBe(70);
    expect(mockState.ensure).toHaveBeenCalledTimes(1);
    expect(mockState.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying BackendUnreachableError until the retry budget is exhausted and emits the envelope on stderr only', async () => {
    vi.useFakeTimers();

    const { launchAndFollow } = await loadFollowModule();
    const { BackendUnreachableError } = await import('../../shared/utils.js');

    mockState.ensure.mockResolvedValue(makeBackend());
    mockState.subscribe
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'))
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'))
      .mockRejectedValueOnce(new BackendUnreachableError('fetch failed'));

    const options = makeOptions({
      emitError: (error: unknown) => {
        expect(error).toBeInstanceOf(BackendUnreachableError);
        process.stderr.write('fetch failed [code=backend_unreachable]\n');
        process.exitCode = 69;
      },
    });
    const followPromise = launchAndFollow(options);

    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await expect(followPromise).resolves.toBe(69);

    expect(stdout).toBe(`${formatLaunch(options.launchResult)}\n`);
    expect(stderr).toBe('fetch failed [code=backend_unreachable]\n');
    expect(mockState.ensure).toHaveBeenCalledTimes(3);
    expect(mockState.subscribe).toHaveBeenCalledTimes(3);
  });

  it('warns on first SIGINT, aborts on second SIGINT, and calls abortJob once', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const started = createDeferred<void>();
    const abortJob = vi.fn().mockResolvedValue(undefined);

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockImplementationOnce(async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
      makeSubscription(
        async function* () {
          started.resolve();
          await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new TypeError('terminated')), { once: true });
          });
        },
      ),
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
    expect(mockState.ensure).toHaveBeenCalledTimes(1);
    expect(mockState.subscribe).toHaveBeenCalledTimes(1);
    expect(process.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });

  it.each([
    [{ exitCode: null }, 1],
    [{ exitCode: 256 }, 1],
    [{ exitCode: 1.5 }, 1],
    [{ outcome: { kind: 'aborted' as const, reason: 'signal_abort' as const }, exitCode: 0 }, 1],
  ])('maps terminal result %j to exit code %i', async (result, expected) => {
    const { launchAndFollow } = await loadFollowModule();

    mockState.ensure.mockResolvedValueOnce(makeBackend());
    mockState.subscribe.mockResolvedValueOnce(
      makeSubscription(async function* () {
        yield makeTerminalEvent(result);
      }),
    );

    await expect(launchAndFollow(makeOptions())).resolves.toBe(expected);
  });

  it('renders local cause chains from the store for failed terminal outcomes', async () => {
    const { launchAndFollow } = await loadFollowModule();
    const fixture = createCauseRenderFixture();
    const originalHome = process.env.HOME;
    const originalTmpdir = process.env.TMPDIR;

    try {
      process.env.HOME = fixture.home;
      process.env.TMPDIR = fixture.home;

      mockState.ensure.mockResolvedValueOnce(makeBackend());
      mockState.subscribe.mockResolvedValueOnce(
        makeSubscription(async function* () {
          yield makeTerminalEvent({
            content: '',
            outcome: {
              kind: 'failed',
              causeRef: {
                stream: { kind: 'workflow', id: 'workflow-1' },
                seq: 1,
              },
            },
          });
        }),
      );

      await expect(launchAndFollow(makeOptions({ pluginRoot: fixture.pluginRoot }))).resolves.toBe(1);

      expect(stdout).toContain('Job job-1 failed: Failed: Workflow failed.');
      expect(stdout).not.toContain('workflow/workflow-1#1');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }

      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }

      fixture.cleanup();
    }
  });
});
