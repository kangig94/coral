import { currentCoralStoreFormat } from '#src/store-format.js';
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
    const budget = new WaitInvocation('stream', ['node', 'coral-cli', 'jobs', 'wait', 'live-job']);
    invocations.push(budget);
    const out = capture();
    let opened!: () => void;
    const subscribed = new Promise<void>((resolve) => (opened = resolve));
    const result = followJobs({
      jobIds: ['live-job'],
      serializedCursor: cursor,
      invocation: budget,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect: async ({ signal }) => ({
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          opened();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
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
}
{
  const invocations: WaitInvocation[] = [];
  afterEach(() => {
    for (const invocation of invocations.splice(0)) invocation.dispose(true);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  describe('all-refused wait', () => {
    it('prints a settled line without a cursor when its only job is missing', async () => {
      const runtime = new SimulationRuntime();
      const index = new JobLocationIndex(runtime, '/coral', undefined, currentCoralStoreFormat().fingerprint);
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
      const budget = new WaitInvocation('stream', ['node', 'coral-cli', 'jobs', 'wait', 'ghost']);
      invocations.push(budget);
      const code = await followJobs({
        jobIds: ['ghost'],
        invocation: budget,
        projectRoot: '/project',
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        emitError: (e) => {
          stdout += `ERROR ${String(e)}\n`;
        },
        connect: async () => ({
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
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
  it('a wait on a refused job exits with the refusal', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    const code = await followJobs({
      jobIds: ['job-w'],
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: (e) => {
        out += `ERR ${String(e)}\n`;
      },
      connect: async ({ jobIds, cursor }) => ({
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          for await (const event of readWaitSession({
            request: {
              jobIds: [...jobIds],
              ...(cursor === undefined ? {} : { cursor }),
            },
            activeEpochKey: 'epoch',
            time: new VirtualTime(),
            read: () => [{ jobId: 'job-w', disposition: 'missing', message: 'refused' }],
            visit: () => ({ kind: 'unreadable', disposition: 'transient-unknown' }),
          }))
            yield JSON.parse(JSON.stringify(event)) as unknown;
        },
      }),
    });
    expect(out).toContain('Job job-w: missing');
    expect(code).toBe(1);
  });

  it.each([savedCursor(7), null])(
    'reconnects past a server deadline at cursor %s and ends at the first terminal',
    async (cursor) => {
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        c: string | Uint8Array,
        cb?: (e?: Error | null) => void,
      ) => {
        out += c.toString();
        cb?.();
        return true;
      }) as typeof process.stdout.write);
      const requests: { jobIds: readonly string[]; cursor?: string }[] = [];
      const code = await followJobs({
        jobIds: ['a', 'b'],
        projectRoot: '/project',
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        emitError: (e) => {
          out += `ERR ${String(e)}\n`;
        },
        connect: async ({ jobIds, cursor: requestCursor }) => {
          requests.push({ jobIds, cursor: requestCursor });
          const events =
            requests.length === 1
              ? [
                  { type: 'progress', jobId: 'a', seq: 7, message: 'line', timing },
                  {
                    type: 'interrupted',
                    jobId: 'a',
                    storedPhase: 'running',
                    observedMaxJournalSeq: 7,
                    remainingJobIds: ['a', 'b'],
                    observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
                    continuity: 'unavailable',
                    outcome: 'unknown',
                  },
                  {
                    type: 'waiting',
                    waitingJobIds: ['a', 'b'],
                    carrierAbsentJobIds: [],
                    cursor,
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
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              for (const e of events) yield e as never;
            },
          };
        },
      });
      expect(code).toBe(75);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ jobIds: ['a', 'b'], cursor: cursor ?? undefined });
      expect(out).not.toContain('Still waiting');
      expect(out).not.toContain('ERR');
      expect(out).toContain('Job a completed');
      expect(out).toContain(`Run coral-cli jobs wait b --cursor ${savedCursor(9)} to continue waiting.`);
    },
  );

  it.each([
    ['settles a refusal', { exitCode: 1, endedBy: 'deadline' }, [], 1],
    ['leaves a carrier unknown', { exitCode: 75, endedBy: 'deadline', carrierUnknownJobIds: ['b'] }, [], 75],
    [
      'leaves a carrier absent without a terminal',
      { exitCode: 75, endedBy: 'deadline' },
      [
        {
          type: 'interrupted',
          jobId: 'b',
          storedPhase: 'running',
          observedMaxJournalSeq: 7,
          remainingJobIds: ['b'],
          observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
          continuity: 'unavailable',
          outcome: 'unknown',
        },
      ],
      75,
    ],
    ['comes from a coordinator that names no reason', { exitCode: 75 }, [], 75],
    ['is unanswered', { exitCode: 75, endedBy: 'unanswered' }, [], 75],
    ['leaves the cursor where it opened', { exitCode: 75, endedBy: 'progress-budget' }, [], 75, savedCursor(7)],
  ])('returns a continuation on a cut that %s', async (_case, cut, before, expected, opened?) => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
      out += c.toString();
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    let connects = 0;
    const code = await followJobs({
      jobIds: ['a', 'b'],
      ...(opened === undefined ? {} : { serializedCursor: opened }),
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
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e as never;
          },
        };
      },
    });
    expect(connects).toBe(1);
    expect(code).toBe(expected);
    const cursorFlag = 'cursor' in cut ? '' : ` --cursor ${savedCursor(7)}`;
    expect(out).toContain(`Run coral-cli jobs wait b${cursorFlag} to continue waiting.`);
  });
}

it('leaves a stop that is still in progress on a second SIGINT with exit 75, its continuation printed once first', async () => {
  const invocation = new WaitInvocation('stream', ['node', 'coral-cli', 'jobs', 'wait', 'job-1']);
  const sigint = process.listeners('SIGINT').at(-1);
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
      invocation,
      jobIds: ['job-1'],
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect: () => {
        connecting.resolve();
        return stop.promise;
      },
    });
    await connecting.promise;
    sigint?.('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    sigint?.('SIGINT');
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
    stop.reject(new Error('the stop ignored its signal'));
    expect(await code).toBe(75);
    expect(emitError).not.toHaveBeenCalled();
    const continuation = 'Run coral-cli jobs wait job-1';
    expect(out.split(continuation)).toHaveLength(2);
    expect(out.indexOf(continuation)).toBeLessThan(out.indexOf('<exit>'));
  } finally {
    invocation.dispose(true);
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
      jobIds: ['a'],
      serializedCursor: cursor,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect: async () => {
        throw new BackendUnreachableError('unreachable');
      },
      backoffScheduler: async () => {},
    });
    expect(emitError.mock.calls[0][0].message).toContain(`coral-cli jobs wait a --cursor ${cursor}`);
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([false, true])('handles a terminal with siblings when waitForAll is %s', async (waitForAll) => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: () => void) => {
    output += chunk;
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  function finished(jobId: string, code: number, cursor: string, remainingJobIds: string[]) {
    return {
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'terminal',
          jobId,
          seq: Number(cursor),
          remainingJobIds,
          availability: { kind: 'available', resultPath: '/result.md' },
          resultPath: '/result.md',
          result: { content: '', outcome: { kind: 'provider_exit', code }, durationMs: 1 },
          cursor,
          exitCode: code,
        };
      },
    };
  }
  const connect = vi
    .fn()
    .mockResolvedValueOnce(finished('b', 75, '7', ['a']))
    .mockResolvedValueOnce(finished('a', 42, '9', []));
  const emitError = vi.fn();
  try {
    const code = await followJobs({
      jobIds: ['a', 'b'],
      waitForAll,
      connect,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
    });
    expect(emitError).not.toHaveBeenCalled();
    expect(output).toContain('Job b provider exited 75');
    if (waitForAll) {
      expect(connect).toHaveBeenCalledTimes(2);
      expect(connect.mock.calls[1][0]).toMatchObject({ jobIds: ['a'], cursor: '7' });
      expect(output).toContain('Job a provider exited 42');
      expect(output).not.toContain('Run coral-cli jobs wait');
      expect(code).toBe(42);
    } else {
      expect(connect).toHaveBeenCalledOnce();
      expect(output).toContain('Run coral-cli jobs wait a --cursor 7');
      expect(code).toBe(75);
    }
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  }
});
