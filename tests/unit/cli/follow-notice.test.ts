import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { afterEach, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

const invocations: WaitInvocation[] = [];
afterEach(() => {
  for (const i of invocations.splice(0)) i.dispose(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function capture() {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
    out += c.toString();
    cb?.();
    return true;
  }) as never);
  return () => out;
}

async function firstPollEvents(): Promise<WaitStreamEvent[]> {
  // A real running job with 30 progress lines: the first bounded poll emits the tail notice.
  const job = admitted(
    'a',
    Array.from({ length: 30 }, (_, i) => [i + 1, `line-${i + 1}`]),
    false,
  );
  const events: WaitStreamEvent[] = [];
  for await (const e of readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 0 },
    activeEpochKey: TEST_EPOCH,
    time: new VirtualTime(),
    read: observeWaitRead(() => [job]),
    visit: testProgressVisit,
  }))
    events.push(e);
  return events.filter((e) => e.type !== 'waiting');
}

it('SIGINT after a delivered informational notice still ends the bounded wait', async () => {
  const events = await firstPollEvents();
  const frame = events.find((e) => e.type === 'cursor')!;
  const notice = events.find((e) => e.type === 'notice')!;
  const progress = events.find((e) => e.type === 'progress')!;

  vi.useFakeTimers();
  const stdout = capture();
  const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  invocations.push(budget);
  let release!: () => void;
  const result = followJobs({
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
          yield frame;
          yield notice;
          yield progress;
          await new Promise<void>((r) => {
            release = r;
          }); // coordinator goes silent
        },
      },
    }),
  });
  let settled: number | undefined;
  void result.then((code) => {
    settled = code;
  });
  await vi.advanceTimersByTimeAsync(50);
  process.emit('SIGINT');
  await vi.advanceTimersByTimeAsync(50);

  expect(settled).toBe(75);

  release?.();
  expect(budget.signal.aborted).toBe(true);
  expect(await result).toBe(75);
  expect(settled).toBe(75);
  expect(stdout()).toContain('coral-cli wait jobs a');
  expect(stdout()).toMatch(/--cursor [A-Za-z0-9_-]+/);
});
