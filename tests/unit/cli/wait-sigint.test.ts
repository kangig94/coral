import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation, waitInvocationMode } from '#src/cli/wait-invocation.js';
import { serializeWaitCursor } from '#src/jobs/wait.js';
import { IpcRequestTimeout } from '#src/transport/ipc/client.js';
import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait-cursor.js';

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

it.each(['opening', 'silent', 'backoff', 'close', 'iterator-return'])(
  'one watchdog bounds %s without advancing late delivery',
  async (stall) => {
    vi.useFakeTimers();
    const stdout = capture();
    const budget = invocation();
    const abortJobs = vi.fn();
    let finishLate!: (value: IteratorResult<unknown>) => void;
    const stuck = new Promise<never>(() => {});
    const frontier = { version: 'jobs.wait.v2' as const, positions: { e: 42 }, locations: { a: 'e' } };
    const subscription = {
      close: vi.fn(() => (stall === 'close' ? stuck : Promise.resolve())),
      [Symbol.asyncIterator]: () => {
        let first = true;
        return {
          next: () => {
            if (first && ['close', 'iterator-return'].includes(stall)) {
              first = false;
              return Promise.resolve({
                done: false as const,
                value: { type: 'waiting', waitingJobIds: ['a'], cursor: frontier, carrierUnknownJobIds: ['a'] },
              });
            }
            return new Promise<IteratorResult<unknown>>((resolve) => {
              finishLate = resolve;
            });
          },
          return: () =>
            stall === 'iterator-return' ? stuck : Promise.resolve({ done: true as const, value: undefined }),
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
      abortJobs,
      connect: () =>
        stall === 'opening'
          ? stuck
          : stall === 'backoff'
            ? Promise.reject(new IpcRequestTimeout('timeout'))
            : Promise.resolve({ kind: 'subscription', subscription }),
      backoffScheduler: () => stuck,
    });
    await vi.advanceTimersByTimeAsync(590_000);
    expect(await code).toBe(75);
    expect(abortJobs).not.toHaveBeenCalled();
    const frozen = stdout();
    expect(frozen.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
    if (stall === 'close' || stall === 'iterator-return') {
      expect(frozen).toContain(`--cursor ${serializeWaitCursor(frontier)}`);
      expect(frozen).not.toContain('ghost');
      expect(frozen).toContain('Carrier unconfirmed for: a');
    } else {
      expect(frozen).toContain('admission did not complete');
      expect(frozen).toContain('Run coral-cli wait jobs a ghost --cursor opaque');
    }
    finishLate?.({ done: false, value: { type: 'waiting', waitingJobIds: ['late'] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(stdout()).toBe(frozen);
  },
);

it('two SIGINTs end a monitor without calling abort', async () => {
  capture();
  const budget = invocation();
  const abortJobs = vi.fn();
  const code = followJobs({
    start: { kind: 'jobs', jobIds: ['a'] },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    abortJobs,
    connect: () => new Promise<never>(() => {}),
  });
  process.emit('SIGINT');
  process.emit('SIGINT');
  expect(await code).toBe(75);
  expect(abortJobs).not.toHaveBeenCalled();
});

it('a stdout drain cannot outlive the invocation or advance an undelivered cursor', async () => {
  vi.useFakeTimers();
  const budget = invocation();
  const callbacks: Array<() => void> = [];
  let stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
    if (chunk.toString().includes('admission did not complete')) stdout += chunk.toString();
    if (callback) callbacks.push(callback);
    return false;
  }) as typeof process.stdout.write);
  const code = followJobs({
    start: { kind: 'jobs', jobIds: ['a'] },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect: async () => ({
      kind: 'subscription',
      subscription: {
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'waiting', waitingJobIds: ['a'] };
        },
      },
    }),
  });
  await vi.advanceTimersByTimeAsync(590_000);
  expect(await code).toBe(75);
  expect(stdout).toContain('Run coral-cli wait jobs a ghost --cursor opaque');
  for (const callback of callbacks) callback();
  expect(stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
});

it('freezes observed carrier absence without labeling it unconfirmed', async () => {
  vi.useFakeTimers();
  const stdout = capture();
  const budget = invocation();
  const code = followJobs({
    start: { kind: 'jobs', jobIds: ['a'] },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect: async () => ({
      kind: 'subscription',
      subscription: {
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'interrupted',
            jobId: 'a',
            storedPhase: 'running',
            observedMaxJournalSeq: 42,
            remainingJobIds: ['a'],
            observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
            continuity: 'unavailable',
            outcome: 'unknown',
            cursor: { version: 'jobs.wait.v2', locations: { a: 'e' }, positions: { e: 42 } },
          };
          await new Promise<never>(() => {});
        },
      },
    }),
  });
  await vi.advanceTimersByTimeAsync(590_000);
  expect(await code).toBe(75);
  expect(stdout()).toContain('carrier is no longer present');
  expect(stdout()).not.toContain('Carrier unconfirmed');
  expect(stdout()).toContain('Still waiting on 1 job');
});

