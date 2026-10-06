import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { savedCursor } from '#tests/helpers/wait-session.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { waitJobHash, serializeWaitCursor } from '#src/jobs/wait/cursor.js';

import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

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
  function run(events: unknown[], fresh = false) {
    const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'live-job']);
    invocations.push(budget);
    const out = capture();
    const save = vi.spyOn(budget, 'saveContinuation');
    let delivered!: () => void;
    const allDelivered = new Promise<void>((resolve) => (delivered = resolve));
    const result = followJobs({
      start: {
        kind: 'jobs',
        jobIds: ['live-job'],
        ...(fresh ? {} : { serializedCursor: serializeWaitCursor(cursor) }),
      },
      reconnectPolicy: 'bounded',
      invocation: budget,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect: async ({ signal }) => {
        return {
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield event;
              delivered();
              await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            },
          },
        };
      },
    });
    return { budget, out, result, allDelivered, save };
  }
  const cursor = savedCursor({ 'live-job': 7 });
  describe('CLI watchdog flush (server waiting event arrives after the 590 s CLI deadline)', () => {
    it('clears omitted coverage on a server waiting event', async () => {
      const r = run([
        {
          type: 'progress',
          jobId: 'live-job',
          seq: 7,
          message: 'working',
          timing: {
            origin: 'runtime',
            originAt: '2026-10-04T00:00:00.000Z',
            emittedAt: '2026-10-04T00:00:01.000Z',
            elapsedMs: 1000,
          },
          entry: cursor.jobs[0],
        },
        { type: 'waiting', waitingJobIds: ['live-job'], cursor, exitCode: 75 },
      ]);
      await r.result;
      expect(r.save).toHaveBeenLastCalledWith(expect.any(String), true, true, 75);
      r.budget.stop();
      expect(r.out()).not.toContain('Carrier unconfirmed');
      expect(r.save.mock.calls.at(-1)?.[0]).not.toContain('Carrier unconfirmed');
    });
    it('saves a cursorless silent subscription before timeout or SIGINT', async () => {
      const r = run([], true);
      await r.allDelivered;
      r.budget.stop();
      expect(await r.result).toBe(75);
      expect(r.out()).toContain('Still waiting on 1 job. Run coral-cli wait jobs live-job to continue waiting.');
      expect(r.out()).not.toContain('--cursor');
      expect(r.out()).toContain('Carrier unconfirmed for: live-job.');
      expect(r.out()).not.toContain('admission did not complete');
    });
    it('preserves the input cursor for an admitted silent job', async () => {
      const r = run([]);
      await r.allDelivered;
      expect(r.save).toHaveBeenCalledOnce();
      r.budget.stop();
      await r.result;
      expect(r.out()).not.toContain('admission did not complete');
      expect(r.out()).toContain(
        `Still waiting on 1 job. Run coral-cli wait jobs live-job --cursor ${serializeWaitCursor(cursor)}`,
      );
      expect(r.out()).toContain(`(cursor: ${serializeWaitCursor(cursor)})`);
    });
  });
  it('prints one continuation when the watchdog fires after bytes were written but before their callback', async () => {
    const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'live-job']);
    invocations.push(budget);
    let stdout = '';
    let delivered: (() => void) | undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      cb?: (error?: Error | null) => void,
    ) => {
      const text = chunk.toString();
      stdout += text;
      if (text.startsWith('Still waiting')) {
        delivered = () => cb?.();
        budget.stop();
      } else {
        delivered?.();
        delivered = undefined;
        cb?.();
      }
      return true;
    }) as typeof process.stdout.write);
    const result = await followJobs({
      start: { kind: 'jobs', jobIds: ['live-job'] },
      reconnectPolicy: 'bounded',
      invocation: budget,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect: async () => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'waiting', waitingJobIds: ['live-job'], cursor, exitCode: 75 };
          },
        },
      }),
    });
    expect(result).toBe(75);
    expect(stdout.match(/Still waiting/g)).toHaveLength(1);
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
  it('does not open a server wait when less than one second of CLI budget remains', async () => {
    const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'live-job']);
    invocations.push(budget);
    capture();
    vi.spyOn(budget, 'remainingMs').mockReturnValue(900);
    const connect = vi.fn(async () => {
      budget.stop();
      return { kind: 'fatal-error' as const, error: new Error('refused') };
    });
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['live-job'] },
      invocation: budget,
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: () => {},
      connect,
    });
    expect(code).toBe(75);
    expect(connect).not.toHaveBeenCalled();
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
      expect(
        events.some(
          (event) =>
            (
              event as {
                type: string;
              }
            ).type === 'waiting',
        ),
      ).toBe(true);
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
  const cursor = (positioned: boolean) => (positioned ? savedCursor({ 'job-1': 7 }) : { jobs: [] });

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
                  entry: cursor(true).jobs[0],
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

  it.each(['scope-mismatch', 'missing', 'unreadable'] as const)(
    'launch-and-follow of a job refused as %s exits with the refusal, never as success',
    async (disposition) => {
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        c: string | Uint8Array,
        cb?: (e?: Error | null) => void,
      ) => {
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
                request: { jobIds: [...jobIds], cursor: cursor ?? { jobs: [] }, drainProgress, timeoutSeconds },
                time: new VirtualTime(),
                read: () => [{ jobId: 'job-w', disposition, message: 'refused' }],
                visit: () => ({ kind: 'unreadable', disposition: 'transient-unknown' }),
              }))
                yield JSON.parse(JSON.stringify(event)) as unknown;
            },
          },
        }),
      });
      expect(out).toContain(`Job job-w: ${disposition}`);
      expect(code).toBe(1);
    },
  );
}

