import { savedCursor } from '#tests/helpers/wait-session.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation, waitInvocationMode } from '#src/cli/wait-invocation.js';
import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';

const invocations: WaitInvocation[] = [];
afterEach(() => {
  for (const invocation of invocations.splice(0)) invocation.dispose(true);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function invocation(): WaitInvocation {
  const budget = new WaitInvocation('bounded', [
    'node',
    'coral-cli',
    'wait',
    'jobs',
    'a',
    'ghost',
    '--cursor',
    'opaque',
  ]);
  invocations.push(budget);
  return budget;
}

function capture(): () => string {
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    stdout += chunk.toString();
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  return () => stdout;
}

it('returns transient remediation with the unchanged command on a failed stream write', async () => {
  const budget = invocation();
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error) => void) => {
    callback?.(new Error('write failed'));
    return false;
  }) as never);
  const errors: unknown[] = [];
  const result = followJobs({
    start: { kind: 'jobs', jobIds: ['a'] },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: (error) => {
      errors.push(error);
    },
    connect: async () => ({
      kind: 'subscription',
      subscription: {
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'waiting', waitingJobIds: ['a'], cursor: null, exitCode: 75 };
        },
      },
    }),
  });
  const outcome = await result.catch((error: unknown) => {
    errors.push(error);
    return buildErrorEnvelope(error).exitCode;
  });
  expect(outcome).toBe(75);
  expect(errors.map(buildErrorEnvelope)).toContainEqual(
    expect.objectContaining({
      envelope: expect.objectContaining({ code: 'transient', remediation: `Run ${budget.originalCommand}` }),
    }),
  );
});

it.each([
  ['bounded', 590_000, 10_000],
  ['snapshot', 30_000, 1_000],
] as const)(
  '%s uses monotonic time and keeps its hard backstop after cancellation',
  async (mode, budgetMs, cleanupMs) => {
    vi.useFakeTimers();
    capture();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const budget = new WaitInvocation(mode, ['node', 'coral-cli', 'wait', 'jobs', 'a']);
    invocations.push(budget);
    const before = budget.remainingMs();
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(budget.remainingMs()).toBeGreaterThan(before - 100);
    await vi.advanceTimersByTimeAsync(budgetMs);
    expect(budget.signal.aborted).toBe(true);
    budget.dispose();
    await vi.advanceTimersByTimeAsync(cleanupMs);
    expect(exit).toHaveBeenCalledExactlyOnceWith(75);
  },
);

it.each(['opening', 'silent', 'close'])('one watchdog bounds %s without advancing late delivery', async (stall) => {
  vi.useFakeTimers();
  const stdout = capture();
  const budget = invocation();
  let finishLate!: (value: IteratorResult<unknown>) => void;
  const stuck = new Promise<never>(() => {});
  const frontier = savedCursor(42);
  const subscription = {
    close: vi.fn(() => (stall === 'close' ? stuck : Promise.resolve())),
    [Symbol.asyncIterator]: () => {
      let first = true;
      return {
        next: () => {
          if (first && stall === 'close') {
            first = false;
            return Promise.resolve({
              done: false as const,
              value: {
                type: 'waiting',
                waitingJobIds: ['a'],
                cursor: frontier,
                carrierUnknownJobIds: ['a'],
                exitCode: 75,
              },
            });
          }
          return new Promise<IteratorResult<unknown>>((resolve) => {
            finishLate = resolve;
          });
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      };
    },
  };
  const code = followJobs({
    start: { kind: 'jobs', jobIds: ['a', 'ghost'] },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect: () => (stall === 'opening' ? stuck : Promise.resolve({ kind: 'subscription', subscription })),
  });
  await vi.advanceTimersByTimeAsync(590_000);
  expect(await code).toBe(75);
  const frozen = stdout();
  expect(frozen.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  if (stall === 'close') {
    expect(frozen).toContain(`--cursor ${frontier}`);
    expect(frozen).not.toContain('ghost');
    expect(frozen).toContain('Carrier unconfirmed for: a');
  } else if (stall === 'silent') {
    expect(frozen).toContain('Still waiting on 2 jobs');
    expect(frozen).not.toContain('--cursor');
    expect(frozen).toContain('Carrier unconfirmed for: a, ghost.');
  } else {
    expect(frozen).toContain('admission did not complete');
    expect(frozen).toContain('Run coral-cli wait jobs a ghost --cursor opaque');
  }
  finishLate?.({ done: false, value: { type: 'waiting', waitingJobIds: ['late'] } });
  await Promise.resolve();
  await Promise.resolve();
  expect(stdout()).toBe(frozen);
});

it('a saved cursor from an older build is refused softly and the collection restarts fresh with the replay notice', async () => {
  const token = Buffer.from(
    JSON.stringify({ version: 'jobs.wait.v2', positions: { e: 42 }, locations: { a: 'e' } }),
  ).toString('base64url');
  const stdout = capture();
  const budget = invocation();
  const connect = vi.fn(async () => ({
    kind: 'subscription' as const,
    subscription: {
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'waiting', waitingJobIds: ['a'], cursor: savedCursor(50), exitCode: 75 };
      },
    },
  }));
  await followJobs({
    start: { kind: 'jobs', jobIds: ['a'], serializedCursor: token },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect,
  });
  expect(connect).toHaveBeenCalledWith(expect.not.objectContaining({ cursor: expect.anything() }));
  expect(stdout().startsWith(`${WAIT_CURSOR_REPLAY_NOTICE}\n`)).toBe(true);
  expect(stdout()).toContain(`--cursor ${savedCursor(50)}`);
});

