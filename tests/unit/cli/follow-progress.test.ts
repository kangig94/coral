import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { afterEach, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';

const invocations: WaitInvocation[] = [];
afterEach(() => {
  for (const i of invocations.splice(0)) i.dispose(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('fresh bounded wait renders every line of a multi-line progress message', async () => {
  vi.useFakeTimers();
  // Running job, 3 progress events, the middle one multi-line; fewer than 20 lines, so no tail notice.
  const job = admitted(
    'a',
    [
      [1, 'alpha'],
      [2, 'beta-1\nbeta-2\nbeta-3'],
      [3, 'gamma'],
      [4, 'delta'],
    ],
    false,
  );
  const events: WaitStreamEvent[] = [];
  for await (const e of readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
    time: new VirtualTime(),
    activeEpochKey: 'epoch-E',
    read: observeWaitRead(() => [job]),
    visit: testProgressVisit,
  }))
    events.push(e);

  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array, cb?: (e?: Error | null) => void) => {
    out += c.toString();
    cb?.();
    return true;
  }) as never);
  const budget = new WaitInvocation('bounded', ['node', 'coral-cli', 'wait', 'jobs', 'a']);
  invocations.push(budget);
  const code = await followJobs({
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
          yield* events;
        },
      },
    }),
  });
  expect(code).toBe(75);
  vi.restoreAllMocks();

  for (const line of ['alpha', 'beta-1', 'beta-2', 'beta-3', 'gamma', 'delta']) expect(out).toContain(line);
});
