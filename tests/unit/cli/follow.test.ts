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
    const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'jobs', 'wait', 'live-job']);
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
    expect(out()).toContain(`Still waiting on 1 job. Run coral-cli jobs wait live-job --cursor ${cursor}`);
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
      const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'jobs', 'wait', 'ghost']);
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
        launchResult: { kind: 'provider-session', launchState: 'running', jobId: 'job-1', requestedSeq: 1, epochKey: 'epoch' },
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
        launchResult: { kind: 'workflow', launchState: 'running', jobId: 'job-w', workflowId: 'job-w', requestedSeq: 1, epochKey: 'epoch' },
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

  it('an unbounded wait reconnects past the server cut silently and ends at the first terminal, keeping --unbounded', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    const requests: { jobIds: readonly string[]; cursor?: string; timeoutSeconds: number; drainProgress: boolean }[] =
      [];
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['a', 'b'] },
      reconnectPolicy: 'unbounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async ({ jobIds, cursor: requestCursor, timeoutSeconds, drainProgress }) => {
        requests.push({ jobIds, cursor: requestCursor, timeoutSeconds, drainProgress });
        const events =
          requests.length === 1
            ? [
                { type: 'progress', jobId: 'a', seq: 7, message: 'line', timing },
                {
                  type: 'waiting',
                  waitingJobIds: ['a', 'b'],
                  cursor: savedCursor(7),
                  exitCode: 75,
                  endedBy: 'deadline',
                },
              ]
            : [
                {
                  type: 'terminal',
                  jobId: 'a',
                  seq: 9,
                  remainingJobIds: ['b'],
                  result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
                  availability: { kind: 'available', resultPath: '/r.md' },
                  resultPath: '/r.md',
                  epochKey: 'epoch',
                  cursor: savedCursor(9),
                  exitCode: 75,
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
    expect(code).toBe(75);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ jobIds: ['a', 'b'], cursor: savedCursor(7) });
    for (const request of requests) {
      expect(request.drainProgress).toBe(false);
      expect(request.timeoutSeconds).toBeGreaterThanOrEqual(1);
      expect(request.timeoutSeconds).toBeLessThanOrEqual(1200);
    }
    expect(out).not.toContain('Still waiting');
    expect(out).not.toContain('ERR');
    expect(out).toContain('Job a completed');
    expect(out).toContain(
      `Run coral-cli jobs wait b --unbounded --cursor ${savedCursor(9)} in a background shell to continue waiting.`,
    );
  });

  it.each([
    ['settles a refusal', { exitCode: 1, endedBy: 'deadline' }, [], 1],
    ['comes from a coordinator that names no reason', { exitCode: 75 }, [], 75],
    ['is unanswered', { exitCode: 75, endedBy: 'unanswered' }, [], 75],
    ['reports an unconfirmed carrier', { exitCode: 75, endedBy: 'deadline', carrierUnknownJobIds: ['b'] }, [], 75],
    [
      'follows an absent carrier',
      { exitCode: 75, endedBy: 'progress-budget' },
      [
        {
          type: 'interrupted',
          jobId: 'b',
          storedPhase: 'running',
          observedMaxJournalSeq: 3,
          remainingJobIds: ['b'],
          observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
          continuity: 'unavailable',
          outcome: 'unknown',
        },
      ],
      75,
    ],
    ['names no cursor to resume from', { exitCode: 75, endedBy: 'deadline', cursor: null }, [], 75],
    ['leaves the cursor where it opened', { exitCode: 75, endedBy: 'progress-budget' }, [], 75, savedCursor(7)],
  ])('an unbounded wait ends as a bounded wait on a cut that %s', async (_case, cut, before, expected, opened?) => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    let connects = 0;
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['a', 'b'], ...(opened === undefined ? {} : { serializedCursor: opened }) },
      reconnectPolicy: 'unbounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async () => {
        connects += 1;
        // A wrongful resume must end here, or it reconnects forever and the case hangs instead of failing.
        const events =
          connects === 1
            ? [...before, { type: 'waiting', waitingJobIds: ['b'], cursor: savedCursor(7), ...cut }]
            : [
                {
                  type: 'terminal',
                  jobId: 'b',
                  seq: 9,
                  remainingJobIds: [],
                  result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
                  availability: { kind: 'available', resultPath: '/r.md' },
                  resultPath: '/r.md',
                  epochKey: 'epoch',
                  cursor: savedCursor(9),
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
    expect(connects).toBe(1);
    expect(code).toBe(expected);
    const cursorFlag = 'cursor' in cut ? '' : ` --cursor ${savedCursor(7)}`;
    expect(out).toContain(
      `Run coral-cli jobs wait b --unbounded${cursorFlag} in a background shell to continue waiting.`,
    );
  });

  it('an interrupted unbounded wait prints a --unbounded continuation and exits 75', async () => {
    let sigint: (() => void) | undefined;
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT') sigint = listener;
      return process;
    }) as typeof process.on);
    vi.spyOn(process, 'off').mockImplementation((() => process) as typeof process.off);
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    const opened = createDeferred();
    const code = followJobs({
      start: { kind: 'jobs', jobIds: ['a'] },
      reconnectPolicy: 'unbounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async ({ signal }) => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            opened.resolve();
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          },
        },
      }),
    });
    await opened.promise;
    expect(sigint).toBeDefined();
    sigint?.();
    expect(await code).toBe(75);
    expect(out).toContain(
      'Still waiting on 1 job. Run coral-cli jobs wait a --unbounded in a background shell to continue waiting.',
    );
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
        launchResult: { kind: 'provider-session', launchState: 'running', jobId: 'job-1', requestedSeq: 1, epochKey: 'epoch' },
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
    const continuation = 'Still waiting on 1 job. Run coral-cli jobs wait job-1 to continue waiting.';
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
    expect(emitError.mock.calls[0][0].message).toContain(`coral-cli jobs wait a --cursor ${cursor}`);
  } finally {
    vi.restoreAllMocks();
  }
});