it.each([
  [['wait', 'jobs', '--cursor=saved', '--embed', 'a', 'b'], 'bounded'],
  [['wait', 'jobs', '--now', 'a'], 'snapshot'],
  [['wait', 'jobs', 'a', '--help'], undefined],
  [['jobs', 'detail', 'a'], undefined],
] as const)('recognizes accepted invocation syntax before preflight: %j', (args, mode) => {
  const program = new Command();
  program
    .command('wait')
    .command('jobs')
    .argument('<ids...>')
    .option('--cursor <cursor>')
    .option('--embed')
    .option('--now');
  expect(waitInvocationMode(program, ['node', 'coral-cli', ...args])).toBe(mode);
});

it('keeps a failed terminal exit when the budget ends while that final event is still being written', async () => {
  const budget = invocation();
  let output = '';
  const callbacks: Array<() => void> = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string, callback?: () => void) => {
    output += text;
    // A pipe completes writes in order and later; the budget ends inside the terminal's write.
    callbacks.push(() => callback?.());
    if (text.startsWith('Job a provider exited')) budget.stop();
    return true;
  }) as never);
  const ended = followJobs({
    start: { kind: 'jobs', jobIds: ['a'] },
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
          yield {
            type: 'terminal',
            jobId: 'a',
            seq: 9,
            remainingJobIds: [],
            availability: { kind: 'pending' },
            result: { content: 'boom', outcome: { kind: 'provider_exit', code: 3 }, durationMs: 1 },
            cursor: null,
            exitCode: 3,
          };
        },
      },
    }),
  });
  // The command stores whatever the follow returns, before the pending write lands.
  process.exitCode = await ended;
  for (const callback of callbacks.splice(0)) callback();
  for (const callback of callbacks.splice(0)) callback();
  expect(output.match(/Job a provider exited 3/g)).toHaveLength(1);
  expect(output).not.toContain('Still waiting');
  expect(process.exitCode).toBe(3);
});

it('terminates a repeated cursor-reset refusal after retrying without the cursor once', async () => {
  capture();
  const budget = invocation();
  const error = new Error('bad cursor', { cause: { code: 'wait_cursor_malformed', message: 'bad cursor' } });
  const connect = vi.fn(async () => {
    if (connect.mock.calls.length > 3) throw new Error('cursor reset did not converge');
    throw error;
  });
  const emitError = vi.fn();
  expect(
    await followJobs({
      start: { kind: 'jobs', jobIds: ['a'], serializedCursor: savedCursor(7) },
      reconnectPolicy: 'bounded',
      invocation: budget,
      projectRoot: '/project',
      render: { isTTY: false, columns: 80, embed: false, verbose: false },
      emitError,
      connect,
    }),
  ).toBe(1);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(emitError).toHaveBeenCalledOnce();
});
