import { afterEach, describe, expect, it, vi } from 'vitest';
import { followJobs } from '#src/cli/follow.js';
import { WaitInvocation } from '#src/cli/wait-invocation.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const invocations: WaitInvocation[] = [];
afterEach(() => {
  for (const invocation of invocations.splice(0)) invocation.dispose(true);
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('all-refused v3 bounded wait', () => {
  it('prints a settled line without a cursor when its only job is missing', async () => {
    const runtime = new SimulationRuntime();
    const index = new JobLocationIndex(runtime, '/coral');
    const addressing = new JobAddressing(
      index.readOnlyView(),
      {
        epochKey: () => 'epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      () => 'pending',
    );
    const events: unknown[] = [];
    for await (const event of addressing.waitStream({ jobIds: ['ghost'], supportsWaitV3: true, timeoutSeconds: 5 }))
      events.push(event);

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

    expect(events.some((event) => (event as { type: string }).type === 'waiting')).toBe(false);
    expect(code).toBe(1);
    expect(stdout).toContain('Wait complete; no jobs remain.');
    expect(stdout).not.toContain('cursor:');
    expect(stdout).not.toContain('Still waiting');
  });
});