it('separates TTY notice and disposition lines with trailing newlines', async () => {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(chunk.toString());
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    expect(
      await followJobs({
        start: { kind: 'jobs', jobIds: ['a'] },
        reconnectPolicy: 'bounded',
        projectRoot: '/project',
        render: { isTTY: true, columns: 80, embed: false, verbose: false },
        emitError: vi.fn(),
        connect: async () => ({
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              yield { type: 'notice', message: 'notice text' };
              yield { type: 'disposition', jobId: 'a', disposition: 'missing' };
              yield {
                type: 'waiting',
                waitingJobIds: [],
                cursor: { jobs: [] },
                exitCode: 1,
              };
            },
          },
        }),
      }),
    ).toBe(1);
    for (const fragment of writes.filter((text) => /notice text|Job a: missing/.test(text)))
      expect(fragment.endsWith('\n')).toBe(true);
    expect(writes.filter((text) => /notice text|Job a: missing/.test(text))).toHaveLength(2);
  } finally {
    vi.restoreAllMocks();
  }
});

it('leaves a stop that is still in progress on a second SIGINT with exit 75', async () => {
  let sigint: (() => void) | undefined;
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    if (event === 'SIGINT') sigint = listener;
    return process;
  }) as typeof process.on);
  vi.spyOn(process, 'off').mockImplementation((() => process) as typeof process.off);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((_c: unknown, cb?: () => void) => {
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
  } finally {
    vi.restoreAllMocks();
  }
});

import { BackendUnreachableError } from '#src/infra/http-errors.js';