it('resets acknowledgements when negotiation requires a fresh request', async () => {
  const stdout = capture();
  const budget = invocation();
  const oldCursor = {
    version: 'jobs.wait.v2' as const,
    positions: { e: 42 },
    locations: { a: 'e' },
    deliveredJobIds: ['a'],
  };
  const code = await followJobs({
    start: { kind: 'jobs', jobIds: ['a'], serializedCursor: serializeWaitCursor(oldCursor) },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect: async ({ onCursorReset }) => {
      onCursorReset();
      return {
        kind: 'subscription',
        subscription: {
          close: async () => {},
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'terminal',
              jobId: 'a',
              seq: 1,
              remainingJobIds: [],
              resultPath: '/result.md',
              result: { content: 'result', durationMs: 1, outcome: { kind: 'completed' } },
            };
          },
        },
      };
    },
  });
  expect(code).toBe(0);
  expect(stdout()).toMatch(new RegExp(`^${WAIT_CURSOR_REPLAY_NOTICE}`));
  expect(stdout()).toContain('Job a completed');
});

it('unknown saved generations replay from the start with a notice before output', async () => {
  const stdout = capture();
  const budget = invocation();
  const connect = vi.fn(async () => ({
    kind: 'subscription' as const,
    subscription: {
      close: async () => {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'waiting', waitingJobIds: ['a'] };
      },
    },
  }));
  await followJobs({
    start: {
      kind: 'jobs',
      jobIds: ['a'],
      serializedCursor: Buffer.from(JSON.stringify({ version: 'jobs.wait.future', afterSeq: 42 })).toString(
        'base64url',
      ),
    },
    reconnectPolicy: 'bounded',
    invocation: budget,
    projectRoot: '/project',
    render: { isTTY: false, columns: 80, embed: false, verbose: false },
    emitError: vi.fn(),
    connect,
  });
  expect(connect.mock.calls[0]).not.toBeUndefined();
  expect(connect).toHaveBeenCalledWith(expect.not.objectContaining({ cursor: expect.anything() }));
  expect(stdout().startsWith(`${WAIT_CURSOR_REPLAY_NOTICE}\n`)).toBe(true);
});

it.each([
  [['wait', 'jobs', 'a'], 'bounded'],
  [['wait', 'jobs', '--cursor=saved', '--embed', 'a', 'b'], 'bounded'],
  [['wait', 'jobs', '--', 'a', '--help'], 'bounded'],
  [['wait', 'jobs', '--now', 'a'], 'snapshot'],
  [['wait', 'jobs', 'a', '--help'], undefined],
  [['wait', '--help'], undefined],
  [['help', 'wait', 'jobs'], undefined],
  [['jobs', 'detail', 'a'], undefined],
  [['wait', 'jobs', '--invalid', 'a'], undefined],
  [['wait', 'jobs', '--cursor'], undefined],
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
