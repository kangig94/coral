import { afterEach, describe, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { waitEpochToken, waitJobHash, serializeWaitCursor } from '#src/jobs/wait/cursor.js';

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

function run(events: unknown[]) {
  const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'live-job']);
  invocations.push(budget);
  const out = capture();
  const save = vi.spyOn(budget, 'saveContinuation');
  let delivered!: () => void;
  const allDelivered = new Promise<void>((resolve) => (delivered = resolve));
  const result = followJobs({
    start: { kind: 'jobs', jobIds: ['live-job'], serializedCursor: serializeWaitCursor(cursor) },
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

const cursor = {
  version: 'jobs.wait.v3' as const,
  epochs: [{ token: waitEpochToken('epoch'), watermark: 7, lineOffset: 0 }],
  jobs: [{ hash: waitJobHash('live-job'), epoch: 0, flags: 0 }],
};

describe('CLI watchdog flush (server waiting event arrives after the 590 s CLI deadline)', () => {
  it('clears omitted coverage on a server waiting event', async () => {
    const r = run([
      {
        type: 'progress',
        version: 'jobs.wait.v3',
        jobId: 'live-job',
        seq: 7,
        message: 'working',
        timing: {
          origin: 'runtime',
          originAt: '2026-10-04T00:00:00.000Z',
          emittedAt: '2026-10-04T00:00:01.000Z',
          elapsedMs: 1000,
        },
        epochKey: 'epoch',
        cursor,
      },
      { type: 'waiting', version: 'jobs.wait.v3', waitingJobIds: ['live-job'], cursor, exitCode: 75 },
    ]);
    await r.result;
    await new Promise((resolve) => setTimeout(resolve, 20));
    r.budget.stop();

    expect(r.out()).not.toContain('Carrier unconfirmed');
    expect(r.save.mock.calls.at(-1)?.[0]).not.toContain('Carrier unconfirmed');
  });
  it('preserves the input cursor for an admitted silent job', async () => {
    const r = run([]);
    await r.allDelivered;
    await new Promise((resolve) => setTimeout(resolve, 20));
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
          yield { type: 'waiting', version: 'jobs.wait.v3', waitingJobIds: ['live-job'], cursor, exitCode: 75 };
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