it('preserves the saved cursor in backend-unreachable remediation', async () => {
  const cursor = serializeWaitCursor(savedCursor({ a: 42 }));
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

it('trims a saved cursor to the remaining jobs before connecting a subset wait', async () => {
  const cursor = savedCursor({ a: 4, b: 9 });
  const connect = vi.fn(async () => ({
    kind: 'delegated' as const,
    version: '9.9.9',
    outcome: { kind: 'handoff-exit' as const, version: '9.9.9', exitCode: 75 },
  }));
  try {
    await followJobs({
      start: { kind: 'jobs', jobIds: ['a'], serializedCursor: serializeWaitCursor(cursor) },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: vi.fn(),
      connect,
    });
    expect((connect.mock.calls as unknown as Array<[{ cursor: unknown }]>)[0][0].cursor).toEqual(savedCursor({ a: 4 }));
  } finally {
    vi.restoreAllMocks();
  }
});

import { BackendToolHttpError } from '#src/transport/http/errors.js';

it.each([1, 42])('preserves exit %s when a handover follows the final event', async (exitCode) => {
  vi.spyOn(process.stdout, 'write').mockImplementation(((_text: unknown, callback?: () => void) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const empty = { jobs: [] };
  try {
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['job'] },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: vi.fn(),
      connect: async () => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'disposition',
              disposition: 'missing',
              jobId: 'job',
              message: 'Job is missing',
            };
            yield { type: 'waiting', waitingJobIds: [], cursor: empty, exitCode };
            yield { type: 'handover' };
          },
        },
      }),
    });
    expect(code).toBe(exitCode);
  } finally {
    vi.restoreAllMocks();
  }
});

it('resets a cursor rejected mid-stream and completes the reconnect', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: unknown, callback?: () => void) => {
    output += String(text);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  const cursor = savedCursor({ job: 1 });
  const emitError = vi.fn();
  const cursors: unknown[] = [];
  try {
    const code = await followJobs({
      start: { kind: 'jobs', jobIds: ['job'], serializedCursor: serializeWaitCursor(cursor) },
      reconnectPolicy: 'bounded',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect: async (request) => {
        cursors.push(request.cursor);
        expect(cursors.length).toBeLessThanOrEqual(2);
        const first = cursors.length === 1;
        return {
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              if (first) throw new BackendToolHttpError('cursor rejected', 400, { code: 'wait_cursor_malformed' });
              yield {
                type: 'waiting',
                waitingJobIds: [],
                cursor: { jobs: [] },
                exitCode: 0,
              };
            },
          },
        };
      },
    });
    expect(code).toBe(0);
    expect(cursors).toHaveLength(2);
    expect(cursors[1]).toBeUndefined();
    expect(emitError).not.toHaveBeenCalled();
    expect(output).toContain('saved cursor not accepted');
  } finally {
    vi.restoreAllMocks();
  }
});

it('launch-and-follow prints a continuation for an accepted outcome awaiting its artifact', async () => {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: unknown, callback?: () => void) => {
    output += String(text);
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await followJobs({
      start: {
        kind: 'launch',
        launchResult: { kind: 'provider-session', launchState: 'running', jobId: 'job', sessionId: 's' },
      },
      reconnectPolicy: 'until-terminal',
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError: vi.fn(),
      connect: async () => ({
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'terminal',
              jobId: 'job',
              seq: 2,
              result: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
              availability: { kind: 'pending' },
              remainingJobIds: ['job'],
              cursor: { jobs: [{ hash: waitJobHash('job'), seq: 2 }] },
              exitCode: 75,
            };
          },
        },
      }),
    });
    expect(code).toBe(0);
    expect(output).toContain('coral-cli wait jobs job --cursor');
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([0, 42])(
  'preserves delivered terminal exit %s when the watchdog fires in the final write',
  async (exitCode) => {
    const invocation = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'job']);
    vi.spyOn(process.stdout, 'write').mockImplementation(((text: unknown, callback?: () => void) => {
      if (String(text) !== '') invocation.stop();
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await followJobs({
        start: { kind: 'jobs', jobIds: ['job'] },
        reconnectPolicy: 'bounded',
        invocation,
        projectRoot: '/project',
        render: { isTTY: false, columns: 80, embed: false, verbose: false },
        emitError: vi.fn(),
        connect: async () => ({
          kind: 'subscription',
          subscription: {
            close: async () => {},
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'waiting',
                waitingJobIds: [],
                cursor: { jobs: [] },
                exitCode,
              };
            },
          },
        }),
      });
      expect(invocation.signal.aborted).toBe(true);
      expect(code).toBe(exitCode);
    } finally {
      invocation.dispose(true);
      vi.restoreAllMocks();
    }
  },
);
