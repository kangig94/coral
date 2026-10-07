import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { createDeferred } from '#tools/testing/deferred.js';

import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { BackendUnreachableError } from '#src/infra/http-errors.js';

{
  const invocations: WaitInvocation[] = [];
  afterEach(() => {
    for (const invocation of invocations.splice(0)) invocation.dispose(true);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  function capture(): () => string {
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      cb?: (e?: Error | null) => void,
    ) => {
      stdout += chunk.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    return () => stdout;
  }
  const cursor = savedCursor(7);
  it('preserves the input cursor for an admitted silent job', async () => {
    const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'live-job']);
    invocations.push(budget);
    const out = capture();
    let opened!: () => void;
    const subscribed = new Promise<void>((resolve) => (opened = resolve));
    const result = followJobs({
      start: { kind: 'jobs', jobIds: ['live-job'], serializedCursor: cursor },
      reconnectPolicy: 'bounded',
      invocation: budget,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect: async ({ signal }) => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            opened();
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          },
        },
      }),
    });
    await subscribed;
    budget.stop();
    await result;
    expect(out()).not.toContain('admission did not complete');
    expect(out()).toContain(`Still waiting on 1 job. Run coral-cli wait jobs live-job --cursor ${cursor}`);
    expect(out()).toContain(`(cursor: ${cursor})`);
  });
  it('places the server deadline strictly inside the CLI budget', async () => {
    let timeout = 0;
    await followJobs({
      start: { kind: 'jobs', jobIds: ['live-job'] },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect: async ({ timeoutSeconds }) => {
        timeout = timeoutSeconds!;
        return { kind: 'fatal-error', error: new Error('refused') };
      },
    });
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(590);
  });
}
{
  const invocations: WaitInvocation[] = [];
  afterEach(() => {
    for (const invocation of invocations.splice(0)) invocation.dispose(true);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  describe('all-refused bounded wait', () => {
    it('prints a settled line without a cursor when its only job is missing', async () => {
      const runtime = new SimulationRuntime();
      const index = new JobLocationIndex(runtime, '/coral');
      const addressing = new JobAddressing(
        index.readOnlyView(),
        {
          visitProgress: progressVisitFromDetails(() => null),
          epochKey: () => 'epoch',
          detail: () => null,
          abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        },
        () => false,
        () => 'pending',
        undefined,
        () => ({ kind: 'failed', reason: 'the retained terminal does not match its source journal' }),
      );
      const events: unknown[] = [];
      for await (const event of addressing.waitStream({ jobIds: ['ghost'], timeoutSeconds: 5 })) events.push(event);
      let stdout = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cb?: (e?: Error | null) => void,
      ) => {
        stdout += chunk.toString();
        cb?.();
        return true;
      }) as typeof process.stdout.write);
      const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'ghost']);
      invocations.push(budget);
      const code = await followJobs({
        start: { kind: 'jobs', jobIds: ['ghost'] },
        reconnectPolicy: 'bounded',
        invocation: budget,
        projectRoot: '/project',
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        emitError: (e) => {
          stdout += `ERROR ${String(e)}\n`;
        },
        connect: async () => ({
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e;
            },
          },
        }),
      });
      vi.restoreAllMocks();
      expect(code).toBe(1);
      expect(stdout).toContain('Wait complete; no jobs remain.');
      expect(stdout).not.toContain('cursor:');
      expect(stdout).not.toContain('Still waiting');
    });
  });
}

{
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  const timing = {
    origin: 'runtime',
    originAt: '2026-10-04T00:00:00.000Z',
    emittedAt: '2026-10-04T00:00:01.000Z',
    elapsedMs: 1000,
  };
  const cursor = (positioned: boolean) => (positioned ? savedCursor(7) : null);

  it('launch-and-follow (until-terminal) keeps following across a waiting event', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    let connects = 0;
    const code = await followJobs({
      start: {
        kind: 'launch',
        launchResult: { kind: 'accepted', jobId: 'job-1', sessionId: 's', provider: 'codex' } as never,
      },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async () => {
        connects += 1;
        const events =
          connects === 1
            ? [
                {
                  type: 'progress',
                  jobId: 'job-1',
                  seq: 7,
                  message: 'line',
                  timing,
                },
                // what readWaitSession sends at its deadline or once the 500-line/64 KiB progress budget is spent
                { type: 'waiting', waitingJobIds: ['job-1'], cursor: cursor(true), exitCode: 75 },
              ]
            : [
                {
                  type: 'terminal',
                  jobId: 'job-1',
                  seq: 9,
                  remainingJobIds: [],
                  result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
                  availability: { kind: 'available', resultPath: '/r.md' },
                  resultPath: '/r.md',
                  epochKey: 'epoch',
                  cursor: cursor(false),
                  exitCode: 0,
                },
              ];
        return {
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e as never;
            },
          },
        };
      },
    });
    expect(out).toContain('Job job-1 completed');
    expect(connects).toBe(2);
    expect(code).toBe(0);
  });

  it('launch-and-follow of a refused job exits with the refusal, never as success', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    const code = await followJobs({
      start: {
        kind: 'launch',
        launchResult: { kind: 'accepted', jobId: 'job-w', sessionId: 's', provider: 'codex' } as never,
      },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async ({ jobIds, cursor, drainProgress, timeoutSeconds }) => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            // The reader's own events for this admission, as the coordinator streams them.
            for await (const event of readWaitSession({
              request: {
                jobIds: [...jobIds],
                ...(cursor === undefined ? {} : { cursor }),
                drainProgress,
                timeoutSeconds,
              },
              activeEpochKey: 'epoch',
              time: new VirtualTime(),
              read: () => [{ jobId: 'job-w', disposition: 'missing', message: 'refused' }],
              visit: () => ({ kind: 'unreadable', disposition: 'transient-unknown' }),
            }))
              yield JSON.parse(JSON.stringify(event)) as unknown;
          },
        },
      }),
    });
    expect(out).toContain('Job job-w: missing');
    expect(code).toBe(1);
  });
}

it('leaves a stop that is still in progress on a second SIGINT with exit 75, its continuation printed once first', async () => {
  let sigint: (() => void) | undefined;
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGINT') sigint = listener;
    return process;
  }) as typeof process.on);
  vi.spyOn(process, 'off').mockImplementation((() => process) as typeof process.off);
  let out = '';
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    out += '<exit>';
  }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, cb?: () => void) => {
    out += chunk.toString();
    cb?.();
    return true;
  }) as typeof process.stdout.write);
  const connecting = createDeferred();
  const stop = createDeferred<never>();
  const emitError = vi.fn();
  try {
    const code = followJobs({
      start: {
        kind: 'launch',
        launchResult: { kind: 'provider-session', launchState: 'running', jobId: 'job-1', sessionId: 's' },
      },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect: () => {
        connecting.resolve();
        return stop.promise;
      },
    });
    await connecting.promise;
    sigint?.();
    expect(exit).not.toHaveBeenCalled();
    sigint?.();
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    stop.reject(new Error('the stop ignored its signal'));
    expect(await code).toBe(75);
    expect(emitError).not.toHaveBeenCalled();
    const continuation = 'Still waiting on 1 job. Run coral-cli wait jobs job-1 to continue waiting.';
    expect(out.split(continuation)).toHaveLength(2);
    expect(out.indexOf(continuation)).toBeLessThan(out.indexOf('<exit>'));
  } finally {
    vi.restoreAllMocks();
  }
});

it('preserves the saved cursor in backend-unreachable remediation', async () => {
  const cursor = savedCursor(42);
  const emitError = vi.fn();
  vi.spyOn(process.stdout, 'write').mockImplementation(((_c: unknown, cb?: () => void) => {
    cb?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    await followJobs({
      start: { kind: 'jobs', jobIds: ['a'], serializedCursor: cursor },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect: async () => ({ kind: 'fatal-error', error: new BackendUnreachableError('unreachable') }),
    });
    expect(emitError.mock.calls[0][0].message).toContain(`coral-cli wait jobs a --cursor ${cursor}`);
  } finally {
    vi.restoreAllMocks();
  }
});
